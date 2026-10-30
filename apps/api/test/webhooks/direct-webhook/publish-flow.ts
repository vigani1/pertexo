import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { expect } from 'vitest';

import { issueBrowserSession } from '../support/browser-session.fixture.js';
import { sha256 } from './fixture/encryption.js';
import { reconciliation } from './fixture/lifecycle.js';
import type { seedWebhook } from './fixture.js';
import {
  apiQuery,
  application,
  authoring,
  identityRuntime,
  ownerQuery,
  sendWebhook,
} from './fixture.js';

export type Seeded = Awaited<ReturnType<typeof seedWebhook>>;
type Graph = Parameters<typeof parseWorkflowGraphDraft>[0];

export const webhookStep = {
  id: 'webhook',
  definition: { key: 'core.webhook', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
};

export function setStep(value: number) {
  return {
    id: 'apply',
    definition: { key: 'core.set', version: 1 },
    position: { x: 300, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: { value: { kind: 'literal', value } },
    connectionRefs: {},
  };
}

export function webhookThenSet(value: number) {
  return {
    settings: {},
    nodes: [webhookStep, setStep(value)],
    edges: [
      {
        id: 'webhook-apply',
        source: { nodeId: 'webhook', port: 'out' },
        target: { nodeId: 'apply', port: 'in' },
      },
    ],
  };
}

/** The validator refuses work on a saturated machine and asks for a retry, so the test retries. */
async function publishRetryingValidation<T>(attempt: () => Promise<T>) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        tries === 5 ||
        !(error instanceof AuthoringValidationUnavailableError)
      )
        throw error;
      await delay(1_000);
    }
  }
}

/** Saves and publishes through the real authoring store; the worker's reconcile stays a separate step. */
export async function publish(seeded: Seeded, graph: Graph) {
  const { actorId, workspaceId, workflowId } = seeded;
  const draft = await authoring.getDraft(workspaceId, workflowId, actorId);
  if (draft === null) throw new Error('Draft missing');
  const saved = await authoring.saveDraft({
    actorId,
    workspaceId,
    workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    }),
    expectedRevision: draft.revision,
    graphJson: parseWorkflowGraphDraft(graph),
  });
  const published = await publishRetryingValidation(() => {
    const label = randomUUID();
    return authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId,
      representationTag: workflowDraftRepresentationTag({
        workflowId,
        revision: saved.revision,
        graph: saved.graphJson,
        compatibilityFingerprint: saved.compatibility.fingerprint,
      }),
      idempotencyKey: `survives-publish-${label}`,
      requestHash: sha256(`survives-publish-${label}`),
    });
  });
  const versionId = published.version.id;
  return {
    versionId,
    /** What the worker does when it takes the publication's outbox job. */
    reconcile: async () => {
      const events = await ownerQuery<{
        id: string;
        payload_checksum: string;
      }>(
        `select id,payload_checksum from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2
             and job_name='reconcile-workflow-triggers'
             and payload::text like '%' || $3 || '%'`,
        [workspaceId, workflowId, versionId],
      );
      const event = events.rows[0];
      if (event === undefined) throw new Error('Publication outbox missing');
      await reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: versionId,
        outboxEventId: event.id,
        delivery: {
          outboxEventId: event.id,
          payloadChecksum: event.payload_checksum,
        },
      });
    },
  };
}

export async function publishAndReconcile(seeded: Seeded, graph: Graph) {
  const published = await publish(seeded, graph);
  await published.reconcile();
  return published.versionId;
}

export const deliver = (seeded: Seeded, body = '{}') =>
  sendWebhook(
    seeded.endpointKey,
    seeded.originalSecret,
    Buffer.from(body),
    randomUUID(),
  );

export async function runVersion(workspaceId: string, runId: unknown) {
  const row = await apiQuery<{ workflow_version_id: string }>(
    `select workflow_version_id from app.workflow_runs where workspace_id=$1 and id=$2`,
    [workspaceId, runId],
  );
  return row.rows[0]?.workflow_version_id;
}

export async function browser(seeded: Seeded) {
  const session = await issueBrowserSession(
    identityRuntime.dependencies.sessions,
    seeded.actorId,
  );
  return {
    session,
    triggersPath: `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers`,
  };
}

export async function listTriggers(seeded: Seeded) {
  const { session, triggersPath } = await browser(seeded);
  const response = await application.inject({
    method: 'GET',
    url: triggersPath,
    headers: { cookie: session.cookieHeader },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{
    items: {
      id: string;
      nodeId: string;
      kind: string;
      status: string;
      endpointReady: boolean;
    }[];
  }>().items;
}

export async function currentWebhookTrigger(
  seeded: Seeded,
  nodeId = 'webhook',
) {
  const items = await listTriggers(seeded);
  const live = items.filter(
    (item) => item.nodeId === nodeId && item.status !== 'disabled',
  );
  expect(live).toHaveLength(1);
  const trigger = live[0];
  if (trigger === undefined) throw new Error('Webhook trigger missing');
  return trigger;
}
