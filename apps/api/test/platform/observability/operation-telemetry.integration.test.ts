import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { appendRunEvent } from '@pertexo/core/testing';
import {
  createWorkspaceDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SSE_VISIBILITY_METRIC_NAME } from '../../../src/platform/observability/sse-visibility-metrics.js';
import { WORKFLOW_AUTHORING_OPERATION } from '../../../src/workflow-authoring/telemetry.js';
import { createPreviewBoundary } from '../../node-testing/preview-boundary.fixture.js';
import { apiBaseUrl } from '../../support/better-auth/api/stack.js';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
import {
  startTelemetrySdk,
  type TelemetrySdk,
} from '../../support/telemetry-sdk.js';

const OPERATION_COUNT = 'pertexo.workflow_authoring.operation.count';
const OPERATION_DURATION = 'pertexo.workflow_authoring.operation.duration';

/** Reads one SSE response until its text holds `marker`. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const chunk = await reader.read();
    expect(chunk.done, text).toBe(false);
    text += decoder.decode(chunk.value);
  }
  return text;
}

// The real OpenTelemetry SDK is this process's provider before the API
// starts, as main() starts it before loading the application.
describe.runIf(betterAuthIntegrationEnabled)(
  'operation telemetry through the HTTP API',
  () => {
    let sdk: TelemetrySdk;
    beforeAll(() => {
      sdk = startTelemetrySdk();
    });
    afterAll(async () => {
      await sdk.stop();
    });
    const api = useBetterAuthRealApi('operation_telemetry');

    it('measures authoring commands by operation and outcome, and stream frames by path only', async () => {
      const f = await createPreviewBoundary(api);
      const stale = await api.send('GET', f.draft, { browser: f.browser });
      await f.save();
      const refused = await api.send('PUT', f.draft, {
        browser: f.browser,
        headers: { 'if-match': String(stale.headers.etag) },
        payload: { graph: stale.json<{ graph: unknown }>().graph },
      });
      expect(refused.statusCode, refused.payload).toBe(412);
      const draft = await api.send('GET', f.draft, { browser: f.browser });
      const published = await api.send(
        'POST',
        `${f.root}/workflows/${f.workflowId}/publish`,
        {
          browser: f.browser,
          headers: {
            'idempotency-key': randomUUID(),
            'if-match': String(draft.headers.etag),
          },
        },
      );
      expect(published.statusCode, published.payload).toBe(200);

      const counts = await sdk.points(OPERATION_COUNT);
      const count = (operation: string, outcome: string) =>
        counts.find(
          ({ attributes }) =>
            attributes.operation === operation &&
            attributes.outcome === outcome,
        )?.value;
      expect(count(WORKFLOW_AUTHORING_OPERATION.create, 'succeeded')).toBe(1);
      expect(count(WORKFLOW_AUTHORING_OPERATION.draftSave, 'succeeded')).toBe(
        1,
      );
      expect(count(WORKFLOW_AUTHORING_OPERATION.draftSave, 'failed')).toBe(1);
      expect(count(WORKFLOW_AUTHORING_OPERATION.publish, 'succeeded')).toBe(1);
      // Only the bounded pair labels a measurement, never a tenant or a reason.
      for (const point of [
        ...counts,
        ...(await sdk.points(OPERATION_DURATION)),
      ])
        expect(Object.keys(point.attributes).sort()).toEqual([
          'operation',
          'outcome',
        ]);
      expect(
        (await sdk.points(OPERATION_DURATION)).find(
          ({ attributes }) =>
            attributes.operation === WORKFLOW_AUTHORING_OPERATION.draftSave &&
            attributes.outcome === 'failed',
        ),
      ).toMatchObject({ unit: 's', value: { count: 1 } });
      const saves = sdk
        .spans()
        .filter(
          ({ name }) =>
            name ===
            `pertexo.workflow_authoring.${WORKFLOW_AUTHORING_OPERATION.draftSave}`,
        );
      expect(saves.map(({ attributes }) => attributes)).toEqual([
        {
          operation: WORKFLOW_AUTHORING_OPERATION.draftSave,
          outcome: 'succeeded',
        },
        {
          operation: WORKFLOW_AUTHORING_OPERATION.draftSave,
          outcome: 'failed',
        },
      ]);

      const accepted = await api.send(
        'POST',
        `${f.root}/workflows/${f.workflowId}/runs`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {},
        },
      );
      expect(accepted.statusCode, accepted.payload).toBe(202);
      const runId = accepted.json<{ run: { id: string } }>().run.id;
      const url = new URL(apiBaseUrl);
      const adminUrl = api.database().options.connectionString;
      assert(adminUrl !== undefined);
      url.pathname = new URL(adminUrl).pathname;
      const database = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: url.toString(), max: 1 }),
      );
      const abort = new AbortController();
      const base = await api.listen();
      const events = `${base}${f.root}/runs/${runId}/events`;
      try {
        const first = await fetch(events, {
          headers: { cookie: f.browser.cookie },
          signal: abort.signal,
        });
        expect(first.status).toBe(200);
        assert(first.body !== null);
        const reader = first.body.getReader();
        await readUntil(reader, 'id: 1');
        // Appended without a hint, so the open stream finds it by recovery.
        await database.withWorkspace(f.workspaceId, (transaction) =>
          appendRunEvent(transaction, {
            runId,
            event: { type: 'run.succeeded', payload: {} },
          }),
        );
        await readUntil(reader, 'event: run.succeeded');
        await reader.cancel().catch(() => undefined);

        const resumed = await fetch(events, {
          headers: { cookie: f.browser.cookie, 'last-event-id': '1' },
          signal: abort.signal,
        });
        expect(resumed.status).toBe(200);
        assert(resumed.body !== null);
        const resumedReader = resumed.body.getReader();
        await readUntil(resumedReader, 'event: run.succeeded');
        await resumedReader.cancel().catch(() => undefined);
      } finally {
        abort.abort();
        await database.close();
      }

      const frames = await sdk.points(
        SSE_VISIBILITY_METRIC_NAME.persistedToVisible,
      );
      expect(frames.map(({ attributes }) => attributes)).toEqual(
        expect.arrayContaining([
          { path: 'initial_backfill' },
          { path: 'recovery_backfill' },
          { path: 'reconnect_backfill' },
        ]),
      );
      for (const frame of frames) {
        expect(Object.keys(frame.attributes)).toEqual(['path']);
        expect(frame.unit).toBe('s');
      }
    });
  },
);
