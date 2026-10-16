import { lockArtifactReferences } from '../../artifacts/references.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { cancelInTransaction } from '../../runs/runs.repository.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { databaseSchema } from '../../schema.js';
import {
  withTenantScopedClient,
  parseWorkspaceId,
} from '../../tenant-access/transactions.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '../../tenant-access/policy.js';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../../runs/commands/acceptance.js';
import { WorkflowTestError, type WorkflowTestStore } from './contract.js';
import { loadTestSnapshot, sameTestSamples } from './snapshot.js';
import { readTestDetail, listTests } from './read.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function createWorkflowTestStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestStore {
  const transact = <T>(
    input: SampleScope,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedClient(
      pool,
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (client) => {
        for (const capability of [
          'workflow:update',
          'run:read',
          'run:start',
        ] as const)
          await lockWorkflowAuthoringAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability(capability),
          );
        return work(client);
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
  return {
    prepare: (input) =>
      transact(
        input,
        async (client) =>
          (await loadTestSnapshot(client, input, catalogs)).preparation,
      ),
    start: (input) =>
      transact(input, async (client) => {
        const runId = generatePersistedId();
        const command = {
          workspaceId: input.workspaceId,
          operation: 'workflow.test.start',
          scope: `${input.actorId}:${input.workflowId}`,
          idempotencyKey: input.idempotencyKey,
        };
        const replay = await claimCommand(client, {
          ...command,
          request: input.request,
          resourceId: runId,
        });
        if (replay !== null) return replay as { runId: string };
        const snapshot = await loadTestSnapshot(client, input, catalogs);
        if (
          snapshot.preparation.draftRevision !== input.request.expectedRevision
        )
          throw new WorkflowTestError('draft_changed');
        if (
          !sameTestSamples(
            snapshot.preparation.samples,
            input.request.expectedSamples,
          )
        )
          throw new WorkflowTestError('samples_changed');
        if (
          canonicalJson([...input.request.expectedEffectfulSteps].sort()) !==
          canonicalJson(
            snapshot.preparation.effectfulSteps
              .map((step) => step.nodeId)
              .sort(),
          )
        )
          throw new WorkflowTestError('effects_changed');
        if (
          snapshot.preparation.effectfulSteps.length > 0 &&
          !input.request.acknowledgeSideEffects
        )
          throw new WorkflowTestError('effects_acknowledgement_required');
        if (snapshot.usesConnections)
          await lockWorkflowAuthoringAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('connection:use'),
          );
        const active = await client.query(
          `select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2 and started_by=$3 and trigger_type='test' and status in ('queued','running','waiting') limit 1`,
          [input.workspaceId, input.workflowId, input.actorId],
        );
        if (active.rows.length > 0)
          throw new WorkflowTestError('already_running');
        const transaction = {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(input.workspaceId),
        };
        const preparation = await prepareWorkflowRunAcceptance(
          transaction,
          input.workflowId,
        );
        await lockArtifactReferences(client, input.workspaceId, snapshot.graph);
        const accepted = await acceptWorkflowRun(
          transaction,
          {
            operation: 'workflow.run.accept',
            scope: `test:${input.actorId}:${input.workflowId}`,
            keyHash: digest(input.idempotencyKey),
            requestHash: digest(canonicalJson(input.request)),
            workflowId: input.workflowId,
            workflowVersionId: runId,
            startedBy: input.actorId,
            triggerType: 'test',
            runInput: input.request.input,
            initialCheckpoint: snapshot.compiled.initialCheckpoint(runId),
            deadlineAt: new Date(
              snapshot.now.getTime() +
                Math.min(
                  5 * 60 * 1000,
                  snapshot.graph.settings.maxRunDurationMs ?? 5 * 60 * 1000,
                ),
            ),
          },
          { ...preparation, runId, failureNotificationPolicy: undefined },
        );
        await client.query(
          `insert into app.workflow_test_snapshots(run_id,workspace_id,draft_revision,graph_json,executable_json,pins,expires_at,checksum,dispositions)
            values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb)`,
          [
            runId,
            input.workspaceId,
            snapshot.preparation.draftRevision,
            canonicalJson(snapshot.graph),
            canonicalJson(snapshot.compiled.executableJson),
            canonicalJson(snapshot.frozenPins),
            new Date(accepted.acceptedAt.getTime() + 7 * 86400000),
            snapshot.compiled.checksum,
            JSON.stringify(snapshot.compiled.dispositions),
          ],
        );
        const result = { runId };
        await completeCommand(client, command, result);
        return result;
      }),
    list: (input) => transact(input, (client) => listTests(client, input)),
    get: (input) => transact(input, (client) => readTestDetail(client, input)),
    cancel: (input) =>
      transact(input, async (client) => {
        const test = await readTestDetail(client, input);
        if (!['queued', 'running', 'waiting'].includes(test.status)) return;
        await lockWorkflowAuthoringAuthority(
          client,
          input.workspaceId,
          input.actorId,
          rolesForCapability('run:cancel'),
        );
        // The ordinary cancel command appends the fenced observation and outbox wakeup.
        const transaction = {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(input.workspaceId),
        };
        await cancelInTransaction(transaction, {
          runId: input.runId,
          actorId: input.actorId,
          workspaceId: input.workspaceId,
        });
      }),
  };
}
