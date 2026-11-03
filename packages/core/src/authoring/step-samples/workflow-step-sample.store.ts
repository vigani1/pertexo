import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowStepSamples } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { parseStoredExecutionValue } from '../../runs/values/stored-execution.js';
import {
  sampleMetadataProjection,
  sampleProjection,
} from './records.repository.js';
import { BROWSABLE_WORKSPACE_STATUSES, hasCapability } from '@pertexo/policy';
import type { AuthoringAccess } from '../workflows/access.js';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import {
  sampleDatabaseTime,
  sampleDraft,
  sampleMetadata,
} from './records.repository.js';
import { mutateStepSample } from './commands.repository.js';
import type {
  PutSampleInput,
  RemoveSampleInput,
  SampleNodeScope,
  SampleRead,
  SampleScope,
  SampleTransaction,
} from './step-sample.types.js';

const SAMPLES_LISTED = 200;

export type WorkflowStepSampleStore = ReturnType<
  typeof createWorkflowStepSampleStore
>;

export function createWorkflowStepSampleStore(access: AuthoringAccess) {
  const transact: SampleTransaction = (input, { write, work }) =>
    access.workflow(
      input,
      write
        ? { capability: 'workflow:update' }
        : {
            capability: 'workflow:read',
            statuses: BROWSABLE_WORKSPACE_STATUSES,
          },
      async (client, _scope, role) => {
        // A sample is a run's output, so reading one takes both rights.
        if (!write && !hasCapability(role, 'run:read'))
          throw new WorkflowNotFoundError('Workflow is not visible');
        return work(client);
      },
    );
  return {
    list: (input: SampleScope) =>
      transact(input, {
        write: false,
        work: async (client) => {
          const draft = await sampleDraft(client, input, { write: false });
          const rows = await drizzle(client)
            .select(sampleMetadataProjection)
            .from(workflowStepSamples)
            .where(
              and(
                eq(workflowStepSamples.workspaceId, input.workspaceId),
                eq(workflowStepSamples.workflowId, input.workflowId),
              ),
            )
            .orderBy(asc(workflowStepSamples.nodeId))
            .limit(SAMPLES_LISTED)
            .catch(rethrowQueryFailure);
          const now = await sampleDatabaseTime(client);
          return {
            items: rows.map((row) =>
              sampleMetadata(row, draft.bindings.get(row.nodeId), now),
            ),
            draftRevision: draft.revision,
          };
        },
      }),
    get: (input: SampleNodeScope): Promise<SampleRead> =>
      transact(input, {
        write: false,
        work: async (client) => {
          const draft = await sampleDraft(client, input, { write: false });
          const [row] = await drizzle(client)
            .select(sampleProjection)
            .from(workflowStepSamples)
            .where(
              and(
                eq(workflowStepSamples.workspaceId, input.workspaceId),
                eq(workflowStepSamples.workflowId, input.workflowId),
                eq(workflowStepSamples.nodeId, input.nodeId),
              ),
            )
            .catch(rethrowQueryFailure);
          const now = await sampleDatabaseTime(client);
          const sample =
            row === undefined
              ? null
              : sampleMetadata(row, draft.bindings.get(row.nodeId), now);
          return {
            sample,
            output:
              row === undefined || sample?.state === 'expired'
                ? null
                : parseStoredExecutionValue(row.outputRef),
            draftRevision: draft.revision,
          };
        },
      }),
    put: (input: PutSampleInput) =>
      mutateStepSample(transact, input, input.source),
    remove: (input: RemoveSampleInput) =>
      mutateStepSample(transact, input, 'remove'),
  };
}
