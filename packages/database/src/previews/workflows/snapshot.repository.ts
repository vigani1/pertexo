import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowStepSamples } from '../../schema/authoring/step-samples.js';
import { workflowTestSnapshots } from '../../schema/runs/tests.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { workflowTestStepChoices } from '@pertexo/workflow-model';
import type { FrozenWorkflowTestPins } from '../../schema/runs/tests.js';
import { sampleDraft } from '../../authoring/step-samples/records.js';
import type { PoolClient } from 'pg';
import { canonicalJson, normalizedJson } from '@pertexo/workflow-model';
import type { WorkflowTestPins } from '@pertexo/workflow-engine';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';

import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { WorkflowTestError } from './contract.js';

export async function loadTestSnapshot(
  client: PoolClient,
  input: SampleScope,
  catalogs: AuthoringCatalogs,
) {
  const draft = await sampleDraft(client, input, { write: true });
  const { graph, bindings } = draft;
  const db = drizzle(client);
  const samples = await db
    .select()
    .from(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, input.workspaceId),
        eq(workflowStepSamples.workflowId, input.workflowId),
      ),
    )
    .orderBy(asc(workflowStepSamples.nodeId))
    .for('share')
    .catch(rethrowQueryFailure);
  const clock = await db
    .execute<{ now: string }>(sql`select clock_timestamp() now`)
    .catch(rethrowQueryFailure);
  const databaseTime = clock.rows[0]?.now;
  if (databaseTime === undefined)
    throw new Error('Test admission time is unavailable');
  const now = new Date(databaseTime);
  const pins: Record<string, WorkflowTestPins[string]> = Object.create(
    null,
  ) as Record<string, WorkflowTestPins[string]>;
  const frozenPins: Record<string, FrozenWorkflowTestPins[string]> =
    Object.create(null) as Record<string, FrozenWorkflowTestPins[string]>;
  for (const sample of samples) {
    if (
      sample.expiresAt <= now ||
      bindings.get(sample.nodeId) !== sample.binding
    )
      throw new WorkflowTestError('stale_sample');
    const output = parseStoredExecutionValue(sample.outputRef);
    if (output.kind !== 'inline') throw new WorkflowTestError('stale_sample');
    pins[sample.nodeId] = { sampleId: sample.id, output: output.value };
    frozenPins[sample.nodeId] = {
      sampleId: sample.id,
      outputRef: sample.outputRef,
    };
  }
  if (catalogs.workflowTestCompiler === undefined)
    throw new WorkflowTestError('not_supported');
  const compiled = catalogs.workflowTestCompiler(graph, pins);
  if (compiled.invalidPinIds.length > 0)
    throw new WorkflowTestError('pin_invalid');
  const labels = new Map(
    workflowTestStepChoices(graph).map((node) => [node.nodeId, node.label]),
  );
  return {
    graph,
    compiled,
    frozenPins,
    now,
    usesConnections: compiled.usesConnections,
    preparation: {
      draftRevision: draft.revision,
      samples: Object.entries(pins).map(([nodeId, pin]) => ({
        nodeId,
        sampleId: pin.sampleId,
      })),
      effectfulSteps: compiled.effectfulNodeIds.map((nodeId) => ({
        nodeId,
        label: labels.get(nodeId) ?? nodeId,
      })),
    },
  };
}
export function sameTestSamples(
  left: readonly { nodeId: string; sampleId: string }[],
  right: readonly { nodeId: string; sampleId: string }[],
) {
  const sort = (items: typeof left) =>
    [...items].sort((a, b) => {
      if (a.nodeId < b.nodeId) {
        return -1;
      }
      if (a.nodeId > b.nodeId) {
        return 1;
      }
      return 0;
    });
  return canonicalJson(sort(left)) === canonicalJson(sort(right));
}

/** One immutable source may serve a standalone test or all serial suite cases. */
export async function saveTestSnapshot(
  client: PoolClient,
  input: SampleScope,
  {
    id,
    snapshot,
    expiresAt,
  }: Readonly<{
    id: string;
    snapshot: Awaited<ReturnType<typeof loadTestSnapshot>>;
    expiresAt: Date;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(workflowTestSnapshots)
    .values({
      id,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      draftRevision: snapshot.preparation.draftRevision,
      graphJson: sql`${normalizedJson(snapshot.graph)}::json`,
      executableJson: sql`${normalizedJson(snapshot.compiled.executableJson)}::json`,
      pins: sql`${normalizedJson(snapshot.frozenPins)}::json`,
      expiresAt,
      checksum: snapshot.compiled.checksum,
      dispositions: sql`${JSON.stringify(snapshot.compiled.dispositions)}::jsonb`,
    })
    .catch(rethrowQueryFailure);
}
