/**
 * Voice channel — REST + SSE for the browser dashboard (STT -> Ziron -> TTS).
 *
 * POST /api/voice/chat takes either an uploaded audio file (multipart,
 * field "file") or a JSON body `{ text: string }`. The audio path
 * transcribes via voice-service first; the JSON path skips STT entirely.
 * Either way the resulting text is fed to the same handleMessage() used by
 * Telegram (under a fixed channelId so it gets its own session file,
 * completely separate from Telegram's session/history), then synthesized
 * via voice-service and returned as transcript + reply text + audio.
 *
 * GET /api/voice/events is a plain SSE stream that the scheduler pushes
 * "job due" notifications into (see src/scheduler/poller.js), additive to
 * the existing Telegram delivery.
 */

import express from 'express';
import multer from 'multer';
import { handleMessage } from '../../gateway.js';
import { transcribe, synthesize, VoiceServiceError } from '../../services/voiceService.js';
import logger from '../../utils/logger.js';

const VOICE_CHANNEL_ID = 'desk';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB, generous for a few minutes of speech
});

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

/**
 * Push an event to every connected SSE client. No-op if nobody is listening —
 * Telegram still gets the notification regardless, so a dropped browser tab
 * is not an error.
 * @param {Object} event - JSON-serializable payload, e.g. { type: 'reminder', text, audio }
 */
export function broadcastVoiceEvent(event) {
  if (sseClients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (err) {
      logger.warn('[Voice] Failed to write SSE event, dropping client:', err.message);
      sseClients.delete(res);
    }
  }
}

/**
 * Build the Express app for the voice channel.
 * @returns {import('express').Express}
 */
function buildApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/voice/chat', upload.single('file'), async (req, res) => {
    const isTextRequest = !req.file && typeof req.body?.text === 'string';

    if (!req.file && !isTextRequest) {
      return res.status(400).json({ error: 'Missing audio file (field "file") or JSON { text }' });
    }

    // Step 1: STT (audio path) or pass the typed text straight through (text
    // path, skips voice-service entirely). A voice-service error here (422
    // empty transcript, 5xx, etc.) must not reach handleMessage() with
    // garbage input — fail clean instead.
    let transcript;
    if (isTextRequest) {
      transcript = req.body.text;
    } else {
      try {
        const sttResult = await transcribe(req.file.buffer, req.file.originalname, req.file.mimetype);
        transcript = sttResult.text;
      } catch (err) {
        if (err instanceof VoiceServiceError) {
          logger.warn('[Voice] STT rejected audio:', err.message);
          return res.status(err.status === 422 ? 422 : 502).json({ error: err.message });
        }
        logger.error('[Voice] STT request failed:', err.message);
        return res.status(502).json({ error: 'Speech-to-text failed' });
      }
    }

    if (!transcript || transcript.trim() === '') {
      return res.status(422).json({ error: 'Empty transcript' });
    }

    // Step 2: same gateway entry point Telegram uses, but its own channel/session.
    let replyText;
    try {
      replyText = await handleMessage({
        channelType: 'voice',
        channelId: VOICE_CHANNEL_ID,
        userMessage: transcript,
      });
    } catch (err) {
      logger.error('[Voice] handleMessage failed:', err.message);
      return res.status(500).json({ error: 'Failed to generate a response' });
    }

    // Step 3: TTS. If voice-service fails here, still return the text reply —
    // audio is the preferred output for this endpoint, not a hard dependency.
    let audio = null;
    try {
      const { audioBuffer } = await synthesize(replyText);
      audio = audioBuffer.toString('base64');
    } catch (err) {
      logger.error('[Voice] TTS failed, returning text-only reply:', err.message);
    }

    res.json({ transcript, replyText, audio });
  });

  app.get('/api/voice/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n'); // flush headers / open the stream immediately

    sseClients.add(res);
    logger.info(`[Voice] SSE client connected (${sseClients.size} total)`);

    req.on('close', () => {
      sseClients.delete(res);
      logger.info(`[Voice] SSE client disconnected (${sseClients.size} total)`);
    });
  });

  return app;
}

/**
 * Start the voice channel HTTP server.
 * Binds to 0.0.0.0 by default so it's reachable from the Pi over Tailscale,
 * not just localhost — the Pi's reverse proxy forwards browser requests here.
 * @param {Object} [opts]
 * @param {number} [opts.port] - Defaults to env VOICE_PORT, then 7891
 * @param {string} [opts.host] - Defaults to env VOICE_HOST, then '0.0.0.0'
 * @returns {import('http').Server}
 */
export function startVoiceServer(opts = {}) {
  const port = opts.port ?? (Number(process.env.VOICE_PORT) || 7891);
  const host = opts.host ?? process.env.VOICE_HOST ?? '0.0.0.0';

  const app = buildApp();
  const server = app.listen(port, host, () => {
    logger.success(`[Voice] Server listening on ${host}:${port}`);
  });

  server.on('error', (err) => {
    logger.error('[Voice] Server error:', err.message);
  });

  return server;
}

export default { startVoiceServer, broadcastVoiceEvent };
