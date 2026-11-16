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

export function buildPrompt({ from, subject, snippet, date }) {
  return `You triage the university inbox of an MSc Data Science student at TU Dortmund.
Emails may be German or English. ALWAYS write "summary" and "reason" in English.

The student's programme modules:${PROGRAM_MODULES}

IMPORTANT (important = true):
- "registration": registration / enrolment / place allocation for courses, seminars, case studies,
  programming courses, project work, or exams (Anmeldung, Kursplatz, Platzvergabe, Abmeldung).
- "exam": exam or quiz dates, rooms, allowed resources, results, reviews (Klausur, Prüfung, Einsicht).
- "assignment": exercise sheets, homework, submissions, due / overdue notices (Übungsblatt, Abgabe).
- "deadline": any other dated action the student must take (fees, re-registration / Rückmeldung,
  forms, documents, visa or enrolment office requests).
- "course": anything about one of the programme modules above — lecture changes or cancellations,
  room/time changes, new slides or videos, tutorials, forum posts from lecturers, welcome mails.
  Moodle/LSF course mails (subject "lsf-<CODE>-...", sender "... via/über Moodle") belong here
  unless a more specific category fits.
- "announcement": official programme / examination-office / faculty notices that affect the student.

NOT IMPORTANT (important = false, category "other"):
- Invitations to events, talks, conferences, workshops, colloquia, info sessions, career or
  company events, festivals, sports, surveys, newsletters, marketing, vendor mail, social posts —
  even when sent by the university or the faculty.
- Automated system mail that needs no action.

Tiebreakers: registration beats every other category; an invitation is "other" unless it is a
mandatory part of a programme module.

"summary": one sentence (max 30 words) saying what it is and what to do; keep exact dates, times,
rooms and deadlines; name the course. "reason": a few words on why it is (not) important.
"deadline": when Hiro must act — the registration/submission/payment deadline, or the date of an exam or
mandatory appointment he must attend — as "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local German time) if a time is
given. Resolve relative dates ("next Tuesday", "this week") against the email date. null if there is no such date.

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
