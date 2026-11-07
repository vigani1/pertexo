import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from './preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'retained step-test replay',
  () => {
    const api = useBetterAuthRealApi('preview_replay');
    it.each([
      'running',
      'succeeded',
      'failed',
      'timed_out',
      'outcome_unknown',
    ] as const)(
      'returns the same %s outcome as GET without another command',
      async (status) => {
        const f = await createPreviewBoundary(api);
        const revision = await f.save();
        const key = randomUUID();
        const execute = () =>
          api.send('POST', `${f.draft}/nodes/set/test`, {
            browser: f.browser,
            headers: { 'idempotency-key': key },
            payload: {
              mode: 'test_execute',
              expectedRevision: revision,
              input: { kind: 'manual', value: {} },
              acknowledgeSideEffects: true,
            },
          });
        const accepted = await execute();
        expect(accepted.statusCode, accepted.payload).toBe(202);
        const id = accepted.json<{ preview: { id: string } }>().preview.id;
        await api
          .database()
          .query(
            `update app.preview_runs set status=$2, started_at=created_at, completed_at=case when $5::boolean then null else clock_timestamp() end, safe_error_code=$3, output_ref=$4::json where id=$1`,
            [
              id,
              status,
              ['running', 'succeeded'].includes(status)
                ? null
                : 'node.input_invalid',
              status === 'succeeded'
                ? JSON.stringify({
                    kind: 'inline',
                    value: { greeting: 'saved output' },
                  })
                : null,
              status === 'running',
            ],
          );
        const read = await api.send('GET', `${f.root}/previews/${id}`, {
          browser: f.browser,
        });
        expect(read.statusCode, read.payload).toBe(200);
        const replay = await execute();
        expect(replay.statusCode, replay.payload).toBe(202);
        expect(replay.json()).toMatchObject({
          replayed: true,
          preview: read.json<{ preview: unknown }>().preview,
        });
        const rows = await api
          .database()
          .query('select id from app.preview_runs where workflow_id=$1', [
            f.workflowId,
          ]);
        expect(rows.rows).toEqual([{ id }]);
      },
    );
  },
);
