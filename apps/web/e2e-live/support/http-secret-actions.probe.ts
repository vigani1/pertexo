import { test } from './browser-fixture';
import {
  fillOwnedHttpCredential,
  invokeOwnedWebhook,
} from './http-secret-actions';

// Deliberate reporter failures, never part of the real acceptance journey.
test('credential fill failure is redacted', async ({ page }) => {
  page.setDefaultTimeout(250);
  const secret = process.env.PERTEXO_HTTP_REDACTION_CREDENTIAL;
  if (secret === undefined)
    throw new Error('Explicit HTTP redaction material required');
  await fillOwnedHttpCredential(page.getByLabel('Missing credential'), secret);
});
test('signed sender failure is redacted', async ({ request }) => {
  const endpointKey = process.env.PERTEXO_HTTP_REDACTION_ENDPOINT;
  const signingSecret = process.env.PERTEXO_HTTP_REDACTION_SIGNATURE;
  if (endpointKey === undefined || signingSecret === undefined)
    throw new Error('Explicit HTTP redaction material required');
  await invokeOwnedWebhook(request, 'http://127.0.0.1:1', {
    endpointKey,
    signingSecret,
  });
});

test('visible credential failure omits the DOM artifact', async ({ page }) => {
  const credential = process.env.PERTEXO_HTTP_REDACTION_CREDENTIAL;
  const endpoint = process.env.PERTEXO_HTTP_REDACTION_ENDPOINT;
  const signature = process.env.PERTEXO_HTTP_REDACTION_SIGNATURE;
  if (
    credential === undefined ||
    endpoint === undefined ||
    signature === undefined
  )
    throw new Error('Explicit HTTP redaction material required');
  try {
    await page.evaluate(
      (values) => {
        const reveal = document.createElement('pre');
        reveal.textContent = values.join('\n');
        document.body.replaceChildren(reveal);
      },
      [credential, endpoint, signature],
    );
  } catch {
    throw new Error(
      'Owned visible credential setup failed; sensitive details omitted.',
    );
  }
  throw new Error(
    'Owned visible credential failure; sensitive details omitted.',
  );
});
