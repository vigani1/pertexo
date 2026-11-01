import { sql } from 'drizzle-orm';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { lockEventCoordination } from '../coordination/keys.repository.js';
import { readCoordinatedEventHistory } from '../coordination/history.queries.js';
import { prepareFormEvent } from './prepare.repository.js';
import {
  createEventCoordinationPreparation,
  closeEventCoordinationStore,
} from '../coordination/prepare.js';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { withWorkflowAccess } from '../workflow-access.js';
import { FormUnavailableError } from './errors.js';
import type { FormScope, FormStore, PublicFormGrant } from './contract.js';
import { authorizeForm, readFormVersion } from './records.queries.js';
import {
  capabilityHash,
  readFormAccess,
  changeFormAccess,
} from './access.repository.js';
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

/** No member behind this one either: it turns a link into a grant. */
export async function discoverPublicForm(
  pool: Pool,
  input: Parameters<FormStore['discover']>[0],
): ReturnType<FormStore['discover']> {
  const result = await drizzle(pool)
    .execute<{
      workspaceId: string;
      workflowId: string;
      nodeId: string;
    }>(
      sql`select workspace_id "workspaceId",workflow_id "workflowId",node_id "nodeId" from app.lookup_public_form(${input.publicId},${capabilityHash(input.capability)})`,
    )
    .catch(rethrowQueryFailure);
  const row = result.rows[0];
  if (row === undefined) throw new FormUnavailableError();
  return {
    ...row,
    publicId: input.publicId,
    capabilityHash: capabilityHash(input.capability),
  };
}

function publishedForm(
  loaded: Awaited<ReturnType<typeof readFormVersion>>,
): Awaited<ReturnType<FormStore['read']>> {
  const { version, form } = loaded;
  return {
    versionId: version.id,
    form: {
      title: form.title,
      instructions: form.instructions,
      fields: form.fields,
    },
  };
}

/** A member still reads a suspended workspace's form; the public never does. */
async function readForm(
  pool: Pool,
  input: Parameters<FormStore['read']>[0],
  grant: Parameters<FormStore['read']>[1],
): ReturnType<FormStore['read']> {
  if (grant !== undefined) return readPublicForm(pool, input, grant);
  const { actorId } = input;
  if (actorId === undefined) throw new FormUnavailableError();
  return withWorkflowAccess(
    pool,
    { ...input, actorId },
    {
      mode: 'read',
      capability: 'workspace:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:read',
    },
    () => new FormUnavailableError(),
    async (client) =>
      publishedForm(await readFormVersion(client, input, 'read')),
  );
}

/** No member behind this one: the link is the authority, so it stays off the helper. */
function readPublicForm(
  pool: Pool,
  input: Parameters<FormStore['read']>[0],
  grant: PublicFormGrant,
): ReturnType<FormStore['read']> {
  return withTenantScopedReadClient(
    pool,
    {
      workspaceId: input.workspaceId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    },
    async (client) => {
      await authorizeForm(client, input, { grant, write: false });
      const loaded = await readFormVersion(client, input, 'read');
      if (grant.nodeId !== loaded.nodeId) throw new FormUnavailableError();
      return publishedForm(loaded);
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

/** Either door; `authorizeForm` says why it isn't on the authority helper. */
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
      await drizzle(client)
        .execute(
          sql`select app.lock_workspace_run_admission(${input.workspaceId})`,
        )
        .catch(rethrowQueryFailure);
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

/** What only editors read about a form, on a suspended workspace too. */
function withFormManager<T>(
  pool: Pool,
  input: FormScope & Readonly<{ actorId: string }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkflowAccess(
    pool,
    input,
    {
      mode: 'read',
      capability: 'workflow:update',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:read',
    },
    () => new FormUnavailableError(),
    work,
  );
}

async function readFormHistory(
  pool: Pool,
  input: Parameters<FormStore['history']>[0],
): ReturnType<FormStore['history']> {
  try {
    return await withFormManager(pool, input, (client) =>
      readCoordinatedEventHistory(client, input),
    );
  } catch (error) {
    if (!(error instanceof FormUnavailableError)) throw error;
    // History is a list: unavailable workflow identities disclose no events.
    return { items: [], next: null };
  }
}

function readManagedFormAccess(
  pool: Pool,
  input: Parameters<FormStore['access']>[0],
): ReturnType<FormStore['access']> {
  return withFormManager(pool, input, async (client) => {
    await readFormVersion(client, input, 'read', { allowPaused: true });
    return readFormAccess(client, input);
  });
}

function setManagedFormAccess(
  pool: Pool,
  input: Parameters<FormStore['setAccess']>[0],
): ReturnType<FormStore['setAccess']> {
  return withWorkflowAccess(
    pool,
    input,
    {
      mode: 'change',
      capability: 'workflow:update',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:update',
    },
    () => new FormUnavailableError(),
    async (client) => {
      const { nodeId } = await readFormVersion(client, input, 'update', {
        allowPaused: true,
      });
      return changeFormAccess(client, input, nodeId);
    },
  );
}
