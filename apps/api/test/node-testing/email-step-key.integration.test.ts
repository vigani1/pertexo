import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/secrets/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from './preview-boundary.fixture.js';

/**
 * A step that sends mail must carry one provider key per distinct test, so a
 * retried delivery is deduplicated by the provider and a new test is not.
 */
describe.runIf(betterAuthIntegrationEnabled)('email step test keys', () => {
  const keys = createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
    randomBytes(32),
    'connection',
  );
  const api = useBetterAuthRealApi('email_step_key', {
    connections: {
      config: { kmsKeyReference: 'email-step-key', region: 'us-east-1' },
      services: () => ({
        encryption: { encryption: new ConnectionEnvelopeEncryption(keys) },
      }),
    },
  });
  afterAll(() => {
    keys.close();
  });

  it('gives each accepted email test its own stable provider key', async () => {
    const f = await createPreviewBoundary(api);
    const connection = await api.send('POST', `${f.root}/connections`, {
      browser: f.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        providerKey: 'email',
        name: 'Step test relay',
        credential: {
          type: 'smtp',
          host: 'relay.example.test',
          port: 587,
          security: 'starttls',
          username: 'ada',
          password: 'email-step-key-password',
          fromEmail: 'alerts@example.test',
        },
      },
    });
    expect(connection.statusCode, connection.payload).toBe(201);
    const current = await api.send('GET', f.draft, { browser: f.browser });
    const saved = await api.send('PUT', f.draft, {
      browser: f.browser,
      headers: { 'if-match': String(current.headers.etag) },
      payload: {
        graph: {
          nodes: [
            {
              id: 'email',
              definition: { key: 'email.send_notification', version: 1 },
              configVersion: 1,
              config: { timeoutMillis: 10_000 },
              position: { x: 0, y: 0 },
              inputMappings: {
                toEmail: { kind: 'run_input', path: '$.toEmail' },
                subject: { kind: 'run_input', path: '$.subject' },
                text: { kind: 'run_input', path: '$.text' },
              },
              connectionRefs: {
                resend_api_key: connection.json<{ id: string }>().id,
              },
            },
          ],
          edges: [],
          settings: {},
        },
      },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    const revision = saved.json<{ revision: number }>().revision;
    const test = (key: string, subject: string) =>
      api.send('POST', `${f.draft}/nodes/email/test`, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload: {
          mode: 'test_execute',
          expectedRevision: revision,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: {
              toEmail: 'recipient@example.test',
              subject,
              text: 'Production is healthy.',
            },
          },
        },
      });

    const firstKey = randomUUID();
    const first = await test(firstKey, 'Deployment complete');
    expect(first.statusCode, first.payload).toBe(202);
    expect(first.json()).toMatchObject({
      preview: {
        disclosure: {
          sideEffectClass: 'idempotent_with_key',
          mayContactProvider: true,
        },
      },
    });
    expect((await test(firstKey, 'Deployment complete')).statusCode).toBe(202);
    const second = await test(randomUUID(), 'Deployment rolled back');
    expect(second.statusCode, second.payload).toBe(202);

    const attempts = await api.database().query<{
      provider_idempotency_key: string;
    }>(
      `select a.provider_idempotency_key
         from app.preview_attempts a join app.preview_runs r on r.id=a.preview_run_id
        where r.workflow_id=$1 order by r.created_at`,
      [f.workflowId],
    );
    const providerKeys = attempts.rows.map(
      (row) => row.provider_idempotency_key,
    );
    expect(providerKeys).toHaveLength(2);
    for (const key of providerKeys) expect(key).toMatch(/^pv1\.[0-9a-f]{64}$/);
    expect(new Set(providerKeys).size).toBe(2);
  });
});
