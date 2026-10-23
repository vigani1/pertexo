import { randomUUID, createHash } from 'node:crypto';

import {
  canonicalJson,
  portableGraphDigest,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import {
  workflowListResponseSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
  workflowImportPreviewResponseSchema,
  workflowImportResponseSchema,
  apiTokenCreateResponseSchema,
} from '@pertexo/contracts';

import type { createAutomationApiFixture } from './fixture.js';

export function registerUsesPublishStartCancelReviewedPortabilityCredential(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
): void {
  const { api, listen } = caseFixture;

  it('uses publish, start, cancel and reviewed portability with credential-isolated receipts', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const workspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Script authoring',
        slug: `script-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = workspace.json<{ id: string }>().id;
    const base = `/v1/workspaces/${workspaceId}`;
    const createdWorkflow = await api.send('POST', `${base}/workflows`, {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: 'Pure script workflow' },
    });
    expect(createdWorkflow.statusCode).toBe(201);
    const workflowId = workflowCreateResponseSchema.parse(
      createdWorkflow.json(),
    ).workflow.id;
    const graph = {
      nodes: [
        {
          id: randomUUID(),
          definition: { key: 'core.set', version: 1 },
          configVersion: 1,
          config: {},
          inputMappings: { value: { kind: 'run_input', path: '$.value' } },
          connectionRefs: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      settings: {},
    };
    const saved = await api.send(
      'PUT',
      `${base}/workflows/${workflowId}/draft`,
      {
        browser,
        headers: { 'if-match': String(createdWorkflow.headers.etag) },
        payload: { graph },
      },
    );
    expect(saved.statusCode).toBe(200);
    const draft = workflowDraftResponseSchema.parse(saved.json());
    async function credential(name: string) {
      const response = await api.send('POST', `${base}/api-tokens`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name,
          scopes: [
            'workflow:read',
            'workflow:create',
            'workflow:publish',
            'run:read',
            'run:start',
            'run:cancel',
          ],
        },
      });
      expect(response.statusCode).toBe(201);
      const result = apiTokenCreateResponseSchema.parse(response.json());
      if (result.replayed) throw new Error('First creation replayed');
      return result;
    }
    const first = await credential('Deployment one');
    const second = await credential('Deployment two');
    const headers = { authorization: `Bearer ${first.secret}` };
    for (const suffix of ['', '/draft', '/versions']) {
      expect(
        (
          await api.send('GET', `${base}/workflows/${workflowId}${suffix}`, {
            headers,
          })
        ).statusCode,
      ).toBe(200);
    }

    const publishKey = randomUUID();
    const published = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/publish`,
      {
        headers: {
          ...headers,
          'idempotency-key': publishKey,
          'if-match': String(saved.headers.etag),
        },
      },
    );
    expect(published.statusCode).toBe(200);
    const versionId = workflowPublishResponseSchema.parse(published.json())
      .version.id;
    const replay = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/publish`,
      {
        headers: {
          ...headers,
          'idempotency-key': publishKey,
          'if-match': String(saved.headers.etag),
        },
      },
    );
    expect(replay.statusCode).toBe(200);
    expect(workflowPublishResponseSchema.parse(replay.json()).version.id).toBe(
      versionId,
    );
    const deniedVersion = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { expectedPublishedVersionId: randomUUID() },
      },
    );
    expect(deniedVersion.statusCode).toBe(409);
    expect(deniedVersion.json<{ code: string }>().code).toBe(
      'workflow.published_version_conflict',
    );
    const key = randomUUID();
    const payload = {
      input: { value: 'actual token input' },
      expectedPublishedVersionId: versionId,
    };
    const start = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      {
        headers: { ...headers, 'idempotency-key': key },
        payload,
      },
    );
    const startProblem = start.json<{
      code?: string;
      detail?: string;
      issues?: unknown;
    }>();
    expect(
      start.statusCode,
      JSON.stringify({
        code: startProblem.code,
        detail: startProblem.detail,
        issues: startProblem.issues,
      }),
    ).toBe(202);
    const started = workflowRunStartResponseSchema.parse(start.json());
    const retried = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      { headers: { ...headers, 'idempotency-key': key }, payload },
    );
    expect(retried.statusCode).toBe(202);
    expect(workflowRunStartResponseSchema.parse(retried.json()).run.id).toBe(
      started.run.id,
    );
    const other = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      {
        headers: {
          authorization: `Bearer ${second.secret}`,
          'idempotency-key': key,
        },
        payload,
      },
    );
    expect(other.statusCode).toBe(202);
    expect(workflowRunStartResponseSchema.parse(other.json()).run.id).not.toBe(
      started.run.id,
    );
    const weakKey = createHash('sha256')
      .update(canonicalJson({ kind: 'api_key', tokenId: first.token.id, key }))
      .digest('hex');
    const sessionRun = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      { browser, headers: { 'idempotency-key': weakKey }, payload },
    );
    expect(sessionRun.statusCode).toBe(202);
    expect(
      workflowRunStartResponseSchema.parse(sessionRun.json()).run.id,
    ).not.toBe(started.run.id);
    expect(
      (await api.send('GET', `${base}/runs/${started.run.id}`, { headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await api.send('POST', `${base}/runs/${started.run.id}/cancel`, {
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const exported = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/export`,
      {
        headers: { ...headers, 'if-match': String(saved.headers.etag) },
        payload: {
          source: { kind: 'draft' },
          reviewedGraphDigest: await portableGraphDigest(draft.graph),
        },
      },
    );
    expect(exported.statusCode).toBe(200);
    const manifest = exported.json<WorkflowPortableManifest>();
    const preview = await api.send('POST', `${base}/workflows/import/preview`, {
      headers,
      payload: { manifest, bindings: [] },
    });
    expect(preview.statusCode).toBe(200);
    const reviewed = workflowImportPreviewResponseSchema.parse(preview.json());
    const importKey = randomUUID();
    const importPayload = {
      name: 'Script imported copy',
      manifest,
      bindings: [],
      expectedCompatibilityFingerprint: reviewed.compatibilityFingerprint,
    };
    const imported = await api.send('POST', `${base}/workflows/import`, {
      headers: { ...headers, 'idempotency-key': importKey },
      payload: importPayload,
    });
    expect(imported.statusCode).toBe(201);
    const copy = workflowImportResponseSchema.parse(imported.json());
    const repeated = await api.send('POST', `${base}/workflows/import`, {
      headers: { ...headers, 'idempotency-key': importKey },
      payload: importPayload,
    });
    expect(repeated.statusCode).toBe(201);
    expect(workflowImportResponseSchema.parse(repeated.json()).workflowId).toBe(
      copy.workflowId,
    );
    expect(
      (
        await api.send('GET', `${base}/workflows/${copy.workflowId}/versions`, {
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const receiptScopes = await api
      .database()
      .query<{ scope: string }>(
        "select scope from app.idempotency_records where workspace_id=$1 and operation in ('workflow.publish','workflow.import','workflow.run.accept')",
        [workspaceId],
      );
    expect(
      receiptScopes.rows.some((row) => row.scope.startsWith('api_token:')),
    ).toBe(true);
    const replacementOwner = randomUUID(),
      privateFolder = randomUUID();
    await api
      .database()
      .query('insert into app.users(id,email,display_name) values($1,$2,$3)', [
        replacementOwner,
        `${replacementOwner}@example.test`,
        'Remaining owner',
      ]);
    const membership = await api.database().connect();
    try {
      await membership.query('begin');
      await membership.query(
        "update app.workspace_memberships set role='builder',role_revision=role_revision+1 where workspace_id=$1",
        [workspaceId],
      );
      await membership.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
        [workspaceId, replacementOwner],
      );
      await membership.query('commit');
    } catch (error) {
      await membership.query('rollback');
      throw error;
    } finally {
      membership.release();
    }
    const fresh = await api.signIn(email);
    const issuedAfterRoleChange = await api.send('POST', `${base}/api-tokens`, {
      browser: fresh,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Builder resource scope',
        scopes: ['workflow:read', 'run:read', 'run:start'],
      },
    });
    expect(issuedAfterRoleChange.statusCode).toBe(201);
    const builderToken = apiTokenCreateResponseSchema.parse(
      issuedAfterRoleChange.json(),
    );
    if (builderToken.replayed)
      throw new Error('Expected a newly issued builder token');
    const builderHeaders = { authorization: `Bearer ${builderToken.secret}` };
    expect(
      (
        await api.send('GET', `${base}/workflows/${workflowId}`, {
          headers: builderHeaders,
        })
      ).statusCode,
    ).toBe(200);
    const builderKey = randomUUID();
    const builderStartedResponse = await api.send(
      'POST',
      `${base}/workflows/${workflowId}/runs`,
      {
        headers: { ...builderHeaders, 'idempotency-key': builderKey },
        payload,
      },
    );
    expect(builderStartedResponse.statusCode).toBe(202);
    const builderRun = workflowRunStartResponseSchema.parse(
      builderStartedResponse.json(),
    ).run;
    const streamAbort = new AbortController();
    const streamSignal = AbortSignal.any([
      streamAbort.signal,
      AbortSignal.timeout(15_000),
    ]);
    const stream = await fetch(
      `${await listen()}${base}/runs/${builderRun.id}/events`,
      { headers: { cookie: fresh.cookie }, signal: streamSignal },
    );
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('Expected an authorized run stream');
    try {
      const firstFrame = await reader.read();
      expect(firstFrame.done).toBe(false);
      await api
        .database()
        .query(
          "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Private source','private source','restricted')",
          [workspaceId, privateFolder],
        );
      await api
        .database()
        .query(
          'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id,revision=app.workflow_organization_state.revision+1',
          [workspaceId, workflowId, privateFolder],
        );
      for (const path of [
        `workflows/${workflowId}`,
        `workflows/${workflowId}/draft`,
        `workflows/${workflowId}/versions`,
        `runs/${started.run.id}`,
      ])
        expect(
          (
            await api.send('GET', `${base}/${path}`, {
              headers: builderHeaders,
            })
          ).statusCode,
        ).toBe(404);
      const visible = await api.send('GET', `${base}/workflows?limit=1`, {
        headers: builderHeaders,
      });
      expect(visible.statusCode).toBe(200);
      const visiblePage = workflowListResponseSchema.parse(visible.json());
      expect(visiblePage.items.map((item) => item.id)).toEqual([
        copy.workflowId,
      ]);
      expect(visiblePage.nextCursor ?? null).toBeNull();
      const replayAfterLoss = await api.send(
        'POST',
        `${base}/workflows/${workflowId}/runs`,
        {
          headers: { ...builderHeaders, 'idempotency-key': builderKey },
          payload,
        },
      );
      expect(replayAfterLoss.statusCode).toBe(404);
      let closed = false;
      try {
        while (!(await reader.read()).done) {
          /* Drain only frames authorized before revocation. */
        }
        closed = true;
      } catch {
        // A server-initiated socket close and a clean EOF both revoke the stream.
        closed = !streamSignal.aborted;
      }
      expect(closed && !streamSignal.aborted).toBe(true);
    } finally {
      streamAbort.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });
}
