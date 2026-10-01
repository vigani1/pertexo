import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  workflowRetainedExecutableChecksum,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model/graph';
import {
  workflowInputCaseCommandResponseSchema,
  workflowInputCaseResponseSchema,
  workflowInputCaseListResponseSchema,
} from '@pertexo/contracts/workflow-authoring';
import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
} from '../support/better-auth-real-api.integration.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'authenticated bounded manual run-input case HTTP commands',
  () => {
    const api = useBetterAuthRealApi('workflow_input_cases');
    async function fixture() {
      // This pool is exclusively the disposable test database owned by this fixture.
      await api
        .database()
        .query(
          'update app.workflow_input_case_rollout set enabled=true where singleton',
        );
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const owner = await api.signIn(email);
      const actorId = (
        await api.send('GET', '/v1/users/me', { browser: owner })
      ).json<{ id: string }>().id;
      const created = await api.send('POST', '/v1/workspaces', {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Input case proof',
          slug: `cases-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const workflow = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/workflows`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Synthetic input workflow' },
        },
      );
      expect(workflow.statusCode, workflow.payload).toBe(201);
      const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
        .id;
      const versionId = randomUUID();
      const graph = {
        schemaVersion: 1 as const,
        nodes: [],
        edges: [],
        settings: {},
      };
      const checksum = workflowRetainedExecutableChecksum(
        parseWorkflowGraphDraft(graph),
      );
      // Retained version fixture only; the independent browser qualification publishes and executes a pure-node workflow.
      await api
        .database()
        .query(
          'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,schema_version,graph_json,checksum,published_by) values($1,$2,$3,1,1,$4::jsonb,$5,$6)',
          [
            versionId,
            workspaceId,
            workflowId,
            JSON.stringify(graph),
            checksum,
            actorId,
          ],
        );
      await api
        .database()
        .query('update app.workflows set published_version_id=$2 where id=$1', [
          workflowId,
          versionId,
        ]);
      return {
        owner,
        actorId,
        workspaceId,
        workflowId,
        versionId,
        route: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/input-cases`,
      };
    }
    it('creates once, pages metadata, loads current JSON, CAS edits and recovers deletion without resurrecting', async () => {
      const { owner, route, versionId, workspaceId } = await fixture();
      const key = randomUUID();
      const payload = {
        workflowVersionId: versionId,
        name: ' Synthetic only ',
        input: { n: 1, text: '🧪' },
      };
      const responses = await Promise.all([
        api.send('POST', route, {
          browser: owner,
          headers: { 'idempotency-key': key },
          payload,
        }),
        api.send('POST', route, {
          browser: owner,
          headers: { 'idempotency-key': key },
          payload,
        }),
      ]);
      responses.forEach((response) => {
        expect(response.statusCode, response.payload).toBe(201);
      });
      const result = workflowInputCaseCommandResponseSchema.parse(
        responses[0].json(),
      );
      expect(responses[1].json()).toMatchObject({
        caseId: result.caseId,
        revision: 1,
      });
      const itemRoute = `${route}/${result.caseId}`;
      const loaded = await api.send('GET', itemRoute, { browser: owner });
      expect(loaded.statusCode, loaded.payload).toBe(200);
      const current = workflowInputCaseResponseSchema.parse(loaded.json()).case;
      expect(current).toMatchObject({
        name: 'Synthetic only',
        workflowVersionId: versionId,
        input: payload.input,
      });
      expect(loaded.headers.etag).toBe(current.representationTag);
      expect(loaded.headers['cache-control']).toBe('private, no-store');
      const list = await api.send('GET', `${route}?limit=1`, {
        browser: owner,
      });
      expect(list.statusCode, list.payload).toBe(200);
      expect(
        workflowInputCaseListResponseSchema.parse(list.json()).items,
      ).toHaveLength(1);
      expect(list.payload).not.toContain('🧪');
      const headers = {
        'idempotency-key': randomUUID(),
        'if-match': current.representationTag,
      };
      const updated = await api.send('PUT', itemRoute, {
        browser: owner,
        headers,
        payload: { name: 'Edited synthetic', input: [2] },
      });
      expect(updated.statusCode, updated.payload).toBe(200);
      expect(
        await api
          .send('PUT', itemRoute, {
            browser: owner,
            headers,
            payload: { name: 'Edited synthetic', input: [2] },
          })
          .then((reply) => reply.json<unknown>()),
      ).toMatchObject({ caseId: result.caseId, revision: 2, replayed: true });
      expectProblem(
        await api.send('PUT', itemRoute, {
          browser: owner,
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { name: 'Stale', input: [] },
        }),
        412,
        'workflow.input_case_revision_conflict',
      );
      const fresh = workflowInputCaseResponseSchema.parse(
        (await api.send('GET', itemRoute, { browser: owner })).json(),
      ).case;
      const deleteHeaders = {
        'idempotency-key': randomUUID(),
        'if-match': fresh.representationTag,
      };
      const deleted = await api.send('DELETE', itemRoute, {
        browser: owner,
        headers: deleteHeaders,
      });
      expect(deleted.statusCode, deleted.payload).toBe(200);
      expectProblem(
        await api.send('GET', itemRoute, { browser: owner }),
        404,
        'resource.not_found',
      );
      expect(
        (
          await api.send('DELETE', itemRoute, {
            browser: owner,
            headers: deleteHeaders,
          })
        ).json(),
      ).toMatchObject({ caseId: result.caseId, revision: 3, replayed: true });
      expect(
        (
          await api.send('POST', route, {
            browser: owner,
            headers: { 'idempotency-key': key },
            payload,
          })
        ).json(),
      ).toMatchObject({ caseId: result.caseId, revision: 1, replayed: true });
      expectProblem(
        await api.send('GET', itemRoute, { browser: owner }),
        404,
        'resource.not_found',
      );
      const receipts = await api
        .database()
        .query(
          'select request_hash,case_id,revision from app.workflow_input_case_receipts where workspace_id=$1',
          [workspaceId],
        );
      expect(receipts.rows).toHaveLength(3);
      const audit = await api
        .database()
        .query(
          "select metadata from app.audit_events where workspace_id=$1 and target_type='workflow_input_case'",
          [workspaceId],
        );
      expect(audit.rows).toHaveLength(3);
      expect(JSON.stringify(audit.rows)).not.toContain('Synthetic');
      expect(JSON.stringify(audit.rows)).not.toContain('🧪');
    });
    it('requires session, CSRF, one key and exact validators with strict JSON/version input', async () => {
      const { owner, route, versionId } = await fixture();
      const payload = { workflowVersionId: versionId, name: 'x', input: {} };
      expectProblem(await api.send('GET', route), 401, 'auth.unauthenticated');
      expectProblem(
        await api.send('POST', route, {
          headers: { cookie: owner.cookie, 'idempotency-key': randomUUID() },
          payload,
        }),
        403,
        'auth.forbidden',
      );
      for (const bad of [
        { ...payload, input: 'x'.repeat(65_535) },
        { ...payload, name: ' ' },
        { ...payload, pins: [] },
        { ...payload, workflowVersionId: randomUUID() },
      ]) {
        const response = await api.send('POST', route, {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: bad,
        });
        expectProblem(
          response,
          'pins' in bad || bad.name === ' ' || typeof bad.input === 'string'
            ? 400
            : 404,
          'pins' in bad || bad.name === ' ' || typeof bad.input === 'string'
            ? 'request.invalid'
            : 'resource.not_found',
        );
      }
      expectProblem(
        await api.send('POST', route, {
          browser: owner,
          headers: { 'idempotency-key': 'one,two' },
          payload,
        }),
        400,
        'request.invalid',
      );
      const created = await api.send('POST', route, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload,
      });
      expect(created.statusCode, created.payload).toBe(201);
      const itemRoute = `${route}/${workflowInputCaseCommandResponseSchema.parse(created.json()).caseId}`;
      const readable = await api.send('GET', itemRoute, { browser: owner });
      const tag = workflowInputCaseResponseSchema.parse(readable.json()).case
        .representationTag;
      for (const name of ['\u0000', '\ud800', '\udc00']) {
        expectProblem(
          await api.send('POST', route, {
            browser: owner,
            headers: { 'idempotency-key': randomUUID() },
            payload: { ...payload, name },
          }),
          400,
          'request.invalid',
        );
        expectProblem(
          await api.send('PUT', itemRoute, {
            browser: owner,
            headers: { 'idempotency-key': randomUUID(), 'if-match': tag },
            payload: { name, input: {} },
          }),
          400,
          'request.invalid',
        );
      }
      expectProblem(
        await api.send('DELETE', itemRoute, {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
        }),
        428,
        'request.precondition_required',
      );
      for (const tag of ['*', 'W/"weak"', '"one","two"'])
        expectProblem(
          await api.send('DELETE', itemRoute, {
            browser: owner,
            headers: { 'idempotency-key': randomUUID(), 'if-match': tag },
          }),
          400,
          'request.invalid',
        );
      expectProblem(
        await api.send('GET', `${route}?after=bad!`, { browser: owner }),
        400,
        'request.invalid',
      );
    });
    it('separates authoring roles from run roles and denies recovery after current membership revocation', async () => {
      const { owner, route, workspaceId, versionId } = await fixture();
      for (const role of ['admin', 'builder', 'operator', 'viewer'] as const) {
        const email = `${randomUUID()}@example.test`;
        await api.signUp(email, '/login?verified=true');
        const member = await api.signIn(email);
        const userId = (
          await api.send('GET', '/v1/users/me', { browser: member })
        ).json<{ id: string }>().id;
        await api
          .database()
          .query(
            "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
            [workspaceId, userId, role],
          );
        expect(
          (await api.send('GET', route, { browser: member })).statusCode,
        ).toBe(200);
        const key = randomUUID();
        const payload = {
          workflowVersionId: versionId,
          name: `${role} synthetic`,
          input: null,
        };
        const command = {
          browser: member,
          headers: { 'idempotency-key': key },
          payload,
        };
        const created = await api.send('POST', route, command);
        if (role === 'admin' || role === 'builder') {
          expect(created.statusCode, created.payload).toBe(201);
          await api
            .database()
            .query(
              "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
              [workspaceId, userId],
            );
          expectProblem(
            await api.send('POST', route, command),
            404,
            'resource.not_found',
          );
          expectProblem(
            await api.send('GET', route, { browser: member }),
            404,
            'resource.not_found',
          );
          expect(
            (
              await api.send(
                'GET',
                `${route}/${workflowInputCaseCommandResponseSchema.parse(created.json()).caseId}`,
                { browser: owner },
              )
            ).statusCode,
          ).toBe(200);
        } else expectProblem(created, 404, 'resource.not_found');
      }
    });
    it('fails closed before rollout enablement and for foreign workflow/version identifiers', async () => {
      const { owner, route, versionId, workspaceId, workflowId } =
        await fixture();
      await api
        .database()
        .query(
          'update app.workflow_input_case_rollout set enabled=false where singleton',
        );
      expectProblem(
        await api.send('GET', route, { browser: owner }),
        503,
        'workflow.input_cases_unavailable',
      );
      expectProblem(
        await api.send('POST', route, {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { workflowVersionId: versionId, name: 'x', input: {} },
        }),
        503,
        'workflow.input_cases_unavailable',
      );
      await api
        .database()
        .query(
          'update app.workflow_input_case_rollout set enabled=true where singleton',
        );
      expectProblem(
        await api.send(
          'GET',
          `/v1/workspaces/${randomUUID()}/workflows/${workflowId}/input-cases`,
          { browser: owner },
        ),
        404,
        'resource.not_found',
      );
      expectProblem(
        await api.send(
          'GET',
          `/v1/workspaces/${workspaceId}/workflows/${randomUUID()}/input-cases`,
          { browser: owner },
        ),
        404,
        'resource.not_found',
      );
    });
  },
);
