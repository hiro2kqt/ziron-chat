/**
 * Email Classifier
 * Decides whether a university email matters to an MSc Data Science student
 * at TU Dortmund and writes a short English summary for the notification.
 */

import { chat } from '../../../providers/openrouter.js';
import { loadConfig } from '../../../config/index.js';
import logger from '../../../utils/logger.js';

export const CATEGORIES = ['registration', 'exam', 'assignment', 'deadline', 'course', 'announcement', 'other'];

// Module catalogue of the MSc Data Science (ModHb_MSc_DaSc_2023_01).
// Course mails often only carry an LSF/Moodle short code (lsf-ASL-26_1 ...).
const PROGRAM_MODULES = `
Compulsory: Advanced Statistical Learning (ASL), Statistical Theory (ST), Data Science in Practice
(Programming course, Data Science in Context), Project Work (Case Studies / Fallstudien, External
Internship, Seminar), Big Data (Statistical Learning for Big Data, SLFBD), Master Thesis (+ Advanced Seminar).
Methods electives: Time Series Analysis, Survival Analysis, Bootstrapping, Stichprobenverfahren,
Nonparametric Methods, Robust Methods, Optimization, Numerical Solution of Differential Equations,
Generalized Linear Models (GLM), Computational Fluid Dynamics, Computational Intelligence, Database
Systems, Cyber-Physical Systems, Real-Time Systems, Model Selection and Model Averaging, Asymptotic
Theory, Machine Learning Paradigms for Complex Data, Neural networks for ODEs, Numerical Methods for
PDEs, Artificial Intelligence, Deep Learning, Unit Root and Cointegration, Panel Data Econometrics,
Text as Data, Statistical Network Analysis, Resampling & Simulations, Selected Topics in Data Science,
Advanced Bayesian Data Analysis.
Applications electives: Bioinformatics, Toxicology, Econometrics, Treatment effects / policy evaluation,
Natürlichsprachige Systeme / NLP, Control Theory, Reliability and Material Fatigue, Quality Control,
Financial Econometrics, Machine Learning for Economic Data, Bayesian Econometrics, Statistics in
Toxicology, Statistics in Genetics, Linguistic Data Science, Computational Linguistics, Statistics meets
Linguistics, Research Methods in English Linguistics, Learning in Robotics, Data-Based Dynamic Modeling,
Industrial Data Science, Game Theory.
Bridging requirements: Advanced Mathematics, Data Structures and Programming, Information Systems,
Probability, Inference, Linear Models, Introductory Case Studies, Introduction to Statistical Learning.`;

export const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'email_classification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        important: { type: 'boolean' },
        category: { type: 'string', enum: CATEGORIES },
        summary: { type: 'string' },
        deadline: { type: ['string', 'null'] },
        reason: { type: 'string' },
      },
      required: ['important', 'category', 'summary', 'deadline', 'reason'],
      additionalProperties: false,
    },
  },
};

