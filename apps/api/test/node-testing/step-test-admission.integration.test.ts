import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_EXECUTION_TIMEOUT_MAX_MS,
  PREVIEW_RETENTION_MAX_MS,
} from '@pertexo/core/previews';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
  type Browser,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from './preview-boundary.fixture.js';

type Api = ReturnType<typeof useBetterAuthRealApi>;
type Boundary = Awaited<ReturnType<typeof createPreviewBoundary>>;

/**
 * One step's test over real HTTP, Postgres and the real step catalog: what a
 * check, an accepted test and a replay answer, and which rows they leave.
 */
describe.runIf(betterAuthIntegrationEnabled)('step test admission', () => {
  const api = useBetterAuthRealApi('step_test_admission');

  it('checks without storing, refuses stale or reused requests, and replays an accepted test after the draft moves on', async () => {
    const f = await createPreviewBoundary(api);
    const revision = await f.save();
    const previews = () => previewRows(api, f.workflowId);

    const checked = await send(api, f, 'set', {
      payload: {
        mode: 'validate',
        expectedRevision: revision,
        sampleInput: {},
      },
    });
    expect(checked.statusCode, checked.payload).toBe(200);
    expect(checked.json()).toMatchObject({
      mode: 'validate',
      valid: true,
      revision,
      nodeId: 'set',
      issues: [],
      disclosure: { mayContactProvider: false },
    });
    expect(await previews()).toEqual([]);

    const stale = await send(api, f, 'set', {
      payload: {
        mode: 'validate',
        expectedRevision: revision + 1,
      },
    });
    const current = await api.send('GET', f.draft, { browser: f.browser });
    expectProblem(stale, 412, 'workflow.revision_conflict');
    expect(stale.json()).toMatchObject({
      currentRevision: revision,
      currentEtag: current.headers.etag,
    });

    const body = execute(revision, { greeting: 'first' });
    const keyless = await send(api, f, 'set', { payload: body });
    expectProblem(keyless, 400, 'request.invalid');
    expect(await previews()).toEqual([]);

    const key = randomUUID();
    const requestId = randomUUID();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const accepted = await send(api, f, 'set', {
      payload: body,
      key: key,
      headers: {
        'x-request-id': requestId,
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
    });
    expect(accepted.statusCode, accepted.payload).toBe(202);
    expect(accepted.json()).toMatchObject({
      mode: 'test_execute',
      replayed: false,
      preview: { status: 'queued', nodeId: 'set', draftRevision: revision },
    });
    const id = accepted.json<{ preview: { id: string } }>().preview.id;
    const [stored] = await previews();
    expect(stored).toMatchObject({
      id,
      draft_revision: revision,
      definition_key: 'core.set',
      executor_key: 'core.set',
      side_effect_class: 'safe',
      prior_preview_run_id: null,
      request_id: requestId,
      trace_id: traceId,
    });
    for (const digest of [
      stored?.draft_fingerprint,
      stored?.idempotency_key_hash,
      stored?.request_hash,
    ])
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.idempotency_key_hash).not.toBe(stored?.request_hash);
    expectWindow(stored?.deadline_ms, PREVIEW_EXECUTION_TIMEOUT_MAX_MS);
    expectWindow(stored?.retention_ms, PREVIEW_RETENTION_MAX_MS);

    const reused = await send(api, f, 'set', {
      payload: execute(revision, { greeting: 'changed' }),
      key: key,
    });
    expectProblem(reused, 409, 'request.idempotency_conflict');

    const moved = await f.save({
      greeting: { kind: 'run_input', path: '$.greeting' },
    });
    expect(moved).toBeGreaterThan(revision);
    const replay = await send(api, f, 'set', { payload: body, key: key });
    expect(replay.statusCode, replay.payload).toBe(202);
    expect(replay.json()).toMatchObject({
      replayed: true,
      preview: { id, draftRevision: revision },
    });

    const newKey = await send(api, f, 'set', {
      payload: body,
      key: randomUUID(),
    });
    expectProblem(newKey, 412, 'workflow.revision_conflict');
    expect(newKey.json()).toMatchObject({ currentRevision: moved });
    expect((await previews()).map((row) => row.id)).toEqual([id]);

    const missing = await api.send(
      'GET',
      `${f.root}/previews/${randomUUID()}`,
      { browser: f.browser },
    );
    expectProblem(missing, 404, 'resource.not_found');
  });

  it('holds a test to the pin it was shown and feeds a finished test into the next one', async () => {
    const f = await createPreviewBoundary(api);
    const revision = await f.save();
    const sample = `${f.draft}/nodes/set/sample`;
    const pin = await api.send('PUT', sample, {
      browser: f.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        expectedDraftRevision: revision,
        expectedSampleId: null,
        source: { kind: 'json', value: { greeting: 'pinned' } },
      },
    });
    expect(pin.statusCode, pin.payload).toBe(200);
    const sampleId = pin.json<{ sampleId: string }>().sampleId;

    const unseen = await send(api, f, 'set', {
      payload: { ...execute(revision, {}), expectedSampleId: null },
      key: randomUUID(),
    });
    expectProblem(unseen, 409, 'workflow.sample_conflict');
    expect(unseen.json()).toMatchObject({
      detail: 'The pinned sample changed. Refresh it before trying again.',
    });
    expect(await previewRows(api, f.workflowId)).toEqual([]);

    const pinned = await send(api, f, 'set', {
      payload: { ...execute(revision, {}), expectedSampleId: sampleId },
      key: randomUUID(),
    });
    expect(pinned.statusCode, pinned.payload).toBe(202);
    expect(pinned.json()).toMatchObject({
      preview: {
        status: 'succeeded',
        pinnedSampleId: sampleId,
        startedAt: null,
        disclosure: {
          mayContactProvider: false,
          mayCauseExternalSideEffect: false,
        },
      },
    });
    const prior = pinned.json<{ preview: { id: string } }>().preview.id;
    const removed = await api.send('DELETE', sample, {
      browser: f.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { expectedDraftRevision: revision, expectedSampleId: sampleId },
    });
    expect(removed.statusCode, removed.payload).toBe(200);

    const chained = await send(api, f, 'set', {
      payload: {
        mode: 'test_execute',
        expectedRevision: revision,
        acknowledgeSideEffects: true,
        input: { kind: 'prior_preview', previewRunId: prior },
      },
      key: randomUUID(),
    });
    expect(chained.statusCode, chained.payload).toBe(202);
    const next = chained.json<{ preview: { id: string } }>().preview.id;
    expect(
      (await previewRows(api, f.workflowId)).find((row) => row.id === next),
    ).toMatchObject({ prior_preview_run_id: prior });
  });

  it('refuses a step whose setup is invalid without accepting a test', async () => {
    const f = await createPreviewBoundary(api);
    const current = await api.send('GET', f.draft, { browser: f.browser });
    const saved = await api.send('PUT', f.draft, {
      browser: f.browser,
      headers: { 'if-match': String(current.headers.etag) },
      payload: {
        graph: {
          nodes: [
            {
              id: 'http',
              definition: { key: 'http.request', version: 1 },
              configVersion: 1,
              config: {
                method: 'POST',
                url: 'https://provider.example.test/resource',
                headers: {},
                timeoutMillis: 0,
                maxRedirects: 1,
                maxResponseBytes: 1_024,
                inlineResponseBytes: 512,
              },
              position: { x: 0, y: 0 },
              inputMappings: {},
              connectionRefs: {},
            },
          ],
          edges: [],
          settings: {},
        },
      },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    const revision = saved.json<{ revision: number }>().revision;
    const refused = await send(api, f, 'http', {
      payload: execute(revision, {}),
      key: randomUUID(),
    });
    expectProblem(refused, 422, 'workflow.invalid');
    expect(
      refused.json<{ errors: { code: string; path: string }[] }>().errors,
    ).toContainEqual(
      expect.objectContaining({
        code: 'node.config_invalid',
        path: '$.config.timeoutMillis',
      }),
    );
    expect(await previewRows(api, f.workflowId)).toEqual([]);
  });

  it('hides step tests and their results from a member who cannot edit workflows', async () => {
    const f = await createPreviewBoundary(api);
    const revision = await f.save();
    const started = await send(api, f, 'set', {
      payload: execute(revision, {}),
      key: randomUUID(),
    });
    expect(started.statusCode, started.payload).toBe(202);
    const id = started.json<{ preview: { id: string } }>().preview.id;
    const operator = await join(api, f.workspaceId, 'operator');

    const denied = await send(api, { ...f, browser: operator }, 'set', {
      payload: execute(revision, {}),
      key: randomUUID(),
    });
    expectProblem(denied, 404, 'resource.not_found');
    const read = await api.send('GET', `${f.root}/previews/${id}`, {
      browser: operator,
    });
    expectProblem(read, 404, 'resource.not_found');
    expect((await previewRows(api, f.workflowId)).map((row) => row.id)).toEqual(
      [id],
    );
  });
});

function execute(expectedRevision: number, value: object) {
  return {
    mode: 'test_execute',
    expectedRevision,
    acknowledgeSideEffects: true,
    input: { kind: 'manual', value },
  };
}

function send(
  api: Api,
  f: Pick<Boundary, 'draft' | 'browser'>,
  nodeId: string,
  request: Readonly<{
    payload: object;
    key?: string;
    headers?: Record<string, string>;
  }>,
) {
  return api.send('POST', `${f.draft}/nodes/${nodeId}/test`, {
    browser: f.browser,
    headers: {
      ...request.headers,
      ...(request.key === undefined ? {} : { 'idempotency-key': request.key }),
    },
    payload: request.payload,
  });
}

async function previewRows(api: Api, workflowId: string) {
  const result = await api.database().query<{
    id: string;
    prior_preview_run_id: string | null;
    trace_id: string | null;
    draft_fingerprint: string;
    idempotency_key_hash: string;
    request_hash: string;
    deadline_ms: number;
    retention_ms: number;
  }>(
    `select id, actor_user_id, draft_revision, definition_key, executor_key,
            side_effect_class, prior_preview_run_id, draft_fingerprint,
            idempotency_key_hash, request_hash, request_id, trace_id,
            extract(epoch from execution_deadline_at - created_at)::double precision * 1000 deadline_ms,
            extract(epoch from expires_at - created_at)::double precision * 1000 retention_ms
       from app.preview_runs where workflow_id=$1 order by created_at`,
    [workflowId],
  );
  return result.rows;
}

/** The API stamps both times from its own clock; the row's creation time is Postgres's. */
function expectWindow(actual: number | undefined, expected: number) {
  expect(actual).toBeGreaterThan(expected - 10_000);
  expect(actual).toBeLessThan(expected + 10_000);
}

function expectProblem(
  response: Readonly<{ statusCode: number; payload: string; json(): unknown }>,
  status: number,
  code: string,
) {
  expect(response.statusCode, response.payload).toBe(status);
  expect(response.json()).toMatchObject({ code });
}

async function join(
  api: Api,
  workspaceId: string,
  role: string,
): Promise<Browser> {
  const email = `${role}-${randomUUID()}@example.test`;
  await api.signUp(email, '/workspaces');
  const browser = await api.signIn(email);
  await api.database().query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status)
     select $1,id,$2,'active' from app.users where email=$3`,
    [workspaceId, role, email],
  );
  return browser;
}
