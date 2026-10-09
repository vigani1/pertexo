import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { z } from 'zod';
import { connectionResponseSchema } from '@pertexo/contracts/schemas/connections';
import { workspaceResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';
import {
  workflowDraftResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import type { useBetterAuthRealApi } from './better-auth-real-api.integration.support.js';
import { executeCuratedTemplateGraphs } from './curated-template-worker-evidence.js';
import { executeCuratedTemplateTriggers } from './curated-template-trigger-evidence.js';

export const curatedTemplateBrowserEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  importedWorkflowIds: z.array(z.uuid()).length(3),
  editedWorkflowId: z.uuid(),
  duplicateWorkflowId: z.uuid(),
  reimportedWorkflowId: z.uuid(),
});

/** Requires root's attested owned API and synthetic-only encrypted credential runtime.
 * No connection test/provider call, run/publication or cohort activation occurs here.
 */
export async function prepareCuratedTemplateBrowserFixture(
  api: ReturnType<typeof useBetterAuthRealApi>,
  webOrigin: string,
  beforeBrowser: () => Promise<void>,
) {
  const email = `curated-${randomUUID()}@integration.test`;
  await api.signUp(email, '/workspaces');
  const browser = await api.signIn(email);
  const created = await api.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'Idempotency-Key': randomUUID() },
    payload: {
      name: 'Owned curated examples',
      slug: `curated-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(created.statusCode).toBe(201);
  const workspaceId = workspaceResponseSchema.parse(created.json()).id;
  const destinationConnections: Record<string, string> = {};
  for (const [providerKey, name, credential] of [
    [
      'http',
      'F06 controlled HTTP account',
      {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Authorization: 'Bearer f06-synthetic-fixture-only' },
      },
    ],
    [
      'slack',
      'F06 controlled Slack account',
      {
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: 'xoxb-f06-synthetic-fixture-only',
      },
    ],
  ] as const) {
    const response = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/connections`,
      {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: { providerKey, name, credential },
      },
    );
    expect(response.statusCode).toBe(201);
    destinationConnections[providerKey] = connectionResponseSchema.parse(
      response.json(),
    ).id;
  }
  await beforeBrowser();
  const cookies = browser.cookie.split(';').map((part) => {
    const index = part.indexOf('=');
    return {
      name: part.slice(0, index).trim(),
      value: part.slice(index + 1).trim(),
      url: webOrigin,
    };
  });
  const scope = {
    workspaceId,
    destinationConnections,
    httpEndpoint: 'https://f06-controlled.example.test/result',
    slackChannel: 'CF06QUALIFY',
    cookies,
  };
  return {
    scope,
    executeTriggers(
      evidence: z.infer<typeof curatedTemplateBrowserEvidenceSchema>,
      apiOrigin: string,
    ) {
      expect(evidence.workspaceId).toBe(workspaceId);
      return executeCuratedTemplateTriggers(
        api,
        browser,
        workspaceId,
        evidence.importedWorkflowIds,
        apiOrigin,
      );
    },
    executeGraphs(
      evidence: z.infer<typeof curatedTemplateBrowserEvidenceSchema>,
    ) {
      expect(evidence.workspaceId).toBe(workspaceId);
      return executeCuratedTemplateGraphs(
        api,
        browser,
        workspaceId,
        evidence.importedWorkflowIds,
      );
    },
    async verifyEvidence(
      evidence: z.infer<typeof curatedTemplateBrowserEvidenceSchema>,
    ) {
      expect(evidence.workspaceId).toBe(workspaceId);
      expect(
        new Set([
          ...evidence.importedWorkflowIds,
          evidence.duplicateWorkflowId,
          evidence.reimportedWorkflowId,
        ]).size,
      ).toBe(5);
      const origins = [];
      for (const [index, id] of evidence.importedWorkflowIds.entries()) {
        const response = await api.send(
          'GET',
          `/v1/workspaces/${workspaceId}/workflows/${id}?include=templateOrigin`,
          { browser },
        );
        expect(response.statusCode).toBe(200);
        const snapshot = workflowTemplateOriginProjectionResponseSchema.parse(
          response.json(),
        );
        const descriptor = CURATED_WORKFLOW_TEMPLATES[index];
        if (descriptor === undefined)
          throw new Error('Missing reviewed template descriptor');
        expect(snapshot.templateOrigin).toMatchObject({
          schemaVersion: 1,
          templateId: descriptor.templateId,
          templateVersion: descriptor.templateVersion,
          baseManifestDigest: descriptor.baseManifestDigest,
          derivation: 'direct',
        });
        origins.push(snapshot.templateOrigin);
      }
      expect(evidence.editedWorkflowId).toBe(evidence.importedWorkflowIds[0]);
      const copy = await api.send(
        'GET',
        `/v1/workspaces/${workspaceId}/workflows/${evidence.duplicateWorkflowId}?include=templateOrigin`,
        { browser },
      );
      expect(copy.statusCode).toBe(200);
      expect(
        workflowTemplateOriginProjectionResponseSchema.parse(copy.json())
          .templateOrigin,
      ).toEqual({ ...origins[0], derivation: 'inherited' });
      const reimport = await api.send(
        'GET',
        `/v1/workspaces/${workspaceId}/workflows/${evidence.reimportedWorkflowId}?include=templateOrigin`,
        { browser },
      );
      expect(reimport.statusCode).toBe(200);
      expect(
        workflowTemplateOriginProjectionResponseSchema.parse(reimport.json())
          .templateOrigin,
      ).toBeNull();
      const draft = await api.send(
        'GET',
        `/v1/workspaces/${workspaceId}/workflows/${evidence.editedWorkflowId}/draft`,
        { browser },
      );
      expect(draft.statusCode).toBe(200);
      expect(
        workflowDraftResponseSchema
          .parse(draft.json())
          .graph.nodes.find((node) => node.id === 'validate-request')?.label,
      ).toBe('Independent edited validation');
      const createdOnly = await api.database().query<{
        published_version_id: string | null;
        activation_status: string;
      }>('select published_version_id,activation_status from app.workflows where workspace_id=$1 and id=any($2::uuid[])', [workspaceId, [...evidence.importedWorkflowIds, evidence.duplicateWorkflowId, evidence.reimportedWorkflowId]]);
      expect(createdOnly.rows).toHaveLength(5);
      for (const row of createdOnly.rows)
        expect(row).toEqual({
          published_version_id: null,
          activation_status: 'inactive',
        });
      const runs = await api
        .database()
        .query(
          'select count(*)::int as count from app.workflow_runs where workspace_id=$1',
          [workspaceId],
        );
      expect(runs.rows).toEqual([{ count: 0 }]);
    },
  };
}
