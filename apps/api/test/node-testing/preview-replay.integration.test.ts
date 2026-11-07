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
    it('retains immediate pinned success and its replay after the pin is removed', async () => {
      const f = await createPreviewBoundary(api);
      const revision = await f.save();
      const sample = `${f.draft}/nodes/set/sample`;
      const pin = await api.send('PUT', sample, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          expectedDraftRevision: revision,
          expectedSampleId: null,
          source: { kind: 'json', value: { greeting: 'frozen' } },
        },
      });
      expect(pin.statusCode, pin.payload).toBe(200);
      const sampleId = pin.json<{ sampleId: string }>().sampleId;
      const key = randomUUID();
      const execute = () =>
        api.send('POST', `${f.draft}/nodes/set/test`, {
          browser: f.browser,
          headers: { 'idempotency-key': key },
          payload: {
            mode: 'test_execute',
            expectedRevision: revision,
            expectedSampleId: sampleId,
            input: { kind: 'manual', value: {} },
            acknowledgeSideEffects: true,
          },
        });
      const accepted = await execute();
      expect(accepted.statusCode, accepted.payload).toBe(202);
      expect(accepted.json()).toMatchObject({
        preview: {
          status: 'succeeded',
          pinnedSampleId: sampleId,
          output: { kind: 'inline', value: { greeting: 'frozen' } },
        },
      });
      const id = accepted.json<{ preview: { id: string } }>().preview.id;
      const removed = await api.send('DELETE', sample, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          expectedDraftRevision: revision,
          expectedSampleId: sampleId,
        },
      });
      expect(removed.statusCode, removed.payload).toBe(200);
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
      const work = await api
        .database()
        .query(
          'select (select count(*)::int from app.preview_attempts where preview_run_id=$1) attempts, (select count(*)::int from app.outbox_events where aggregate_id=$1) jobs',
          [id],
        );
      expect(work.rows).toEqual([{ attempts: 0, jobs: 0 }]);
    });
    it('retains a failed attempt explanation and diagnostics without creating more work', async () => {
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
      const summary = 'The retained example could not read its greeting.';
      const diagnostics = {
        logs: [{ level: 'warn', message: 'Retained greeting diagnostic 4400' }],
        truncated: false,
        error: { message: summary, line: 7 },
      };
      const startedAt = new Date().toISOString();
      const completedAt = new Date(Date.now() + 1000).toISOString();
      await api
        .database()
        .query(
          `update app.preview_runs set status='failed', safe_error_code='node.input_invalid', started_at=$2, completed_at=$3 where id=$1`,
          [id, startedAt, completedAt],
        );
      await api
        .database()
        .query(
          `update app.preview_attempts set status='failed', safe_error_code='node.input_invalid', error_summary=$2, code_diagnostics=$3::json, started_at=$4, completed_at=$5 where preview_run_id=$1`,
          [id, summary, JSON.stringify(diagnostics), startedAt, completedAt],
        );
      const work = () =>
        api
          .database()
          .query(
            `select (select count(*)::int from app.preview_attempts where preview_run_id=$1) attempts, (select count(*)::int from app.outbox_events where aggregate_id=$1) outbox`,
            [id],
          );
      const before = await work();
      expect(before.rows[0]).toMatchObject({ attempts: 1 });
      const expected = {
        id,
        status: 'failed',
        safeErrorCode: 'node.input_invalid',
        errorSummary: summary,
        codeDiagnostics: diagnostics,
        output: null,
        startedAt,
        completedAt,
      };
      const read = await api.send('GET', `${f.root}/previews/${id}`, {
        browser: f.browser,
      });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.json()).toMatchObject({ preview: expected });
      const replay = await execute();
      expect(replay.statusCode, replay.payload).toBe(202);
      expect(replay.json()).toMatchObject({
        replayed: true,
        preview: expected,
      });
      expect((await work()).rows).toEqual(before.rows);
      expect(
        (
          await api
            .database()
            .query('select id from app.preview_runs where workflow_id=$1', [
              f.workflowId,
            ])
        ).rows,
      ).toEqual([{ id }]);
    });
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
