import type { Pool } from 'pg';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { sampleDatabaseTime, sampleDraft, sampleMetadata } from './records.repository.js';
import { mutateStepSample } from './commands.repository.js';
import {
  SAMPLE_COLUMNS,
  SAMPLE_METADATA_COLUMNS,
  type SampleMetadataRow,
  type SampleRow,
  type SampleTransaction,
  type WorkflowStepSampleStore,
} from './contract.js';

export function createWorkflowStepSampleStore(
  pool: Pool,
): WorkflowStepSampleStore {
  const transact: SampleTransaction = (input, { write, work }) =>
    withTenantScopedClient(
      pool,
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (client) => {
        await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability(
            write ? 'workflow:update' : 'workflow:read',
          ),
          resource: {
            workflowId: input.workflowId,
            capability: write ? 'workflow:update' : 'workflow:read',
          },
        });
        if (!write)
          await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
            actorId: input.actorId,
            roles: rolesForCapability('run:read'),
          });
        return work(client);
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
  return {
    list: (input) =>
      transact(input, {
        write: false,
        work: async (client) => {
          const draft = await sampleDraft(client, input, { write: false });
          const rows = await client.query<SampleMetadataRow>(
            `select ${SAMPLE_METADATA_COLUMNS} from app.workflow_step_samples where workspace_id=$1 and workflow_id=$2 order by node_id limit 200`,
            [input.workspaceId, input.workflowId],
          );
          const now = await sampleDatabaseTime(client);
          return {
            items: rows.rows.map((row) =>
              sampleMetadata(row, draft.bindings.get(row.node_id), now),
            ),
            draftRevision: draft.revision,
          };
        },
      }),
    get: (input) =>
      transact(input, {
        write: false,
        work: async (client) => {
          const draft = await sampleDraft(client, input, { write: false });
          const rows = await client.query<SampleRow>(
            `select ${SAMPLE_COLUMNS} from app.workflow_step_samples where workspace_id=$1 and workflow_id=$2 and node_id=$3`,
            [input.workspaceId, input.workflowId, input.nodeId],
          );
          const row = rows.rows[0];
          const now = await sampleDatabaseTime(client);
          const sample =
            row === undefined
              ? null
              : sampleMetadata(row, draft.bindings.get(row.node_id), now);
          return {
            sample,
            output:
              row === undefined || sample?.state === 'expired'
                ? null
                : parseStoredExecutionValue(row.output_ref),
            draftRevision: draft.revision,
          };
        },
      }),
    put: (input) => mutateStepSample(transact, input, input.source),
    remove: (input) => mutateStepSample(transact, input, 'remove'),
  };
}
