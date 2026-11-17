// Photo input: Telegram size picking, album grouping, history -> API messages.
// Uses a throwaway HOME so the real ~/.ziron sessions are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ziron-test-'));
const { pickPhotoSize, imageOfMessage, createAlbumCollector } = await import('../src/channels/telegram/media.js');
const { appendMessage, buildApiMessages, saveSessionImage, createSession } = await import('../src/storage/history.js');
const { OpenRouterProviderAdapter } = await import('../src/gateway.js');

const sizes = [
  { file_id: 's', width: 90, height: 60 },
  { file_id: 'm', width: 800, height: 533 },
  { file_id: 'l', width: 1280, height: 853 },
  { file_id: 'xl', width: 2560, height: 1706 },
];

test('pickPhotoSize takes the largest size within the limit', () => {
  assert.equal(pickPhotoSize(sizes).file_id, 'l');
  assert.equal(pickPhotoSize(sizes, 500).file_id, 's');
  assert.equal(pickPhotoSize([{ file_id: 'x', width: 4000, height: 3000 }]).file_id, 'x');
  assert.equal(pickPhotoSize([]), null);
});

test('imageOfMessage accepts photos and image files only', () => {
  assert.deepEqual(imageOfMessage({ photo: sizes }), { fileId: 'l', mime: 'image/jpeg', size: undefined });
  assert.equal(imageOfMessage({ document: { file_id: 'd', mime_type: 'image/png' } }).mime, 'image/png');
  assert.equal(imageOfMessage({ document: { file_id: 'd', mime_type: 'application/pdf' } }), null);
  assert.equal(imageOfMessage({ text: 'hi' }), null);
});

test('album parts are flushed once, single photos immediately', async () => {
  const flushed = [];
  const add = createAlbumCollector(async (ctx, items) => { flushed.push(items); }, 30);
  await add({ message: {} }, 'single');
  assert.deepEqual(flushed, [['single']]);
  await add({ message: { media_group_id: 'g' } }, 'a');
  await add({ message: { media_group_id: 'g' } }, 'b');
  assert.equal(flushed.length, 1);
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(flushed[1], ['a', 'b']);
});

const userMsg = (sessionId, content, images) => appendMessage(sessionId, {
  sessionId, parentId: null, role: 'user', content, toolName: null, toolUseId: null,
  isError: false, isCompactBoundary: false, ...(images ? { images } : {}),
});
const assistantMsg = (sessionId, content) => appendMessage(sessionId, {
  sessionId, parentId: null, role: 'assistant', content, toolName: null, toolUseId: null,
  isError: false, isCompactBoundary: false,
});

test('only the current turn carries image data; older photos become a note', async () => {
  const sid = createSession();
  const img = await saveSessionImage(sid, Buffer.from('fake-jpeg'), 'image/jpeg');
  assert.ok(img.path.startsWith(path.join(process.env.HOME, '.ziron', 'media', sid)));

  await userMsg(sid, 'what is this?', [img]);
  let msgs = await buildApiMessages(sid);
  assert.deepEqual(msgs[0].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'image', mediaType: 'image/jpeg', data: Buffer.from('fake-jpeg').toString('base64') },
  ]);

  await assistantMsg(sid, 'a receipt');
  await userMsg(sid, 'thanks');
  msgs = await buildApiMessages(sid);
  assert.equal(typeof msgs[0].content, 'string');
  assert.match(msgs[0].content, /1 photo\(s\) were attached here; no longer visible/);
  assert.equal(msgs[2].content, 'thanks');
});

test('missing image file degrades to a text note', async () => {
  const sid = createSession();
  await userMsg(sid, 'look', [{ path: '/nonexistent/x.jpg', mime: 'image/jpeg' }]);
  const msgs = await buildApiMessages(sid);
  assert.deepEqual(msgs[0].content.map(b => b.type), ['text', 'text']);
});

test('adapter converts image blocks to OpenAI image_url parts', () => {
  const adapter = new OpenRouterProviderAdapter('k', 'm');
  const out = adapter.convertMessagesToOpenAI([
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: 'QUJD' }] },
    { role: 'user', content: 'plain' },
  ]);
  assert.deepEqual(out[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ],
  });
  assert.deepEqual(out[1], { role: 'user', content: 'plain' });
});
