import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  portableGraphDigest,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../lifecycle.support.js';

describe.skipIf(!workflowLifecycleIntegrationEnabled)(
  'retained workflow export over HTTP',
  () => {
    let fixture: WorkflowLifecycleApiFixture;
    beforeEach(async () => {
      fixture = await createWorkflowLifecycleApiFixture();
    });
    afterEach(() => closeWorkflowLifecycleApiFixture(fixture));

    for (const status of ['active', 'suspended'] as const) {
      it.each(['draft', 'version'] as const)(
        `exports the exact reviewed archived %s in a ${status} workspace without restoring admission`,
        async (kind) => {
          let owner = await fixture.login('owner');
          const { application, workspaceId, ids } = fixture;
          const base = `/v1/workspaces/${workspaceId}/workflows/${ids.published}`;
          const draft = await application.inject({
            method: 'GET',
            url: `${base}/draft`,
            headers: { cookie: owner.cookieHeader },
          });
          expect(draft.statusCode, draft.body).toBe(200);
          const versions = await application.inject({
            method: 'GET',
            url: `${base}/versions?limit=10`,
            headers: { cookie: owner.cookieHeader },
          });
          expect(versions.statusCode, versions.body).toBe(200);
          const version = versions
            .json<{ items: { id: string; graph: WorkflowGraph }[] }>()
            .items.find((item) => item.id === ids.publishedVersion);
          if (version === undefined)
            throw new Error('Expected a retained published version');
          const graph =
            kind === 'draft'
              ? draft.json<{ graph: WorkflowGraph }>().graph
              : version.graph;
          const payload = {
            source:
              kind === 'draft' ? { kind } : { kind, versionId: version.id },
            reviewedGraphDigest: await portableGraphDigest(graph),
          };
          const exportSaved = () =>
            application.inject({
              method: 'POST',
              url: `${base}/export`,
              headers: mutationHeaders(owner, {
                'if-match': String(draft.headers.etag),
              }),
              payload,
            });
          const control = await exportSaved();
          expect(control.statusCode, control.body).toBe(200);
          const archived = await application.inject({
            method: 'POST',
            url: `${base}/archive`,
            headers: mutationHeaders(owner),
            payload: { expectedLifecycleRevision: 1 },
          });
          expect(archived.statusCode, archived.body).toBe(202);
          if (status === 'suspended') {
            await fixture.setWorkspaceStatus(status);
            owner = await fixture.login('owner');
          }
          const lifecycle = await fixture.readLifecycle(ids.published);
          const history = await fixture.readHistory(ids.published);
          const exported = await exportSaved();
          expect(exported.statusCode, exported.body).toBe(200);
          expect(exported.json()).toEqual(control.json());
          expect(exported.headers['content-disposition']).toBe(
            'attachment; filename="workflow.pertexo.json"',
          );
          expect(exported.headers['cache-control']).toBe('private, no-store');
          expect(await fixture.readLifecycle(ids.published)).toEqual(lifecycle);
          expect(await fixture.readHistory(ids.published)).toEqual(history);
          if (status === 'suspended') {
            const refused = await application.inject({
              method: 'POST',
              url: `/v1/workspaces/${workspaceId}/workflows/import/preview`,
              headers: mutationHeaders(owner),
              payload: { manifest: control.json<unknown>(), bindings: [] },
            });
            expect(refused.statusCode, refused.body).toBe(404);
          }
        },
      );
    }
  },
);
