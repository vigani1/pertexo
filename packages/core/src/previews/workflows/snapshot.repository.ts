import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowStepSamples,
  workflowTestSnapshots,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  parseStoredExecutionValue,
} from '@pertexo/database/primitives';
import { workflowTestStepChoices } from '@pertexo/workflow-model';
import type { FrozenWorkflowTestPins } from '@pertexo/database/schema';
import { sampleDraft } from '../../authoring/step-samples/records.repository.js';
import type { PoolClient } from 'pg';
import { normalizedJson } from '@pertexo/workflow-model';
import type { WorkflowTestPins } from '@pertexo/workflow-engine';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';

import { readDatabaseClock } from '../clock.queries.js';
import { WorkflowTestError } from './errors.js';

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
  const now = await readDatabaseClock(db);
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
