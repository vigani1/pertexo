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
import type {
  CoordinatedEventHistory,
  FormAccess,
  FormSchemaResponse,
  FormSubmissionResponse,
} from '@pertexo/contracts';
import type {
  DiscoverFormInput,
  FormHistoryInput,
  FormScope,
  PublicFormGrant,
  ReadFormAccessInput,
  SetFormAccessInput,
  SubmitFormInput,
} from './contract.js';
import { authorizeForm, readFormVersion } from './records.queries.js';
import { discoverPublicForm } from './discover.queries.js';
import { readFormAccess, changeFormAccess } from './access.repository.js';
import { submitForm } from './submit.repository.js';
export type FormStore = ReturnType<typeof createFormStore>;

export function createFormStore(
  config: DatabaseConfig,
  prepare: InitialCheckpointFactory,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const eventPreparation = createEventCoordinationPreparation();
  return Object.freeze({
    close: () =>
      closeEventCoordinationStore(() => lease.close(), eventPreparation),
    discover: (input: DiscoverFormInput) =>
      discoverPublicForm(lease.pool, input),
    read: (input: FormScope, grant?: PublicFormGrant) =>
      readForm(lease.pool, input, grant),
    submit: (input: SubmitFormInput, grant?: PublicFormGrant) =>
      submitFormEvent(
        { pool: lease.pool, prepare, eventPreparation },
        input,
        grant,
      ),
    history: (input: FormHistoryInput) => readFormHistory(lease.pool, input),
    access: (input: ReadFormAccessInput) =>
      readManagedFormAccess(lease.pool, input),
    setAccess: (input: SetFormAccessInput) =>
      setManagedFormAccess(lease.pool, input),
  });
}

function publishedForm(
  loaded: Awaited<ReturnType<typeof readFormVersion>>,
): FormSchemaResponse {
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
  input: FormScope,
  grant: PublicFormGrant | undefined,
): Promise<FormSchemaResponse> {
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
  input: FormScope,
  grant: PublicFormGrant,
): Promise<FormSchemaResponse> {
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
  input: SubmitFormInput,
  grant: PublicFormGrant | undefined,
): Promise<FormSubmissionResponse> {
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
  input: FormHistoryInput,
): Promise<CoordinatedEventHistory> {
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
  input: ReadFormAccessInput,
): Promise<FormAccess> {
  return withFormManager(pool, input, async (client) => {
    await readFormVersion(client, input, 'read', { allowPaused: true });
    return readFormAccess(client, input);
  });
}

function setManagedFormAccess(
  pool: Pool,
  input: SetFormAccessInput,
): Promise<FormAccess> {
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
