import { randomUUID } from 'node:crypto';
import {
  portableGraphDigest,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { expect } from 'vitest';
import {
  workflowImportPreviewResponseSchema,
  workflowImportResponseSchema,
} from '@pertexo/contracts';
import type { createAutomationApiFixture } from '../fixture.js';
import type { TokenWorkspace } from './contract.js';

export async function qualifyReviewedPortability(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
  evidence: TokenWorkspace,
) {
  const { api } = caseFixture;
  const { base, workflowId, saved, draft, headers, workspaceId } = evidence;
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

  return { copy };
}
