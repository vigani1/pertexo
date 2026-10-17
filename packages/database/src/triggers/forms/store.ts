import { drizzle } from 'drizzle-orm/node-postgres';
import { lockEventCoordination } from '../coordination/keys.js';
import { readCoordinatedEventHistory } from '../coordination/history.js';
import { prepareFormEvent } from './prepare.js';
import {
  createEventCoordinationPreparation,
  closeEventCoordinationStore,
} from '../coordination/prepare.js';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/transactions.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { FormUnavailableError, type FormStore } from './contract.js';
import { authorizeForm, readFormVersion } from './read.js';
import { capabilityHash, readFormAccess, changeFormAccess } from './access.js';
import { submitForm } from './submit.js';
export function createFormStore(
  config: DatabaseConfig,
  prepare: InitialCheckpointFactory,
  runtime?: DatabaseRuntime,
): FormStore {
  const lease = acquireDatabasePool(config, runtime);
  const eventPreparation = createEventCoordinationPreparation();
  return Object.freeze({
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
    discover: async (input) => {
      const result = await lease.pool.query<{
        workspaceId: string;
        workflowId: string;
        nodeId: string;
      }>(
        `select workspace_id "workspaceId",workflow_id "workflowId",node_id "nodeId" from app.lookup_public_form($1,$2)`,
        [input.publicId, capabilityHash(input.capability)],
      );
      const row = result.rows[0];
      if (row === undefined) throw new FormUnavailableError();
      return {
        ...row,
        publicId: input.publicId,
        capabilityHash: capabilityHash(input.capability),
      };
    },
    read: (input, grant) =>
      withTenantScopedReadClient(
        lease.pool,
        {
          workspaceId: input.workspaceId,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        },
        async (client) => {
          await authorizeForm(client, input, grant, false);
          const { version, nodeId, form } = await readFormVersion(
            client,
            input,
            'read',
          );
          if (grant !== undefined && grant.nodeId !== nodeId)
            throw new FormUnavailableError();
          return {
            versionId: version.id,
            form: {
              title: form.title,
              instructions: form.instructions,
              fields: form.fields,
            },
          };
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    submit: async (input, grant) => {
      const prepared = await prepareFormEvent(
        lease.pool,
        input,
        grant,
        eventPreparation,
      );
      return withTenantScopedClient(
        lease.pool,
        {
          workspaceId: input.workspaceId,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        },
        async (client) => {
          await client.query('select app.lock_workspace_run_admission($1)', [
            input.workspaceId,
          ]);
          if (
            prepared !== undefined &&
            !('error' in prepared) &&
            prepared.coordination !== undefined
          )
            await lockEventCoordination(input.workspaceId, drizzle(client));
          if (grant === undefined)
            await authorizeForm(client, input, undefined, true);
          const loaded = await readFormVersion(client, input, 'share');
          if (grant !== undefined && grant.nodeId !== loaded.nodeId)
            throw new FormUnavailableError();
          if (grant !== undefined)
            await authorizeForm(client, input, grant, true);
          return submitForm(
            client,
            input,
            prepare,
            grant !== undefined,
            loaded,
            prepared,
          );
        },
        input.signal === undefined ? {} : { signal: input.signal },
      );
    },
    history: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await authorizeForm(client, input, undefined, false, true);
          return readCoordinatedEventHistory(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    access: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await authorizeForm(client, input, undefined, false, true);
          await readFormVersion(client, input, 'read', true);
          return readFormAccess(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    setAccess: (input) =>
      withTenantScopedClient(
        lease.pool,
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (client) => {
          await authorizeForm(client, input, undefined, true, true);
          const { nodeId } = await readFormVersion(
            client,
            input,
            'update',
            true,
          );
          return changeFormAccess(client, input, nodeId);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
  } satisfies FormStore);
}
