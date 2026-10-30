import type { PoolClient } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';

import { rolesForCapability } from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';

import type { Scope, WorkflowInputCaseDatabase } from './contract.js';

import {
  createInputCase,
  deleteInputCase,
  updateInputCase,
} from './commands/mutations.repository.js';
import { getInputCase, listInputCases } from './read.queries.js';

/** Durable bounded authoring commands; no caller manages locks or quota counters. */
export function createWorkflowInputCaseDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowInputCaseDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  async function transact<T>(
    input: Scope,
    {
      write,
      work,
    }: Readonly<{ write: boolean; work: (client: PoolClient) => Promise<T> }>,
  ): Promise<T> {
    if (closed) throw new Error('Run-input case database is closed');
    const operation = withTenantScopedClient(
      lease.pool,
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
        return work(client);
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  }
  return Object.freeze<WorkflowInputCaseDatabase>({
    listCases: (input) => listInputCases(transact, input),
    getCase: (input) => getInputCase(transact, input),
    createCase: (input) => createInputCase(transact, input),
    updateCase: (input) => updateInputCase(transact, input),
    deleteCase: (input) => deleteInputCase(transact, input),
    close: () => {
      closed = true;
      closing ??= Promise.allSettled([...pending]).then(() => lease.close());
      return closing;
    },
  });
}
