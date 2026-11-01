import type { PoolClient } from 'pg';
import { canonicalJson, rolesForCapability } from '@pertexo/workflow-model';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import { lockArtifactReferences } from '../../artifacts/references/locks.repository.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';
import {
  admitTestRun,
  requireNoActiveSuite,
  requireNoActiveTest,
} from './admit.js';
import type { WorkflowTestCommand } from './contract.js';
import { WorkflowTestError } from './errors.js';
import {
  loadTestSnapshot,
  sameTestSamples,
  saveTestSnapshot,
} from './snapshot.repository.js';

export async function startWorkflowTest(
  client: PoolClient,
  input: WorkflowTestCommand,
  catalogs: AuthoringCatalogs,
): Promise<{ runId: string }> {
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
  if (snapshot.preparation.draftRevision !== input.request.expectedRevision)
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
      snapshot.preparation.effectfulSteps.map((step) => step.nodeId).sort(),
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
}
