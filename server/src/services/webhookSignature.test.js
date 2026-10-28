import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyWebhookSignature } from './meta.service.js';

process.env.META_APP_SECRET = 'fb-secret';
process.env.META_IG_APP_SECRET = 'ig-secret';

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const body = Buffer.from('{"object":"instagram"}');

test('acepta la firma de la app de Facebook (WhatsApp)', () => {
  assert.equal(verifyWebhookSignature(body, sign('fb-secret', body)), true);
});

test('acepta la firma de la app de Instagram', () => {
  assert.equal(verifyWebhookSignature(body, sign('ig-secret', body)), true);
});

test('rechaza firmas con otro secreto o mal formadas', () => {
  assert.equal(verifyWebhookSignature(body, sign('otro', body)), false);
  assert.equal(verifyWebhookSignature(body, 'sha256=corta'), false);
  assert.equal(verifyWebhookSignature(body, undefined), false);
});
