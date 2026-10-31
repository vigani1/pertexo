import { workflowTestExpectationsSchema } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import {
  workflowTestSuiteCases,
  workflowTestSuites,
} from '../../schema/runs/suites.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';

import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';
import {
  canonicalJson,
  DEFAULT_TEST_EXPECTATIONS,
  rolesForCapability,
} from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import { lockInputCaseQuota } from '../../authoring/input-cases/metadata.queries.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { cancelInTransaction } from '../../runs/commands/cancel-active.repository.js';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { WorkflowRunNotFoundError } from '../../runs/errors.js';
import { databaseSchema } from '../../schema.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';
import { captureWorkspaceVariableRevision } from '../../variables/head.queries.js';
import {
  requireNoActiveSuite,
  requireNoActiveTest,
} from '../workflows/admit.repository.js';
import {
  withTestAuthority,
  withTestRead,
} from '../workflows/authority.queries.js';
import { WorkflowTestError } from '../workflows/errors.js';
import {
  loadTestSnapshot,
  sameTestSamples,
  saveTestSnapshot,
} from '../workflows/snapshot.repository.js';
import { admitSuiteCase } from './admit.repository.js';
import type { WorkflowTestSuiteStore } from './contract.js';
import { readSuiteCasePayloads, readSuiteCurrent } from './current.queries.js';
import { listSuites, readCaseReport, readSuite } from './records.queries.js';

export function createWorkflowTestSuiteStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestSuiteStore {
  return {
    prepare: (input) => prepareTestSuite(pool, catalogs, input),
    start: (input) => startTestSuite(pool, catalogs, input),
    list: (input) =>
      withTestRead(pool, input, async (client) => ({
        current: await readSuiteCurrent(client, input),
        items: await listSuites(client, input),
      })),
    get: (input) =>
      withTestRead(pool, input, (client) => readSuite(client, input)),
    report: (input) =>
      withTestRead(pool, input, (client) => readCaseReport(client, input)),
    cancel: (input) =>
      withTestAuthority(pool, input, async (client) => {
        await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability('run:cancel'),
        });
        const db = drizzle(client);
        const found = await db
          .select()
          .from(workflowTestSuites)
          .where(
            and(
              eq(workflowTestSuites.workspaceId, input.workspaceId),
              eq(workflowTestSuites.workflowId, input.workflowId),
              eq(workflowTestSuites.id, input.suiteId),
              sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
            ),
          )
          .for('update')
          .catch(rethrowQueryFailure);
        const suite = found[0];
        if (suite === undefined) throw new WorkflowTestError('not_found');
        if (suite.status !== 'running') return;
        await db
          .update(workflowTestSuites)
          .set({
            cancelRequested: true,
            stopReason: 'user_canceled',
            nextCheckAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(workflowTestSuites.workspaceId, input.workspaceId),
              eq(workflowTestSuites.id, input.suiteId),
            ),
          )
          .catch(rethrowQueryFailure);
        await db
          .update(workflowTestSuiteCases)
          .set({ status: 'skipped' })
          .where(
            and(
              eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
              eq(workflowTestSuiteCases.suiteId, input.suiteId),
              eq(workflowTestSuiteCases.status, 'pending'),
            ),
          )
          .catch(rethrowQueryFailure);
        const active = await db
          .select({ runId: workflowTestSuiteCases.runId })
          .from(workflowTestSuiteCases)
          .where(
            and(
              eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
              eq(workflowTestSuiteCases.suiteId, input.suiteId),
              eq(workflowTestSuiteCases.status, 'running'),
            ),
          )
          .catch(rethrowQueryFailure);
        const runId = active[0]?.runId;
        if (runId === undefined)
          await db
            .update(workflowTestSuites)
            .set({ status: 'canceled', completedAt: sql`clock_timestamp()` })
            .where(
              and(
                eq(workflowTestSuites.workspaceId, input.workspaceId),
                eq(workflowTestSuites.id, input.suiteId),
              ),
            )
            .catch(rethrowQueryFailure);
        else if (runId === null) throw new WorkflowRunNotFoundError();
        else
          await cancelInTransaction(
            {
              db: drizzle(client, { schema: databaseSchema }),
              workspaceId: parseWorkspaceId(input.workspaceId),
            },
            {
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              runId,
            },
          );
      }),
  };
}

async function preparation(
  catalogs: AuthoringCatalogs,
  client: Parameters<typeof loadTestSnapshot>[0],
  input: SampleScope,
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
function prepareTestSuite(
  pool: Pool,
  catalogs: AuthoringCatalogs,
  input: Parameters<WorkflowTestSuiteStore['prepare']>[0],
): ReturnType<WorkflowTestSuiteStore['prepare']> {
  return withTestAuthority(
    pool,
    input,
    async (client) => (await preparation(catalogs, client, input)).prepared,
  );
}

function startTestSuite(
  pool: Pool,
  catalogs: AuthoringCatalogs,
  input: Parameters<WorkflowTestSuiteStore['start']>[0],
): ReturnType<WorkflowTestSuiteStore['start']> {
  return withTestAuthority(pool, input, async (client) => {
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
    const { snapshot, current } = await preparation(catalogs, client, input);
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
  });
}

function assertPreparedSuite(
  input: Parameters<WorkflowTestSuiteStore['start']>[0],
  {
    snapshot,
    current,
  }: Pick<Awaited<ReturnType<typeof preparation>>, 'snapshot' | 'current'>,
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
