import {
  signedInAccount,
  workspaceFor,
} from '../../support/better-auth/builders.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testExecutableCompiler } from '@pertexo/core/testing';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  workflowPromotionPreviewSchema,
  workflowPromotionResultSchema,
} from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'reviewed workspace promotion HTTP boundary',
  () => {
    const api = useBetterAuthRealApi('promotion');
    it('uses session and CSRF authority, validates selectors once, and applies only the reviewed draft', async () => {
      const { owner } = await signedInAccount(api);
      const user = (
        await api.send('GET', '/v1/users/me', { browser: owner })
      ).json<{ id: string }>();
      const workspace = (name: string) =>
        workspaceFor(api, owner, { name, slugPrefix: 'promotion' });
      const sourceId = await workspace('Development'),
        targetId = await workspace('Production');
      const route = `/v1/workspaces/${sourceId}/promotions`;
      expect((await api.send('GET', `${route}/settings`)).statusCode).toBe(401);
      const linked = await api.send('PUT', `${route}/settings`, {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          expectedRevision: 0,
          expectedTargetWorkspaceId: null,
          targetWorkspaceId: targetId,
        },
      });
      expect(linked.statusCode, linked.payload).toBe(200);
      const workflow = await api.send(
        'POST',
        `/v1/workspaces/${sourceId}/workflows`,
        {
          browser: owner,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Review before release' },
        },
      );
      expect(workflow.statusCode, workflow.payload).toBe(201);
      const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
        .id;
      const graph = parseWorkflowGraphDraft({
        settings: {},
        nodes: [
          {
            id: 'manual',
            definition: { key: 'core.manual', version: 1 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            position: { x: 0, y: 0 },
          },
          {
            id: 'stop',
            definition: { key: 'core.terminate', version: 1 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            position: { x: 300, y: 0 },
          },
        ],
        edges: [
          {
            id: 'link',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'stop', port: 'in' },
          },
        ],
      });
      const executable = testExecutableCompiler(graph),
        versionId = randomUUID();
      await api
        .database()
        .query(
          'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7)',
          [
            versionId,
            sourceId,
            workflowId,
            JSON.stringify(graph),
            executable.checksum,
            JSON.stringify(executable.executableJson),
            user.id,
          ],
        );
      await api
        .database()
        .query('update app.workflows set published_version_id=$2 where id=$1', [
          workflowId,
          versionId,
        ]);
      const retained = await api.send(
        'GET',
        `${route}/candidates?workflowId=${workflowId}&limit=1`,
        { browser: owner },
      );
      expect(retained.statusCode, retained.payload).toBe(200);
      expect(retained.json()).toEqual({
        items: [
          {
            workflowId,
            name: 'Review before release',
            versionId,
            versionNumber: 1,
          },
        ],
        nextCursor: null,
        nextVersionNumber: null,
      });
      expect(
        (
          await api.send(
            'GET',
            `${route}/candidates?workflowId=${workflowId}&beforeVersionNumber=1`,
            { browser: owner },
          )
        ).json(),
      ).toEqual({ items: [], nextCursor: null, nextVersionNumber: null });
      expect(
        (
          await api.send('GET', `${route}/candidates?beforeVersionNumber=1`, {
            browser: owner,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await api.send(
            'GET',
            `${route}/candidates?workflowId=${workflowId}&search=release`,
            { browser: owner },
          )
        ).statusCode,
      ).toBe(400);
      const selections = [{ workflowId, versionId }];
      const invalid = await api.send('POST', `${route}/preview`, {
        browser: owner,
        payload: { selections, mode: 'draft', graph: {} },
      });
      expect(invalid.statusCode, invalid.payload).toBe(400);
      const reviewed = await api.send('POST', `${route}/preview`, {
        browser: owner,
        payload: { selections, mode: 'draft' },
      });
      expect(reviewed.statusCode, reviewed.payload).toBe(200);
      const preview = workflowPromotionPreviewSchema.parse(reviewed.json());
      expect(preview.compatible, JSON.stringify(preview.requirements)).toBe(
        true,
      );
      const body = {
        selections,
        mode: 'draft',
        fingerprint: preview.fingerprint,
        acknowledgeTargetChanges: [],
      };
      const key = randomUUID();
      const applied = await api.send('POST', `${route}/apply`, {
        browser: owner,
        headers: { 'idempotency-key': key },
        payload: body,
      });
      expect(applied.statusCode, applied.payload).toBe(200);
      const result = workflowPromotionResultSchema.parse(applied.json());
      const replay = await api.send('POST', `${route}/apply`, {
        browser: owner,
        headers: { 'idempotency-key': key },
        payload: body,
      });
      expect(replay.statusCode, replay.payload).toBe(200);
      expect(replay.json()).toEqual({ ...result, replayed: true });
      const targetWorkflowId = result.items[0]?.targetWorkflowId;
      if (targetWorkflowId === undefined) throw new Error('Missing target');
      const draft = await api.send(
        'GET',
        `/v1/workspaces/${targetId}/workflows/${targetWorkflowId}/draft`,
        { browser: owner },
      );
      expect(draft.statusCode, draft.payload).toBe(200);
      expect(draft.json()).toMatchObject({ graph });
    });
  },
);
