import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowStepSamples } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { parseStoredExecutionValue } from '../../runs/values/stored-execution.js';
import {
  sampleMetadataProjection,
  sampleProjection,
} from './records.repository.js';
import type { Pool } from 'pg';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import {
  sampleDatabaseTime,
  sampleDraft,
  sampleMetadata,
} from './records.repository.js';
import { mutateStepSample } from './commands.repository.js';
import type { SampleTransaction, WorkflowStepSampleStore } from './contract.js';

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
          browsing: !write,
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
            browsing: true,
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
            .limit(200)
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
    get: (input) =>
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
    put: (input) => mutateStepSample(transact, input, input.source),
    remove: (input) => mutateStepSample(transact, input, 'remove'),
  };
}
