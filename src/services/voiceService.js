/**
 * voice-service client
 * Talks to the internal Python STT/TTS service (pm2 process "voice-service",
 * http://localhost:8090 by default). Ziron never does STT/TTS itself.
 */

const VOICE_SERVICE_URL = process.env.VOICE_SERVICE_URL || 'http://localhost:8090';

/**
 * Error raised when voice-service rejects or fails a request.
 * `status` carries the upstream HTTP status so callers can map it
 * to a clean response instead of leaking voice-service internals.
 */
export class VoiceServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VoiceServiceError';
    this.status = status;
  }
}

/**
 * Transcribe audio via voice-service's POST /stt.
 * @param {Buffer} audioBuffer
 * @param {string} filename
 * @param {string} mimetype
 * @returns {Promise<{text: string, infer_time: number}>}
 * @throws {VoiceServiceError} on a non-2xx response (e.g. 422 empty transcript, 5xx)
 */
export async function transcribe(audioBuffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimetype || 'audio/wav' }), filename || 'audio.wav');

  let res;
  try {
    res = await fetch(`${VOICE_SERVICE_URL}/stt`, { method: 'POST', body: form });
  } catch (err) {
    throw new VoiceServiceError(`voice-service unreachable: ${err.message}`, 502);
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new VoiceServiceError(`STT failed (${res.status}): ${detail}`, res.status);
  }

  return res.json();
}

/**
 * Synthesize speech via voice-service's POST /tts.
 * @param {string} text
 * @returns {Promise<{audioBuffer: Buffer, synthTime: number|null}>}
 * @throws {VoiceServiceError} on a non-2xx response
 */
export async function synthesize(text) {
  let res;
  try {
    res = await fetch(`${VOICE_SERVICE_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    throw new VoiceServiceError(`voice-service unreachable: ${err.message}`, 502);
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new VoiceServiceError(`TTS failed (${res.status}): ${detail}`, res.status);
  }

  const synthTimeHeader = res.headers.get('x-synth-time');
  const audioBuffer = Buffer.from(await res.arrayBuffer());
  return { audioBuffer, synthTime: synthTimeHeader ? Number(synthTimeHeader) : null };
}

/** Best-effort extraction of the `detail` field voice-service returns on errors. */
async function safeErrorDetail(res) {
  try {
    const body = await res.json();
    return body?.detail ?? JSON.stringify(body);
  } catch {
    return res.statusText;
  }
}

export default { transcribe, synthesize, VoiceServiceError };
