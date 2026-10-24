import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { lockEventCoordination } from '../coordination/keys.repository.js';
import { readCoordinatedEventHistory } from '../coordination/history.queries.js';
import { prepareFormEvent } from './prepare.repository.js';
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
import { authorizeForm, readFormVersion } from './records.queries.js';
import { capabilityHash, readFormAccess, changeFormAccess } from './access.repository.js';
import { submitForm } from './submit.repository.js';
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
    discover: (input) => discoverPublicForm(lease.pool, input),
    read: (input, grant) => readForm(lease.pool, input, grant),
    submit: (input, grant) =>
      submitFormEvent(
        { pool: lease.pool, prepare, eventPreparation },
        input,
        grant,
      ),
    history: (input) => readFormHistory(lease.pool, input),
    access: (input) => readManagedFormAccess(lease.pool, input),
    setAccess: (input) => setManagedFormAccess(lease.pool, input),
  } satisfies FormStore);
}

async function discoverPublicForm(
  pool: Pool,
  input: Parameters<FormStore['discover']>[0],
): ReturnType<FormStore['discover']> {
  const result = await pool.query<{
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
}

function readForm(
  pool: Pool,
  input: Parameters<FormStore['read']>[0],
  grant: Parameters<FormStore['read']>[1],
): ReturnType<FormStore['read']> {
  return withTenantScopedReadClient(
    pool,
    {
      workspaceId: input.workspaceId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    },
    async (client) => {
      await authorizeForm(client, input, { grant, write: false });
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
  );
}

async function submitFormEvent(
  {
    pool,
    prepare,
    eventPreparation,
  }: Readonly<{
    pool: Pool;
    prepare: InitialCheckpointFactory;
    eventPreparation: ReturnType<typeof createEventCoordinationPreparation>;
  }>,
  input: Parameters<FormStore['submit']>[0],
  grant: Parameters<FormStore['submit']>[1],
): ReturnType<FormStore['submit']> {
  const prepared = await prepareFormEvent(pool, input, grant, eventPreparation);
  return withTenantScopedClient(
    pool,
    {
      workspaceId: input.workspaceId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    },
    async (client) => {
      await client.query('select app.lock_workspace_run_admission($1)', [
        input.workspaceId,
      ]);
      const coordinatesEvent =
        prepared !== undefined &&
        !('error' in prepared) &&
        prepared.coordination !== undefined;
      if (coordinatesEvent)
        await lockEventCoordination(input.workspaceId, drizzle(client));
      if (grant === undefined)
        await authorizeForm(client, input, {
          grant: undefined,
          write: true,
        });
      const loaded = await readFormVersion(client, input, 'share');
      if (grant !== undefined && grant.nodeId !== loaded.nodeId)
        throw new FormUnavailableError();
      if (grant !== undefined)
        await authorizeForm(client, input, { grant, write: true });
      return submitForm(client, input, {
        prepare,
        publicAccess: grant !== undefined,
        loaded,
        prepared,
      });
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

function readFormHistory(
  pool: Pool,
  input: Parameters<FormStore['history']>[0],
): ReturnType<FormStore['history']> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      try {
        await authorizeForm(client, input, {
          grant: undefined,
          write: false,
          manage: true,
        });
      } catch (error) {
        if (!(error instanceof FormUnavailableError)) throw error;
        // History is a list: unavailable workflow identities disclose no events.
        return { items: [], next: null };
      }
      return readCoordinatedEventHistory(client, input);
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

function readManagedFormAccess(
  pool: Pool,
  input: Parameters<FormStore['access']>[0],
): ReturnType<FormStore['access']> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      await authorizeForm(client, input, {
        grant: undefined,
        write: false,
        manage: true,
      });
      await readFormVersion(client, input, 'read', { allowPaused: true });
      return readFormAccess(client, input);
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

function setManagedFormAccess(
  pool: Pool,
  input: Parameters<FormStore['setAccess']>[0],
): ReturnType<FormStore['setAccess']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      await authorizeForm(client, input, {
        grant: undefined,
        write: true,
        manage: true,
      });
      const { nodeId } = await readFormVersion(client, input, 'update', {
        allowPaused: true,
      });
      return changeFormAccess(client, input, nodeId);
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}
