import { it } from 'vitest';
import { createEditorControlledHttpTarget } from './editor-controlled-http.js';

// Intentionally fails in a child Vitest reporter; raw inputs are never literals
// in its stack/source excerpt. The parent requires failure AND absent secrets.
it('deliberate secret-bearing dispatch failure', async () => {
  const endpoint = process.env.REDACTION_ENDPOINT_KEY;
  const signature = process.env.REDACTION_SIGNATURE;
  const credential = process.env.REDACTION_CONNECTION_SECRET;
  if (
    endpoint === undefined ||
    signature === undefined ||
    credential === undefined
  )
    throw new Error('Owned redaction probe not configured');
  const target = createEditorControlledHttpTarget(credential);
  try {
    await target.start();
    await target.transport.dispatch({
      url: new URL(
        `https://invalid.example.test/${endpoint}?signature=${signature}`,
      ),
      method: 'POST',
      address: { address: '8.8.8.8', family: 4 },
      headers: { authorization: credential },
      body: Buffer.from('{}'),
      timeoutMillis: 1_000,
    });
  } finally {
    await target.close();
  }
});
