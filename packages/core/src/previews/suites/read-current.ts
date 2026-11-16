import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkflowTestSuiteCurrent } from '@pertexo/contracts';
import {
  canonicalJson,
  WORKFLOW_TEST_SUITE_MAX_CASES,
} from '@pertexo/workflow-model';

import { WorkflowTestError } from '../workflows/workflow-test.errors.js';
import {
  readDraftRevision,
  readSuiteCases,
  readSuitePins,
  readVariablesRevision,
} from './current.repository.js';

/** The same metadata signature prepares suites and labels publish freshness. */
export async function readSuiteCurrent(
  client: PoolClient,
  input: WorkflowActor,
  frozenVariableSetRevision?: number | null,
): Promise<WorkflowTestSuiteCurrent> {
  const revision = await readDraftRevision(client, input);
  if (revision === undefined) throw new WorkflowTestError('not_found');
  const cases = await readSuiteCases(client, input);
  if (cases.length > WORKFLOW_TEST_SUITE_MAX_CASES)
    throw new WorkflowTestError('cases_changed');
  const pins = await readSuitePins(client, input);
  const variableSetRevision =
    frozenVariableSetRevision === undefined
      ? await readVariablesRevision(client, input.workspaceId)
      : frozenVariableSetRevision;
  const identity = {
    draftRevision: revision,
    cases: cases.map(({ id, revision }) => ({ id, revision })),
    samples: pins.map((row) => ({
      nodeId: row.nodeId,
      sampleId: row.id,
    })),
    variableSetRevision,
  };
  return {
    ...identity,
    cases: cases,
    signature: createHash('sha256')
      .update(
        canonicalJson({
          ...identity,
          expiredSampleIds: pins
            .filter((pin) => pin.expired)
            .map((pin) => pin.id),
        }),
      )
      .digest('hex'),
  };
}
