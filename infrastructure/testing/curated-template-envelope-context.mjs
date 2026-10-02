import { createEditorBrowserEnvelopeKeys } from './editor-browser-envelope-keys.mjs';

// Deliberately synthetic, not a browser/runtime configuration or application export.
export const CURATED_TEMPLATE_FIXTURE = Object.freeze({
  httpEndpoint: 'https://f06-controlled.example.test/result',
  httpAuthorization: 'Bearer f06-synthetic-fixture-only',
  slackBotToken: 'xoxb-f06-synthetic-fixture-only',
  slackChannel: 'CF06QUALIFY',
  slackText: 'Curated demo: controlled endpoint returned 200.',
});

/** API and worker receive the same root-owned key through private fixture IPC.
 * Each owns an independent, disposable key provider; no env or network fallback.
 */
export function createCuratedTemplateEnvelopeContext(masterKeyHex) {
  if (typeof masterKeyHex !== 'string' || !/^[a-f0-9]{64}$/u.test(masterKeyHex))
    throw new Error('Owned curated envelope configuration invalid');
  const master = Buffer.from(masterKeyHex, 'hex');
  try {
    return createEditorBrowserEnvelopeKeys(master, 'connection');
  } finally {
    master.fill(0);
  }
}
