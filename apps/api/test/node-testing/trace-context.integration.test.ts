import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from './preview-boundary.fixture.js';
const valid = '00-11111111111111111111111111111111-2222222222222222-01';
describe.runIf(betterAuthIntegrationEnabled)(
  'step-test tracing input boundary',
  () => {
    const api = useBetterAuthRealApi('preview_trace');
    it.each([
      undefined,
      valid,
      'bad',
      `${valid}, ${valid}`,
      '00-00000000000000000000000000000000-2222222222222222-01',
    ])(
      'handles optional trace context %s before acceptance',
      async (traceparent) => {
        const f = await createPreviewBoundary(api);
        const revision = await f.save();
        const accepted = traceparent === undefined || traceparent === valid;
        const response = await api.send('POST', `${f.draft}/nodes/set/test`, {
          browser: f.browser,
          headers: {
            'idempotency-key': randomUUID(),
            ...(traceparent === undefined ? {} : { traceparent }),
          },
          payload: {
            mode: 'test_execute',
            expectedRevision: revision,
            input: { kind: 'manual', value: {} },
            acknowledgeSideEffects: true,
          },
        });
        expect(response.statusCode, response.payload).toBe(
          accepted ? 202 : 400,
        );
        const stored = await api
          .database()
          .query(
            'select traceparent from app.preview_runs where workflow_id=$1',
            [f.workflowId],
          );
        expect(stored.rows).toEqual(
          accepted ? [{ traceparent: traceparent ?? null }] : [],
        );
        if (!accepted) {
          expect(response.json()).toMatchObject({ code: 'request.invalid' });
          expect(response.payload).not.toContain(traceparent);
        }
      },
    );
  },
);
