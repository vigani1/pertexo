import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  portableGraphDigest,
  type WorkflowPortableManifest,
  type WorkflowImportPreviewResponse,
} from '@pertexo/contracts/workflow-portability';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  expectProblem,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
} from '../support/workflow-lifecycle.integration.support.js';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;
describeIntegration(
  'reviewed portability authenticated real HTTP and atomic command (ADR062)',
  () => {
    let fixture: WorkflowLifecycleApiFixture;
    beforeEach(async () => {
      fixture = await createWorkflowLifecycleApiFixture();
    });
    afterEach(async () => {
      await closeWorkflowLifecycleApiFixture(fixture);
    });
    async function exported() {
      const session = await fixture.login('builder');
      const base = `/v1/workspaces/${fixture.workspaceId}/workflows/${fixture.ids.unpublished}`;
      const draft = await fixture.application.inject({
        method: 'GET',
        url: `${base}/draft`,
        headers: { cookie: session.cookieHeader },
      });
      expect(draft.statusCode, draft.payload).toBe(200);
      const digest = await portableGraphDigest(
        draft.json<{ graph: WorkflowGraph }>().graph,
      );
      const response = await fixture.application.inject({
        method: 'POST',
        url: `${base}/export`,
        headers: mutationHeaders(session, {
          'if-match': String(draft.headers.etag),
        }),
        payload: { source: { kind: 'draft' }, reviewedGraphDigest: digest },
      });
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="workflow.pertexo.json"',
      );
      return {
        session,
        base,
        draft,
        digest,
        manifest: response.json<WorkflowPortableManifest>(),
      };
    }

    it('exports exact reviewed content; previews without writes; creates once and replays a retry', async () => {
      const { session, manifest } = await exported();
      const base = `/v1/workspaces/${fixture.workspaceId}/workflows/import`;
      const previewResponse = await fixture.application.inject({
        method: 'POST',
        url: `${base}/preview`,
        headers: mutationHeaders(session),
        payload: { manifest, bindings: [] },
      });
      expect(previewResponse.statusCode, previewResponse.payload).toBe(200);
      const preview = previewResponse.json<WorkflowImportPreviewResponse>();
      expect(preview).toMatchObject({
        compatible: true,
        issues: [],
        truncated: false,
        connectionSlots: [],
      });
      const command = {
        method: 'POST' as const,
        url: base,
        headers: mutationHeaders(session, {
          'idempotency-key': 'portable-concurrent',
        }),
        payload: {
          manifest,
          bindings: [],
          name: 'Independent imported workflow',
          expectedCompatibilityFingerprint: preview.compatibilityFingerprint,
        },
      };
      const responses = await Promise.all([
        fixture.application.inject(command),
        fixture.application.inject(command),
      ]);
      for (const response of responses)
        expect(response.statusCode, response.payload).toBe(201);
      const result = responses[0].json<{ workflowId: string }>();
      expect(responses[1].json()).toEqual(result);
      expect(Object.keys(result)).toEqual(['workflowId']);
      expect(responses[0].headers.location).toBe(
        `/v1/workspaces/${fixture.workspaceId}/workflows/${result.workflowId}`,
      );
      expect(await fixture.readHistory(result.workflowId)).toMatchObject({
        draft: { revision: 1, graph: manifest.graph },
        versions: [],
        runs: [],
      });
      expect(await fixture.readLifecycle(result.workflowId)).toMatchObject({
        activationStatus: 'inactive',
        publishedVersionId: null,
      });
      // A lost response has the same explicit retry transport: discover, never create again.
      expect((await fixture.application.inject(command)).json()).toEqual(
        result,
      );
      expectProblem(
        await fixture.application.inject({
          ...command,
          payload: { ...command.payload, name: 'Changed command' },
        }),
        409,
        'request.idempotency_conflict',
      );
    });

    it('enforces source tag/review digest, current preview CAS, auth/CSRF and read/create separation', async () => {
      const { session, base, draft, digest, manifest } = await exported();
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url: `${base}/export`,
          headers: mutationHeaders(session, {
            'if-match': String(draft.headers.etag),
          }),
          payload: {
            source: { kind: 'draft' },
            reviewedGraphDigest: '0'.repeat(64),
          },
        }),
        409,
        'workflow.portability_review_conflict',
      );
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url: `${base}/export`,
          headers: mutationHeaders(session),
          payload: { source: { kind: 'draft' }, reviewedGraphDigest: digest },
        }),
        428,
        'request.precondition_required',
      );
      const viewer = await fixture.login('viewer');
      expect(
        (
          await fixture.application.inject({
            method: 'POST',
            url: `${base}/export`,
            headers: mutationHeaders(viewer, {
              'if-match': String(draft.headers.etag),
            }),
            payload: { source: { kind: 'draft' }, reviewedGraphDigest: digest },
          })
        ).statusCode,
      ).toBe(200);
      const url = `/v1/workspaces/${fixture.workspaceId}/workflows/import/preview`;
      const payload = { manifest, bindings: [] };
      expectProblem(
        await fixture.application.inject({ method: 'POST', url, payload }),
        401,
        'auth.unauthenticated',
      );
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url,
          headers: { cookie: session.cookieHeader },
          payload,
        }),
        403,
        'auth.forbidden',
      );
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url,
          headers: mutationHeaders(viewer),
          payload,
        }),
        404,
        'resource.not_found',
      );
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url: url.replace('/preview', ''),
          headers: mutationHeaders(session),
          payload: {
            ...payload,
            name: 'Stale preview',
            expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'0'.repeat(64)}`,
          },
        }),
        409,
        'workflow.portability_compatibility_conflict',
      );
      const saved = await fixture.application.inject({
        method: 'PUT',
        url: `${base}/draft`,
        headers: mutationHeaders(session, {
          'if-match': String(draft.headers.etag),
        }),
        payload: { graph: draft.json<{ graph: WorkflowGraph }>().graph },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      expectProblem(
        await fixture.application.inject({
          method: 'POST',
          url: `${base}/export`,
          headers: mutationHeaders(session, {
            'if-match': String(draft.headers.etag),
          }),
          payload: { source: { kind: 'draft' }, reviewedGraphDigest: digest },
        }),
        412,
        'workflow.revision_conflict',
      );
    });

    it('rejects duplicate/deep/oversized raw import envelopes with private bounded diagnostics', async () => {
      const session = await fixture.login('builder');
      const url = `/v1/workspaces/${fixture.workspaceId}/workflows/import/preview`;
      for (const payload of [
        '{"manifest":{},"manifest":{"secret":"private-proof-value"},"bindings":[]}',
        '['.repeat(257) + '0' + ']'.repeat(257),
        '{"private-proof-key":"private-proof-value","bindings":[]}',
      ]) {
        const response = await fixture.application.inject({
          method: 'POST',
          url,
          headers: {
            ...mutationHeaders(session),
            'content-type': 'application/json',
          },
          payload,
        });
        expect(response.statusCode, response.payload).toBe(400);
        expect(response.payload).not.toContain('private-proof');
        expect(response.headers['cache-control']).toBe('private, no-store');
      }
      const oversized = await fixture.application.inject({
        method: 'POST',
        url,
        headers: {
          ...mutationHeaders(session),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ value: 'x'.repeat(2_097_152) }),
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.headers['cache-control']).toBe('private, no-store');
    });
  },
);
