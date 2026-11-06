import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  publicOpenApiDocument,
  workflowPortabilityOpenApiDocument,
} from '@pertexo/contracts/server';
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
  'workflow export OpenAPI response conformance',
  () => {
    let fixture: WorkflowLifecycleApiFixture;
    beforeEach(async () => {
      fixture = await createWorkflowLifecycleApiFixture();
    });
    afterEach(() => closeWorkflowLifecycleApiFixture(fixture));
    it('documents the real stale-draft response and rejects undeclared extensions', async () => {
      const owner = await fixture.login('owner');
      const base = `/v1/workspaces/${fixture.workspaceId}/workflows/${fixture.ids.published}`;
      const draft = await fixture.application.inject({
        method: 'GET',
        url: `${base}/draft`,
        headers: { cookie: owner.cookieHeader },
      });
      expect(draft.statusCode, draft.body).toBe(200);
      const graph = draft.json<{ graph: WorkflowGraph }>().graph;
      const exportInput = {
        source: { kind: 'draft' },
        reviewedGraphDigest: await portableGraphDigest(graph),
      };
      const exported = await fixture.application.inject({
        method: 'POST',
        url: `${base}/export`,
        headers: mutationHeaders(owner, {
          'if-match': String(draft.headers.etag),
        }),
        payload: exportInput,
      });
      expect(exported.statusCode, exported.body).toBe(200);
      const save = await fixture.application.inject({
        method: 'PUT',
        url: `${base}/draft`,
        headers: mutationHeaders(owner, {
          'if-match': String(draft.headers.etag),
        }),
        payload: { graph },
      });
      expect(save.statusCode, save.body).toBe(200);
      expect(save.json<{ revision: number }>().revision).toBe(
        draft.json<{ revision: number }>().revision + 1,
      );
      const conflict = await fixture.application.inject({
        method: 'POST',
        url: `${base}/export`,
        headers: mutationHeaders(owner, {
          'if-match': String(draft.headers.etag),
        }),
        payload: exportInput,
      });
      expect(conflict.statusCode, conflict.body).toBe(412);
      const body = conflict.json<{
        currentRevision: number;
        currentEtag: string;
      }>();
      expect(body).toMatchObject({
        currentRevision: save.json<{ revision: number }>().revision,
        currentEtag: save.headers.etag,
      });
      expect(conflict.headers.etag).toBe(save.headers.etag);
      const validator = new Ajv2020({ strict: false, validateFormats: false });
      for (const document of [
        workflowPortabilityOpenApiDocument,
        publicOpenApiDocument,
      ]) {
        const success = validator.compile({
          components: document.components,
          $ref: '#/components/schemas/WorkflowPortableManifest',
        });
        expect(success(exported.json()), JSON.stringify(success.errors)).toBe(
          true,
        );
        const validate = validator.compile({
          components: document.components,
          $ref: '#/components/responses/PreconditionFailed/content/application~1problem+json/schema',
        });
        expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...body, undeclared: true })).toBe(false);
      }
    });
  },
);
