import { workflowTestExpectationsSchema } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import {
  workflowTestSuiteCases,
  workflowTestSuites,
  databaseSchema,
} from '@pertexo/database/schema';
import {
  parseWorkspaceId,
  claimCommand,
  completeCommand,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';
import {
  canonicalJson,
  DEFAULT_TEST_EXPECTATIONS,
  rolesForCapability,
} from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../artifacts/references/locks.repository.js';
import { lockInputCaseQuota } from '../../authoring/input-cases/metadata.queries.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';
import { captureWorkspaceVariableRevision } from '../../variables/head.queries.js';
import {
  requireNoActiveSuite,
  requireNoActiveTest,
} from '../workflows/admit.js';
import { WorkflowTestError } from '../workflows/errors.js';
import {
  loadTestSnapshot,
  sameTestSamples,
  saveTestSnapshot,
} from '../workflows/snapshot.repository.js';
import { admitSuiteCase } from './admit.js';
import type { WorkflowTestSuiteStore } from './contract.js';
import { readSuiteCasePayloads, readSuiteCurrent } from './current.queries.js';

export async function prepareTestSuite(
  client: PoolClient,
  input: SampleScope,
  catalogs: AuthoringCatalogs,
) {
  const snapshot = await loadTestSnapshot(client, input, catalogs);
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
  input: Parameters<WorkflowTestSuiteStore['start']>[0],
  catalogs: AuthoringCatalogs,
): Promise<{ suiteId: string }> {
  const suiteId = generatePersistedId();
  const command = {
    workspaceId: input.workspaceId,
    operation: 'workflow.testsuite.start',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand(client, {
    ...command,
    request: input.request,
    resourceId: suiteId,
  });
  if (replay !== null) return replay as { suiteId: string };
  const { snapshot, current } = await prepareTestSuite(client, input, catalogs);
  assertPreparedSuite(input, { snapshot, current });
  if (snapshot.usesConnections)
    await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
      actorId: input.actorId,
      roles: rolesForCapability('connection:use'),
    });
  await requireNoActiveSuite(client, input);
  await requireNoActiveTest(client, input);
  const db = drizzle(client);
  const cases = await readSuiteCasePayloads(client, input);
  if (cases.length !== current.cases.length)
    throw new WorkflowTestError('cases_changed');
  for (const entry of cases) {
    const expectations = workflowTestExpectationsSchema.parse(
      entry.expectations === null
        ? DEFAULT_TEST_EXPECTATIONS
        : JSON.parse(entry.expectations),
    );
    if (
      expectations.assertions.some(
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
      JSON.parse(entry.input),
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
  const inserted = await db
    .insert(workflowTestSuites)
    .values({
      id: suiteId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      startedBy: input.actorId,
      snapshotId,
      signature: current.signature,
      variableSetRevision: current.variableSetRevision,
      usesConnections: snapshot.usesConnections,
      caseDurationMs: Math.min(
        300000,
        snapshot.graph.settings.maxRunDurationMs ?? 300000,
      ),
      initialCheckpoint: sql`${JSON.stringify(snapshot.compiled.initialCheckpoint(snapshotId))}::jsonb`,
      createdAt: snapshot.now,
      deadlineAt: new Date(snapshot.now.getTime() + 5 * 60 * 60 * 1000),
      expiresAt: new Date(snapshot.now.getTime() + TEST_RUN_RETENTION_MILLIS),
    })
    .returning()
    .catch(rethrowQueryFailure);
  const suite = inserted[0];
  if (suite === undefined) throw new Error('Suite admission is missing');
  const manifest = cases.map((entry, ordinal) => ({
    workspaceId: input.workspaceId,
    suiteId,
    ordinal,
    caseId: entry.id,
    caseRevision: entry.revision,
    name: entry.name,
    input: entry.input,
    expectations:
      entry.expectations ?? canonicalJson(DEFAULT_TEST_EXPECTATIONS),
  }));
  await db
    .insert(workflowTestSuiteCases)
    .values(manifest)
    .catch(rethrowQueryFailure);
  const first = await db
    .select()
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
        eq(workflowTestSuiteCases.suiteId, suiteId),
        eq(workflowTestSuiteCases.ordinal, 0),
      ),
    )
    .catch(rethrowQueryFailure);
  const entry = first[0];
  if (entry === undefined) throw new Error('Suite has no first case');
  await admitSuiteCase(client, suite, entry, snapshot.now);
  const result = { suiteId };
  await completeCommand(client, command, result);
  return result;
}

function assertPreparedSuite(
  input: Parameters<WorkflowTestSuiteStore['start']>[0],
  {
    snapshot,
    current,
  }: Pick<Awaited<ReturnType<typeof prepareTestSuite>>, 'snapshot' | 'current'>,
): void {
  if (current.cases.length === 0) throw new WorkflowTestError('cases_required');
  if (current.draftRevision !== input.request.expectedRevision)
    throw new WorkflowTestError('draft_changed');
  if (!sameTestSamples(current.samples, input.request.expectedSamples))
    throw new WorkflowTestError('samples_changed');
  const suiteChanged =
    current.variableSetRevision !== input.request.expectedVariableSetRevision ||
    current.signature !== input.request.signature ||
    canonicalJson(
      current.cases.map(({ id, revision }) => ({ id, revision })),
    ) !== canonicalJson(input.request.expectedCases);
  if (suiteChanged) throw new WorkflowTestError('cases_changed');
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
}
