import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeHeaderImage } from './meta.service.js';

test('normalizeHeaderImage convierte webp (u otro formato) a JPEG', async () => {
  const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .webp()
    .toBuffer();
  const { buffer, mimeType } = await normalizeHeaderImage(webp, 'image/webp');
  assert.equal(mimeType, 'image/jpeg');
  assert.equal(buffer[0], 0xff);
  assert.equal(buffer[1], 0xd8);
});

test('normalizeHeaderImage deja pasar jpeg/png tal cual', async () => {
  const buffer = Buffer.from([1, 2, 3]);
  const jpeg = await normalizeHeaderImage(buffer, 'image/jpeg');
  assert.equal(jpeg.buffer, buffer);
  assert.equal(jpeg.mimeType, 'image/jpeg');
  const png = await normalizeHeaderImage(buffer, 'image/png');
  assert.equal(png.buffer, buffer);
  assert.equal(png.mimeType, 'image/png');
});