// Rules agreed with the student (2026-11-17); the eval set in docs §11 follows them.
// Static text first, the email last: the shared prefix is served from the provider's prompt cache.
export function buildPrompt({ from, subject, snippet, date, studentName = '' }) {
  const student = studentName ? `the student (${studentName})` : 'the student';
  return `You triage the university inbox of an MSc Data Science student at TU Dortmund.
Emails may be German or English. ALWAYS write "summary" and "reason" in English.
A false negative (a missed important mail) is much worse than an extra notification: when a mail
plausibly needs the student's attention under the rules below, mark it important.

The student's programme modules:${PROGRAM_MODULES}

IMPORTANT (important = true):
- "registration": registration / enrolment / place allocation for courses, seminars, case studies,
  programming courses, project work, quizzes or exams (Anmeldung, Kursplatz, Platzvergabe, Abmeldung).
  This includes registrations run through a survey or form tool (e.g. "Registration to the programming
  courses" on umfragen.tu-dortmund.de) as long as he still has to fill it in; only the survey tool's
  "your response has been saved" confirmation is "other". Welcome / enrolment mails of a course
  ("Willkommen zu <course>", "You are enrolled in ...") are "course" and important.
- "exam": exam or quiz dates, rooms, allowed resources, results, reviews (Klausur, Prüfung, Einsicht),
  and exam coaching / revision sessions of his courses.
- "assignment": exercise sheets published, updated or corrected, solutions released, homework,
  submission deadlines, due / overdue notices (Übungsblatt, Abgabe).
- "deadline": any other dated action the student must take (fees, re-registration / Rückmeldung,
  forms, documents, visa or enrolment office requests, account changes required by a date).
- "course": anything about one of the programme modules above — lecture changes or cancellations,
  room/time changes, new slides or videos, tutorials, announcements from lecturers or tutors, welcome
  mails; presentations of the seminars / case studies offered for the coming semester; optional extra
  courses or intensive programmes open to MSc Data Science students (tele-courses, Blended Intensive
  Programmes, additional electives). Moodle/LSF course mails (subject "lsf-<CODE>-...", sender
  "... via/über Moodle") belong here unless a more specific category fits.
- "announcement":
  * official programme / examination-office / faculty notices that affect the student;
  * personal replies from university staff or offices (International Office, Study Advisory,
    examination office, lecturers, student registration office) to ${student}'s own inquiries about
    his studies, internship, recognition, visa or documents — even if purely informational;
    use "deadline" instead when they ask him to do something by a date (call today, send a document);
  * student IT systems and accounts: outages or maintenance of Campusportal / LSF / Moodle / SSO /
    university websites, mandatory re-configuration (eduroam), mandatory 2FA — use "deadline" if he
    must act by a date;
  * automated Campusportal / student registration office notices: new document available, student
    status changed, re-registration processed, certificates available.

NOT IMPORTANT (important = false, category "other"):
- Invitations to events, talks, conferences, workshops, colloquia, info sessions, excursions, career or
  company events, festivals, sports, elections, surveys (incl. teaching evaluations), newsletters /
  Infobrief, marketing, vendor mail, social posts — even when sent by the university or the faculty.
- Calls to apply for scholarships, stays abroad or external internship programmes that he did not ask about.
- Moodle forum posts written by other students (questions or discussion in Q&A forums); only posts by
  lecturers or tutors count as "course".
- Mail written by ${student} himself (his own name or address in From, e.g. his replies in a thread).
- Automated confirmations of his own actions or accounts: "submission received" / "Aufgabenlösung
  übermittelt", badges, one-time passcodes, account activation or verification, plan expiry.

Tiebreakers: registration beats every other category; an invitation is "other" unless it is part of a
programme module or one of the optional study offers listed under "course" / "exam" above.

"summary": one sentence (max 30 words) saying what it is and what to do; keep exact dates, times,
rooms and deadlines; name the course. "reason": a few words on why it is (not) important.
"deadline": the next date he must act on or may attend, for important mails only:
- a registration / submission / payment / document deadline;
- an exam, quiz, exam review (Einsicht) or exam coaching;
- a dated course session announced in the mail: Q&A session, moved / extra / cancelled-and-replaced lecture
  or tutorial, presentation of seminars / case studies;
- an appointment or call he is asked to join (office hours "today", a meeting).
Format "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM" (local German time) when a time or start of a time slot is given
("16 pm" = 16:00). Resolve relative dates ("tomorrow", "next Tuesday", "this week", "today") against the
email date. If several dates are given, take the earliest one that is not before the email date.
null for mails that are not important, and when no such date is given.

Email date: ${date ? new Date(date).toISOString().slice(0, 10) : 'unknown'}
From: ${from}
Subject: ${subject}
Content: ${snippet}

Reply with JSON only: {"important": bool, "category": one of ${CATEGORIES.join('/')}, "summary": "...", "deadline": "YYYY-MM-DD[THH:MM]" or null, "reason": "..."}`;
}

function parseResponse(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = content?.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Classify an email
 * @param {{subject: string, from: string, snippet: string}} email
 * @param {{model?: string}} [opts] - override model (used by evals)
 * @returns {Promise<{important: boolean, category: string, summary: string, reason: string}>}
 */
export async function classifyEmail(email, opts = {}) {
  const config = loadConfig();
  const apiKey = config.providers?.openrouter?.apiKey;
  if (!apiKey) {
    throw new Error('OpenRouter API key required for email classification');
  }

  const model = opts.model
    || config.tools?.email?.classifierModel
    || config.providers?.openrouter?.model;

  const prompt = buildPrompt({
    date: email.date,
    from: email.from,
    subject: email.subject,
    snippet: email.snippet?.trim() || '(no content available)',
    studentName: config.user?.name || '',
  });

  const ask = () => chat(prompt, apiKey, {
    model,
    // Reasoning tokens count against max_tokens on reasoning models; 400 cut
    // the JSON off mid-string in ~5% of calls
    maxTokens: 2000,
    temperature: 0,
    responseFormat: RESPONSE_SCHEMA,
    // Short classification task: keep thinking minimal
    reasoning: { effort: 'low', exclude: true },
    timeoutMs: 60000,
  });

  let content = await ask();
  let parsed = parseResponse(content);
  if (!parsed) {
    logger.warn('[Email Classifier] Unparseable response, retrying once');
    content = await ask();
    parsed = parseResponse(content);
  }
  if (!parsed) {
    logger.warn('[Email Classifier] Could not parse response:\n', content);
    // Fail open: a missed exam mail is worse than one extra notification
    return {
      important: true,
      category: 'other',
      summary: `(unclassified) ${email.subject}`,
      deadline: null,
      reason: 'Classifier response could not be parsed',
    };
  }

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
  return {
    important: Boolean(parsed.important),
    category,
    summary: String(parsed.summary || '').trim(),
    // Only keep well-formed dates; anything else is treated as "no deadline"
    deadline: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(parsed.deadline || '')) ? parsed.deadline : null,
    reason: String(parsed.reason || '').trim(),
  };
}

export default { classifyEmail, CATEGORIES };
