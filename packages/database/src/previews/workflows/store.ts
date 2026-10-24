import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.js';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { cancelInTransaction } from '../../runs/runs.repository.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { WorkflowTestError, type WorkflowTestStore } from './contract.js';
import {
  loadTestSnapshot,
  sameTestSamples,
  saveTestSnapshot,
} from './snapshot.js';
import { withTestAuthority, withTestRead } from './authority.js';
import {
  requireNoActiveSuite,
  requireNoActiveTest,
  admitTestRun,
} from './admit.js';
import { readTestDetail, listTests } from './read.js';

export function createWorkflowTestStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestStore {
  const transact = <T>(
    input: SampleScope,
    work: (client: PoolClient) => Promise<T>,
  ) => withTestAuthority(pool, input, work);
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
          await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('connection:use'),
          });
        await requireNoActiveSuite(client, input);
        await requireNoActiveTest(client, input);
        await requireWorkflowCallTargets(client, input, snapshot.graph);
        await requireConnectionBindings(client, input, snapshot.graph);
        await lockArtifactReferences(
          client,
          input.workspaceId,
          snapshot.graph,
          input.actorId,
        );
        await lockArtifactReferences(
          client,
          input.workspaceId,
          input.request.input,
          input.actorId,
        );
        const accepted = await admitTestRun(client, {
          ...input,
          runId,
          snapshotId: runId,
          input: input.request.input,
          initialCheckpoint: snapshot.compiled.initialCheckpoint(runId),
          deadlineAt: new Date(
            snapshot.now.getTime() +
              Math.min(
                5 * 60 * 1000,
                snapshot.graph.settings.maxRunDurationMs ?? 5 * 60 * 1000,
              ),
          ),
          command: {
            scope: `test:${input.actorId}:${input.workflowId}`,
            key: input.idempotencyKey,
            request: input.request,
          },
        });
        await saveTestSnapshot(client, input, {
          id: runId,
          snapshot,
          expiresAt: new Date(
            accepted.acceptedAt.getTime() + TEST_RUN_RETENTION_MILLIS,
          ),
        });
        const result = { runId };
        await completeCommand(client, command, result);
        return result;
      }),
    list: (input) =>
      withTestRead(pool, input, (client) => listTests(client, input)),
    get: (input) =>
      withTestRead(pool, input, (client) => readTestDetail(client, input)),
    cancel: (input) =>
      transact(input, async (client) => {
        const test = await readTestDetail(client, input);
        if (!['queued', 'running', 'waiting'].includes(test.status)) return;
        await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability('run:cancel'),
        });
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
