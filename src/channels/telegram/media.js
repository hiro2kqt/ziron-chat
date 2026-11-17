/**
 * Telegram photo input: pick a size, download it, group albums.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Image types the chat models accept */
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Larger files are refused (base64 grows them by 1/3 on every LLM call of the turn) */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Largest photo size whose longer side is <= maxSide (Telegram lists sizes
 * ascending); the smallest one if all are larger.
 * @param {Array<{file_id: string, width: number, height: number}>} sizes
 * @param {number} [maxSide]
 */
export function pickPhotoSize(sizes, maxSide = 1600) {
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  const fitting = sizes.filter(s => Math.max(s.width, s.height) <= maxSide);
  return fitting.length ? fitting[fitting.length - 1] : sizes[0];
}

/**
 * The image in a message: a compressed photo, or an image sent as a file.
 * @param {Object} message - Telegram message
 * @returns {{fileId: string, mime: string, size?: number} | null}
 */
export function imageOfMessage(message) {
  if (message?.photo) {
    const p = pickPhotoSize(message.photo);
    return p ? { fileId: p.file_id, mime: 'image/jpeg', size: p.file_size } : null;
  }
  const doc = message?.document;
  if (doc && SUPPORTED_IMAGE_TYPES.includes(doc.mime_type)) {
    return { fileId: doc.file_id, mime: doc.mime_type, size: doc.file_size };
  }
  return null;
}

/**
 * Download a file. A local Bot API server (`--local`) returns an absolute
 * path on this machine; api.telegram.org returns a relative path to fetch.
 * @param {import('grammy').Api} api
 * @param {string} fileId
 * @param {{botToken: string, apiRoot?: string}} opts
 * @returns {Promise<Buffer>}
 */
export async function downloadFile(api, fileId, { botToken, apiRoot = '' }) {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram returned no file_path');
  if (file.file_size && file.file_size > MAX_IMAGE_BYTES) throw new Error('File too large');

  let data;
  if (isAbsolute(file.file_path)) {
    data = await readFile(file.file_path);
  } else {
    const root = (apiRoot || 'https://api.telegram.org').replace(/\/$/, '');
    const res = await fetch(`${root}/file/bot${botToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`File download failed: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  }
  if (data.length > MAX_IMAGE_BYTES) throw new Error('File too large');
  return data;
}

/**
 * Albums arrive as one message per photo with a shared media_group_id.
 * Collects them until no new part arrived for `delayMs`, then calls
 * onFlush(firstCtx, items) once. Messages without a group flush at once.
 * @param {(ctx: Object, items: Array) => Promise<void>} onFlush
 * @param {number} [delayMs]
 */
export function createAlbumCollector(onFlush, delayMs = 1500) {
  const groups = new Map();
  return function add(ctx, item) {
    const groupId = ctx.message?.media_group_id;
    if (!groupId) return onFlush(ctx, [item]);
    let g = groups.get(groupId);
    if (!g) {
      g = { ctx, items: [], timer: null };
      groups.set(groupId, g);
    }
    g.items.push(item);
    clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      groups.delete(groupId);
      onFlush(g.ctx, g.items).catch(() => {});
    }, delayMs);
    return Promise.resolve();
  };
}
