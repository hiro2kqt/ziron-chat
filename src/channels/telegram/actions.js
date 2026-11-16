/**
 * Telegram Pre-defined Actions Module
 * Intercepts callback queries or messages with specific prefixes
 * to perform quick actions without calling the LLM.
 */

import logger from '../../utils/logger.js';
import {
  deleteTodayJobsByRefId,
  getTodayJobById,
  getPendingJobsByRefId,
  deletePendingJobsByRefId,
  insertTodayJob,
} from '../../scheduler/db.js';
import { utcTimeToLocal, formatLocal } from '../../utils/time.js';
import { loadConfig } from '../../config/index.js';
import Email from '../../db/models/Email.js';
import { fetchFullEmail } from '../../tools/providers/email/monitor.js';
import { planDeadlineReminders, formatLocalDay } from '../../tools/providers/email/reminders.js';

const TELEGRAM_CHUNK = 3800; // Telegram max message is 4096 chars
const MAX_FULL_MAIL_CHUNKS = 4;

/** First line of the reminder the button belongs to, for the confirmation */
function reminderText(ctx) {
  const t = ctx.callbackQuery?.message?.text || '';
  const line = t.split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/**
 * Action Registry
 * Maps action names to handler functions
 * @type {Object.<string, Function>}
 */
const ACTION_REGISTRY = {
  /**
   * Show the full text of an email (fetched from IMAP on demand)
   * Format: !act:mail:<uid>
   */
  async mail(ctx, parts) {
    const uid = Number(parts[2]);
    await ctx.answerCallbackQuery({ text: '⏳ Đang tải mail...', show_alert: false });
    const imap = loadConfig().tools?.email?.imap;
    const m = Number.isInteger(uid) && imap ? await fetchFullEmail(imap, uid) : null;
    if (!m) return { text: '❌ Không tải được mail này (có thể đã bị xoá/di chuyển).', keepButtons: true };

    const header = `📄 ${m.subject}\nFrom: ${m.from}\nDate: ${m.date ? formatLocal(m.date) : '?'}`
      + (m.attachments.length ? `\nAttachments: ${m.attachments.join(', ')}` : '');
    const body = `${header}\n\n${m.text || '(no text content)'}`;
    const chunks = [];
    for (let i = 0; i < body.length && chunks.length < MAX_FULL_MAIL_CHUNKS; i += TELEGRAM_CHUNK) {
      chunks.push(body.slice(i, i + TELEGRAM_CHUNK));
    }
    if (body.length > TELEGRAM_CHUNK * MAX_FULL_MAIL_CHUNKS) {
      chunks[chunks.length - 1] += '\n\n… (mail dài, phần còn lại xem trên webmail)';
    }
    // Plain text: mail bodies are full of characters Markdown would choke on
    return { chunks, keepButtons: true };
  },

  /**
   * Add reminders before an email's deadline (3 days, 1 day, day-of)
   * Format: !act:mremind:<uid>
   */
  async mremind(ctx, parts) {
    const uid = Number(parts[2]);
    const email = await Email.findOne({ mailbox: 'INBOX', uid }).lean();
    await ctx.answerCallbackQuery({ text: '⏰ Đang đặt nhắc...', show_alert: false });
    if (!email?.deadline) return { text: '⚠️ Mail này không có hạn chót để nhắc.', keepButtons: true };

    // Deterministic ref_id: tapping twice must not create duplicates, and
    // the "Done" button on the reminders cancels all of them at once
    const refId = `mail-${uid}`;
    const existing = getPendingJobsByRefId(refId);
    if (existing.length) {
      const when = existing.map(j => formatLocalDay(j.date, utcTimeToLocal(j.fire_at, j.date))).join(', ');
      return { text: `ℹ️ Đã có nhắc cho mail này: ${when}.`, keepButtons: true };
    }

    const plan = planDeadlineReminders(email.deadline);
    if (!plan.length) return { text: '⚠️ Hạn đã qua hoặc quá gần, không còn mốc nào để nhắc.', keepButtons: true };

    const deadlineTxt = formatLocalDay(email.deadline.slice(0, 10), email.deadline.slice(11, 16) || '');
    for (const slot of plan) {
      const iso = slot.utc.toISOString();
      insertTodayJob({
        name: `mail-${uid}-deadline`,
        chat_id: String(ctx.chat.id),
        fire_at: iso.slice(11, 16),          // UTC
        date: iso.slice(0, 10),              // UTC date; poller fires it on that day
        message: `⏰ ${slot.label}: ${email.summary || email.subject}`,
        buttons: [[
          { text: '✅ Done', callback_data: `!act:done:${refId}` },
          { text: '💤 +15m', callback_data: '!act:snooze:15:{todayJobId}' },
        ]],
        source: 'oneshot',
        ref_id: refId,
      });
    }
    logger.info(`[Action:mremind] ${plan.length} reminder(s) for mail UID ${uid}, deadline ${email.deadline}`);
    const when = plan.map(sl => formatLocalDay(sl.date, sl.time)).join(', ');
    return { text: `⏰ Đã đặt nhắc cho "${email.subject.slice(0, 60)}" (hạn ${deadlineTxt}): ${when}.`, keepButtons: true };
  },

  /**
   * Done action: delete all today_jobs with this refId
   * Format: done|<refId>
   */
  async done(ctx, parts) {
    const refId = parts.slice(2).join(':');
    const today = new Date().toISOString().split('T')[0];
    // Reminders of this task still pending, on any date (e.g. later deadline
    // reminders) — the task is done, so they all go
    const pending = getPendingJobsByRefId(refId);
    const count = deleteTodayJobsByRefId(refId, today) + deletePendingJobsByRefId(refId);

    await ctx.answerCallbackQuery({ text: '✅ Xong!', show_alert: false });
    logger.info(`[Action:done] Deleted ${count} jobs with refId: ${refId}`);
    const rest = pending.length
      ? `\nĐã tắt ${pending.length} nhắc còn lại (${pending.map(j => (j.date === today ? '' : `${formatLocalDay(j.date)} `) + utcTimeToLocal(j.fire_at, j.date)).join(', ')}).`
      : '';
    return `✅ Đã ghi nhận: ${reminderText(ctx)}${rest}`;
  },

  /**
   * Delete action: delete all master and today_jobs with this refId
   * Format: delete|<refId>
   */
  async delete(ctx, parts) {
    // Cancel button removed: it permanently deleted recurring jobs on one tap.
    // Old messages may still show it, so answer without deleting anything.
    const refId = parts.slice(2).join(':');
    logger.info(`[Action:delete] Ignored legacy Cancel button for refId: ${refId}`);
    await ctx.answerCallbackQuery({
      text: 'Nút Huỷ đã bị bỏ. Muốn xoá lịch thì nhắn bot "hủy <tên lịch>".',
      show_alert: true,
    });
    return null;
  },

  /**
   * Snooze action: create new oneshot job after N minutes
   * Format: snooze|<minutes>|<todayJobId>
   */
  async snooze(ctx, parts) {
    const minutes = parseInt(parts[2], 10);
    const todayJobId = parts[3];

    if (isNaN(minutes) || !todayJobId) {
      await ctx.answerCallbackQuery({ text: '❌ Dữ liệu không hợp lệ', show_alert: false });
      return null;
    }

    // Get the original job
    const originalJob = getTodayJobById(todayJobId);

    if (!originalJob) {
      await ctx.answerCallbackQuery({ text: '❌ Không tìm thấy lịch trình', show_alert: false });
      return null;
    }

    // Calculate new fire time (current time + minutes)
    const now = new Date();
    const fireTime = new Date(now.getTime() + minutes * 60 * 1000);
    const fireAt = `${String(fireTime.getUTCHours()).padStart(2, '0')}:${String(fireTime.getUTCMinutes()).padStart(2, '0')}`;
    // Date of the new fire time (not "today"): a snooze across UTC midnight
    // would otherwise land on today with an earlier time and be dropped
    const fireDate = fireTime.toISOString().slice(0, 10);

    // Create new oneshot job
    insertTodayJob({
      name: originalJob.name,
      chat_id: originalJob.chat_id,
      fire_at: fireAt,
      message: originalJob.message,
      buttons: originalJob.buttons,
      source: 'oneshot',
      date: fireDate,
      enabled: true,
      fired: false,
      ref_id: originalJob.ref_id,
    });

    const localAt = utcTimeToLocal(fireAt, fireDate);
    await ctx.answerCallbackQuery({ text: `⏰ Nhắc lại sau ${minutes}p`, show_alert: false });
    logger.info(`[Action:snooze] Snoozed job ${todayJobId} for ${minutes}m`);
    return `💤 Ok, ${minutes} phút nữa (${localAt}) mình nhắc lại: ${reminderText(ctx)}`;
  },
};

/**
 * Handle incoming callback queries for quick actions.
 * @param {Object} ctx - Telegram context (grammY)
 * @returns {Promise<boolean>} - Returns true if the action was handled and stopped propagation.
 */
export async function handleInlineAction(ctx) {
  // If it's a callback query
  if (ctx.callbackQuery && ctx.callbackQuery.data) {
    const data = ctx.callbackQuery.data;

    // Check for our custom action prefix
    if (data.startsWith('!act:')) {
      const parts = data.split(':');

      // Expected format: !act:<action>:<payload...>
      if (parts.length >= 3) {
        const action = parts[1];

        try {
          // Look up action in registry
          const handler = ACTION_REGISTRY[action];

          if (handler) {
            // Handlers return a confirmation string, or
            // { text | chunks, keepButtons } (email buttons stay usable)
            const result = await handler(ctx, parts);
            const out = typeof result === 'string' ? { text: result } : (result || {});
            const messages = out.chunks || (out.text ? [out.text] : []);

            // Visible reply in the chat (the callback toast disappears in a
            // second), threaded under the message that was tapped
            const msgId = ctx.callbackQuery.message?.message_id;
            for (const text of messages) {
              try {
                await ctx.api.sendMessage(ctx.chat.id, text, msgId
                  ? { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }
                  : {});
              } catch (err) {
                // Older Bot API servers don't know reply_parameters
                logger.debug('[Telegram Actions] Threaded reply failed, sending plain:', err.message);
                await ctx.api.sendMessage(ctx.chat.id, text);
              }
            }

            // Remove inline buttons from the original message (reminders);
            // email notifications keep theirs
            if (!out.keepButtons) {
              try {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
              } catch (err) {
                // Best effort - message might be too old or already edited
                logger.debug('[Telegram Actions] Could not remove buttons:', err.message);
              }
            }
          } else {
            logger.warn(`[Telegram Actions] Unknown action: ${action}`);
            await ctx.answerCallbackQuery({ text: '⚠️ Lệnh không hợp lệ.' });
          }
        } catch (err) {
          logger.error(`[Telegram Actions] Error handling action ${action}:`, err.message);
          await ctx.answerCallbackQuery({ text: '❌ Có lỗi xảy ra khi xử lý.' });
        }

        return true; // We handled it
      }
    }
  }

  // Add more logic here for incoming text messages with prefixes if needed
  if (ctx.message && ctx.message.text) {
    const text = ctx.message.text;
    if (text.startsWith('!act:')) {
      // Handle similarly, though telegram inline buttons usually send callback queries
      return true;
    }
  }

  return false; // Not handled, let it pass to LLM
}

export default { handleInlineAction };
