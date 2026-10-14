import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  canonicalJson,
  portableGraphDigest,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import {
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowPublishResponseSchema,
  workflowRunStartResponseSchema,
  workflowImportPreviewResponseSchema,
  workflowImportResponseSchema,
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
  apiTokenRevokeResponseSchema,
} from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'personal automation HTTP authentication',
  () => {
    const api = useBetterAuthRealApi('tokens', { automationTokens: true });
    it('creates once through a real browser session, authenticates only scoped routes and revokes', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Automation team',
          slug: `tokens-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const path = `/v1/workspaces/${workspaceId}`;
      const command = {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Read-only script',
          scopes: ['workflow:read', 'run:read'],
        },
      };
      const reply = await api.send('POST', `${path}/api-tokens`, command);
      expect(reply.statusCode).toBe(201);
      expect(reply.headers['cache-control']).toBe('private, no-store');
      const created = apiTokenCreateResponseSchema.parse(reply.json());
      if (created.replayed) throw new Error('First token creation replayed');
      const bearer = { authorization: `Bearer ${created.secret}` };
      const replay = await api.send('POST', `${path}/api-tokens`, command);
      expect(replay.statusCode).toBe(201);
      expect(
        apiTokenCreateResponseSchema.parse(replay.json()),
      ).not.toHaveProperty('secret');
      const listed = await api.send('GET', `${path}/api-tokens`, { browser });
      expect(listed.statusCode).toBe(200);
      expect(
        apiTokenListResponseSchema.parse(listed.json()).items,
      ).toHaveLength(1);
      expect(listed.payload).not.toContain(created.secret);
      for (const resource of ['workflows', 'runs']) {
        expect(
          (await api.send('GET', `${path}/${resource}`, { headers: bearer }))
            .statusCode,
        ).toBe(200);
      }
      const origin = await api.listen();
      const repeatedHeaderStatus = await new Promise<number>(
        (resolve, reject) => {
          const call = httpRequest(
            `${origin}${path}/workflows`,
            {
              agent: false,
              headers: [
                'Host',
                new URL(origin).host,
                'Authorization',
                `Bearer ${created.secret}`,
                'AUTHORIZATION',
                `Bearer ${created.secret}`,
              ],
            },
            (response) => {
              response.resume();
              response.once('end', () => {
                resolve(response.statusCode ?? 0);
              });
            },
          );
          call.once('error', reject);
          call.end();
        },
      );
      expect(repeatedHeaderStatus).toBe(401);
      expect(
        (await api.send('GET', `${path}/api-tokens`, { headers: bearer }))
          .statusCode,
      ).toBe(401);
      expect(
        (await api.send('GET', `${path}/members`, { headers: bearer }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await api.send('GET', `${path}/workflows`, {
            browser,
            headers: bearer,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await api.send('POST', `${path}/workflows/${randomUUID()}/runs`, {
            headers: { ...bearer, 'idempotency-key': randomUUID() },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      const malformed = await api.send('GET', `${path}/workflows`, {
        browser,
        headers: { authorization: 'Bearer invalid' },
      });
      expect(malformed.statusCode).toBe(401);
      expect(malformed.headers['www-authenticate']).toContain('Bearer');
      const revoke = await api.send(
        'POST',
        `${path}/api-tokens/${created.token.id}/revoke`,
        { browser, headers: { 'idempotency-key': randomUUID() }, payload: {} },
      );
      expect(revoke.statusCode).toBe(200);
      expect(
        apiTokenRevokeResponseSchema.parse(revoke.json()).token.status,
      ).toBe('revoked');
      expect(
        (await api.send('GET', `${path}/workflows`, { headers: bearer }))
          .statusCode,
      ).toBe(401);
    });
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
      expect(
        workflowPublishResponseSchema.parse(replay.json()).version.id,
      ).toBe(versionId);
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
      expect(
        workflowRunStartResponseSchema.parse(other.json()).run.id,
      ).not.toBe(started.run.id);
      const weakKey = createHash('sha256')
        .update(
          canonicalJson({ kind: 'api_key', tokenId: first.token.id, key }),
        )
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
      const preview = await api.send(
        'POST',
        `${base}/workflows/import/preview`,
        {
          headers,
          payload: { manifest, bindings: [] },
        },
      );
      expect(preview.statusCode).toBe(200);
      const reviewed = workflowImportPreviewResponseSchema.parse(
        preview.json(),
      );
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
      expect(
        workflowImportResponseSchema.parse(repeated.json()).workflowId,
      ).toBe(copy.workflowId);
      expect(
        (
          await api.send(
            'GET',
            `${base}/workflows/${copy.workflowId}/versions`,
            {
              headers,
            },
          )
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
    });
  },
);

describe.runIf(betterAuthIntegrationEnabled)(
  'disabled automation availability',
  () => {
    const api = useBetterAuthRealApi('tokens_disabled');
    it('keeps metadata visible and explains disabled creation and authentication', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Disabled automation',
          slug: `off-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const base = `/v1/workspaces/${workspaceId}`;
      const listed = await api.send('GET', `${base}/api-tokens`, { browser });
      expect(listed.statusCode).toBe(200);
      expect(apiTokenListResponseSchema.parse(listed.json())).toMatchObject({
        enabled: false,
        items: [],
      });
      const issued = await api.send('POST', `${base}/api-tokens`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Not issued', scopes: ['run:read'] },
      });
      expect(issued.statusCode).toBe(503);
      expect(issued.json<{ code: string; detail: string }>()).toMatchObject({
        code: 'api_token.unavailable',
        detail: 'Automation tokens are disabled on this server.',
      });
      const synthetic = `ptx_1.${workspaceId}.${randomUUID()}.${'A'.repeat(43)}`;
      const authenticated = await api.send('GET', `${base}/workflows`, {
        headers: { authorization: `Bearer ${synthetic}` },
      });
      expect(authenticated.statusCode).toBe(503);
      expect(authenticated.json<{ code: string }>().code).toBe(
        'api_token.unavailable',
      );
      const count = await api
        .database()
        .query<{ count: number }>(
          'select count(*)::int count from app.api_tokens where workspace_id=$1',
          [workspaceId],
        );
      expect(count.rows[0]?.count).toBe(0);
    });
  },
);
