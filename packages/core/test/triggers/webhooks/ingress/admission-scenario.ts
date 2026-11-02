import { randomUUID } from 'node:crypto';

import { webhookRunInput } from '@pertexo/nodes-core';
import { Pool } from 'pg';
import { expect } from 'vitest';

import { adminUrl, migrationBaseUrl } from '../context.js';
import {
  actorId,
  apiConfig,
  authoring,
  checkpointFactory,
  createWebhookScenario,
  hash,
  ownerQuery,
  post,
  url,
  webhook,
  workspaceId,
} from '../fixture.js';
import { openTransaction, type OpenTransaction } from './lock-holder.js';

export type Scenario = Awaited<ReturnType<typeof createWebhookScenario>>;

export const SHARE_LOCK = /for share of /iu;
export const WORKSPACE_LOCK = /lock_workspace_run_admission/iu;

export let holders: Pool;
export let apiPool: Pool;
/** Only an administrator can read another role's statements in pg_stat_activity. */
let observer: Pool;

export function openPools() {
  holders = new Pool({ connectionString: url(migrationBaseUrl), max: 8 });
  apiPool = new Pool({ connectionString: apiConfig.connectionString, max: 8 });
  observer = new Pool({ connectionString: url(adminUrl), max: 2 });
}

export async function closePools() {
  await holders.end();
  await apiPool.end();
  await observer.end();
}

export function delivery({ verification }: Scenario, label: string) {
  return {
    verification,
    verifiedSecretVersionId: verification.currentSecret.id,
    requestFingerprint: hash(`fingerprint-${label}`),
    idempotencyKeyHash: hash(`key-${label}`),
    runInput: webhookRunInput(
      verification.runInputMode,
      post({ event: label }),
    ),
    bodyBytes: 64,
    checkpointFactory,
  } as const;
}

/** What a delivery leaves behind, so a refusal can be seen to have left nothing. */
export async function traces({ verification }: Scenario, label: string) {
  const { rows } = await ownerQuery<{
    runs: number;
    deliveries: number;
    replays: number;
    queued: number;
  }>(
    `select
       (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,
       (select count(*)::int from app.webhook_trigger_deliveries where endpoint_id=$2) deliveries,
       (select count(*)::int from app.webhook_trigger_replay_records where dedupe_key_hash=$3) replays,
       (select queued_runs::int from app.workspace_execution_admission_counters where workspace_id=$4) queued`,
    [
      verification.workflowId,
      verification.endpointId,
      hash(`key-${label}`),
      workspaceId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Delivery traces are unavailable');
  return row;
}

/** A pause needs the run that caused it, so every scenario starts with one accepted. */
export async function acceptedScenario(): Promise<
  Scenario & { firstRunId: string }
> {
  const scenario = await createWebhookScenario();
  const first = await webhook.acceptVerifiedDelivery(
    delivery(scenario, `first-${randomUUID()}`),
  );
  if (!('runId' in first)) throw new Error('Expected the first run');
  return { ...scenario, firstRunId: first.runId };
}

export async function insertVersionWithoutWebhookStep(
  holder: OpenTransaction,
  { verification }: Scenario,
): Promise<string> {
  const versionId = randomUUID();
  await holder.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
     values($1,$2,$3,50,$4::jsonb,$5,'{}'::jsonb,$6)`,
    [
      versionId,
      workspaceId,
      verification.workflowId,
      JSON.stringify({ settings: {}, nodes: [], edges: [] }),
      `wf:sha256:${hash(versionId)}`,
      actorId,
    ],
  );
  return versionId;
}

/** Row security hides endpoint rows from the owner role, so those run as the app. */
export const closesAs = (app: boolean | undefined) =>
  openTransaction(app === true ? apiPool : holders, observer, workspaceId, {
    role: app === true ? undefined : 'pertexo_owner',
  });

export function touchedOneRow(result: unknown): void {
  expect(result).toMatchObject({ rowCount: 1 });
}

/**
 * Each real command, run for real. Admission's first statement also share-locks the
 * entitlement row, which none of these commands touches, so a delivery can be parked
 * there while the command commits in full.
 */
export const COMMANDS = [
  {
    name: 'archiving',
    run: ({ verification }: Scenario) =>
      authoring.transitionWorkflowLifecycle({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
  },
  {
    name: 'rotating the endpoint',
    run: ({ verification, resources }: Scenario) =>
      webhook.rotateEndpoint({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        triggerId: resources.webhookId,
        endpointKeyHash: hash(randomUUID()),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
  },
] as const;

export const holdEntitlement = async () => {
  const holder = await closesAs(false);
  touchedOneRow(
    await holder.query(
      'select 1 from app.workspace_execution_entitlements where workspace_id=$1 for update',
      [workspaceId],
    ),
  );
  return holder;
};
