import { randomUUID } from 'node:crypto';
import { parseArtifactStoreConfig } from '@pertexo/artifact-store';
import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'artifact finalization authority',
  () => {
    const api = useBetterAuthRealApi('artifact_finalize_authority', {
      artifacts: parseArtifactStoreConfig(),
    });

    it('hides a restricted workflow file from builders on read, download and finalize, and never finalizes internal files', async () => {
      const email = `artifact-owner-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const created = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          name: 'Private files',
          slug: `files-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const { id: workspaceId } = created.json<{ id: string }>();
      const builderEmail = `artifact-builder-${randomUUID()}@example.test`;
      await api.signUp(builderEmail, '/workspaces');
      const builder = await api.signIn(builderEmail);
      await api.database().query(
        `insert into app.workspace_memberships(workspace_id,user_id,role)
       select $1,id,'builder' from app.users where email=$2`,
        [workspaceId, builderEmail],
      );
      const workflow = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/workflows`,
        {
          browser,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: { name: 'Private file source' },
        },
      );
      expect(workflow.statusCode, workflow.payload).toBe(201);
      const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
        .id;
      const folderId = randomUUID();
      const artifactId = randomUUID();
      const seed = await api.database().connect();
      try {
        await seed.query('begin');
        await seed.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await seed.query(
          `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at)
         values($1,$2,'node-output',$3,'application/json',17,$4,'available',clock_timestamp()+interval '1 day',clock_timestamp())`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'a'.repeat(64),
          ],
        );
        await seed.query(
          `insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode)
         values($1,$2,'Private','private','restricted')`,
          [workspaceId, folderId],
        );
        await seed.query(
          `insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id)
         values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id`,
          [workspaceId, workflowId, folderId],
        );
        await seed.query(
          'update app.workflow_drafts set graph_json=$3::json where workspace_id=$1 and workflow_id=$2',
          [
            workspaceId,
            workflowId,
            JSON.stringify({
              edges: [],
              settings: {},
              nodes: [
                {
                  id: 'file-source',
                  definition: { key: 'core.set', version: 1 },
                  position: { x: 0, y: 0 },
                  configVersion: 1,
                  config: {
                    file: {
                      kind: 'artifact',
                      artifactId,
                      byteLength: 17,
                      mediaType: 'application/json',
                      sha256: 'a'.repeat(64),
                    },
                  },
                  inputMappings: {},
                  connectionRefs: {},
                },
              ],
            }),
          ],
        );
        await seed.query('commit');
      } catch (error) {
        await seed.query('rollback');
        throw error;
      } finally {
        seed.release();
      }
      const path = `/v1/workspaces/${workspaceId}/artifacts/${artifactId}`;
      expect((await api.send('GET', path, { browser })).statusCode).toBe(200);
      expect(
        (await api.send('GET', path, { browser: builder })).statusCode,
      ).toBe(404);
      expect(
        (await api.send('GET', `${path}/download`, { browser: builder }))
          .statusCode,
      ).toBe(404);
      const publicWorkflow = await api.send(
        'POST',
        `/v1/workspaces/${workspaceId}/workflows`,
        {
          browser: builder,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: { name: 'Business data preview' },
        },
      );
      expect(publicWorkflow.statusCode, publicWorkflow.payload).toBe(201);
      const publicWorkflowId = publicWorkflow.json<{
        workflow: { id: string };
      }>().workflow.id;
      const publicDraft = `/v1/workspaces/${workspaceId}/workflows/${publicWorkflowId}/draft`;
      const saved = await api.send('PUT', publicDraft, {
        browser: builder,
        headers: {
          'Idempotency-Key': randomUUID(),
          'if-match': String(publicWorkflow.headers.etag),
        },
        payload: {
          graph: {
            edges: [],
            settings: {},
            nodes: [
              {
                id: 'business',
                definition: { key: 'core.set', version: 1 },
                position: { x: 0, y: 0 },
                configVersion: 1,
                config: {},
                connectionRefs: {},
                inputMappings: {
                  payload: { kind: 'run_input', path: '$.payload' },
                },
              },
            ],
          },
        },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      const testNode = (value: object) =>
        api.send('POST', `${publicDraft}/nodes/business/test`, {
          browser: builder,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: {
            mode: 'test_execute',
            expectedRevision: 2,
            acknowledgeSideEffects: true,
            input: { kind: 'manual', value: { payload: value } },
          },
        });
      const descriptor = await testNode({
        kind: 'artifact',
        artifactId,
        byteLength: 17,
        mediaType: 'application/json',
        sha256: 'a'.repeat(64),
      });
      expect(descriptor.statusCode, descriptor.payload).toBe(400);
      expect(descriptor.json()).toMatchObject({ code: 'request.invalid' });
      const incidental = await testNode({
        ordinaryBusinessData: { artifactId },
      });
      expect(incidental.statusCode, incidental.payload).toBe(202);
      const persisted = await api
        .database()
        .query<{ input_ref: unknown }>(
          'select input_ref from app.preview_runs where workflow_id=$1',
          [publicWorkflowId],
        );
      expect(persisted.rows).toEqual([
        {
          input_ref: {
            kind: 'inline',
            value: { payload: { ordinaryBusinessData: { artifactId } } },
          },
        },
      ]);
      const refusedDownload = await api.send('GET', `${path}/download`, {
        browser: builder,
      });
      expect(refusedDownload.statusCode, refusedDownload.payload).toBe(404);
      expect(refusedDownload.json()).toMatchObject({
        code: 'resource.not_found',
      });
      const masked = await api.send('PUT', publicDraft, {
        browser: builder,
        headers: {
          'Idempotency-Key': randomUUID(),
          'if-match': String(saved.headers.etag),
        },
        payload: {
          graph: {
            edges: [],
            settings: {},
            nodes: [
              {
                id: 'business',
                definition: { key: 'core.set', version: 1 },
                position: { x: 0, y: 0 },
                configVersion: 1,
                config: {},
                connectionRefs: {},
                inputMappings: {
                  payload: {
                    kind: 'literal',
                    value: {
                      kind: ['artifact'],
                      artifactId,
                      byteLength: null,
                      mediaType: null,
                      sha256: null,
                    },
                  },
                },
              },
            ],
          },
        },
      });
      expect(masked.statusCode, masked.payload).toBe(200);
      for (const target of [path, `${path}/download`]) {
        const hiddenFile = await api.send('GET', target, { browser: builder });
        expect(hiddenFile.statusCode, hiddenFile.payload).toBe(404);
        expect(hiddenFile.json()).toMatchObject({ code: 'resource.not_found' });
      }
      const hidden = await api.send('POST', `${path}/finalize`, {
        browser: builder,
        payload: {},
      });
      expect(hidden.statusCode, hidden.payload).toBe(404);
      const internal = await api.send('POST', `${path}/finalize`, {
        browser,
        payload: {},
      });
      expect(internal.statusCode, internal.payload).toBe(404);
    });
  },
);
