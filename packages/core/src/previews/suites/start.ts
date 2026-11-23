import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import { databaseSchema } from '@pertexo/database/schema';
import {
  parseWorkspaceId,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';
import type { Role } from '@pertexo/policy';
import { canonicalJson } from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../artifacts/references/lock-references.js';
import { lockInputCaseQuota } from '../../authoring/input-cases/metadata.repository.js';

import type { WorkflowTestOptions } from '../workflows/workflow-test.types.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { TEST_RUN_RETENTION_MILLIS } from '../../shared/run-records/run-retention.repository.js';
import { requireWorkflowCallTargets } from '../../shared/resources/require-workflow-call-targets.js';
import { requireConnectionBindings } from '../../shared/resources/require-connection-bindings.js';
import { captureWorkspaceVariableRevision } from '../../variables/head.repository.js';
import {
  requireNoActiveSuite,
  requireNoActiveTest,
} from '../workflows/admit.js';
import { requireTestCapability } from '../workflows/access.js';
import { WorkflowTestError } from '../workflows/workflow-test.errors.js';
import { testRunDurationMs } from '../workflows/rules.js';
import { saveTestSnapshot } from '../workflows/snapshot.repository.js';
import { loadTestSnapshot } from '../workflows/load-snapshot.js';
import { admitSuiteCase } from './admit.js';
import { insertSuiteCases, readSuiteCase } from './cases.repository.js';
import { insertSuite } from './suite-state.repository.js';
import type { WorkflowTestSuiteStartInput } from './workflow-test-suite.types.js';
import { readSuiteCasePayloads } from './current.repository.js';
import { readSuiteCurrent } from './read-current.js';
import { assertPreparedSuite, SUITE_MAX_DURATION_MS } from './rules.js';
import { snapshotTableCases } from './evaluation/snapshot-table-cases.js';

export async function prepareTestSuite(
  client: PoolClient,
  input: WorkflowActor,
  options: WorkflowTestOptions,
  versionId?: string,
) {
  const snapshot = await loadTestSnapshot(client, input, options, versionId);
  await lockInputCaseQuota(client, input.workspaceId);
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  const variableSetRevision =
    await captureWorkspaceVariableRevision(transaction);
  const current = await readSuiteCurrent(client, input, variableSetRevision);
  return {
    snapshot,
    current,
    prepared: {
      ...current,
      effectfulSteps: snapshot.preparation.effectfulSteps,
    } satisfies WorkflowTestSuitePreparation,
  };
}
export async function startTestSuite(
  client: PoolClient,
  role: Role,
  input: WorkflowTestSuiteStartInput,
  options: WorkflowTestOptions,
): Promise<{ suiteId: string }> {
  const suiteId = generatePersistedId();
  const command = {
    workspaceId: input.workspaceId,
    operation: 'workflow.testsuite.start',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand<{ suiteId: string }>(client, {
    ...command,
    request: input.request,
    resourceId: suiteId,
  });
  if (replay !== null) return replay;
  const evaluation =
    'evaluation' in input.request ? input.request.evaluation : undefined;
  const { snapshot, current } = await prepareTestSuite(
    client,
    input,
    options,
    evaluation?.versionId,
  );
  if (evaluation !== undefined) {
    if (Object.values(snapshot.compiled.dispositions).includes('pin_required'))
      throw new WorkflowTestError('evaluation_pin_required');
    if (snapshot.compiled.effectfulNodeIds.length > 0)
      throw new WorkflowTestError('evaluation_effectful');
  }
  assertPreparedSuite(input, current, snapshot.preparation.effectfulSteps);
  if (snapshot.usesConnections) requireTestCapability(role, 'connection:use');
  await requireNoActiveSuite(client, input);
  await requireNoActiveTest(client, input);
  const cases =
    evaluation === undefined
      ? await readSuiteCasePayloads(client, input)
      : await snapshotTableCases(client, role, input.workspaceId, evaluation);
  if (evaluation === undefined && cases.length !== current.cases.length)
    throw new WorkflowTestError('cases_changed');
  for (const entry of cases) {
    if (
      entry.expectations.assertions.some(
        (assertion) =>
          assertion.source.kind === 'step' &&
          !Object.hasOwn(
            snapshot.compiled.dispositions,
            assertion.source.nodeId,
          ),
      )
    )
      throw new WorkflowTestError('case_invalid');
    await lockArtifactReferences(
      client,
      input.workspaceId,
      entry.input,
      input.actorId,
    );
  }
  await requireWorkflowCallTargets(client, input, snapshot.graph);
  await requireConnectionBindings(client, input, snapshot.graph);
  await lockArtifactReferences(
    client,
    input.workspaceId,
    snapshot.graph,
    input.actorId,
  );
  const snapshotId = generatePersistedId();
  await saveTestSnapshot(client, input, {
    id: snapshotId,
    snapshot,
    expiresAt: new Date(snapshot.now.getTime() + TEST_RUN_RETENTION_MILLIS),
  });
  const suite = await insertSuite(client, {
    id: suiteId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    startedBy: input.actorId,
    snapshotId,
    signature: current.signature,
    evaluationTableId: evaluation?.tableId ?? null,
    evaluationVersionId: evaluation?.versionId ?? null,
    variableSetRevision: current.variableSetRevision,
    usesConnections: snapshot.usesConnections,
    caseDurationMs: testRunDurationMs(snapshot.graph.settings.maxRunDurationMs),
    initialCheckpointJson: JSON.stringify(
      snapshot.compiled.initialCheckpoint(snapshotId),
    ),
    createdAt: snapshot.now,
    deadlineAt: new Date(snapshot.now.getTime() + SUITE_MAX_DURATION_MS),
    expiresAt: new Date(snapshot.now.getTime() + TEST_RUN_RETENTION_MILLIS),
  });
  if (suite === undefined) throw new Error('Suite admission is missing');
  const manifest = cases.map((entry, ordinal) => ({
    workspaceId: input.workspaceId,
    suiteId,
    ordinal,
    caseId: entry.id,
    caseRevision: entry.revision,
    name: entry.name,
    input: canonicalJson(entry.input),
    expectations: canonicalJson(entry.expectations),
  }));
  await insertSuiteCases(client, manifest);
  const entry = await readSuiteCase(
    client,
    { workspaceId: input.workspaceId, suiteId },
    0,
  );
  if (entry === undefined) throw new Error('Suite has no first case');
  await admitSuiteCase(client, suite, entry, snapshot.now);
  const result = { suiteId };
  await completeCommand(client, command, result);
  return result;
}
