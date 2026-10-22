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
