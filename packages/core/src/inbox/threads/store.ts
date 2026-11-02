import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceStatusList,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import { readFolderScope } from '../../shared/facts.queries.js';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../shared/workspace-access.js';
import type { FolderScope } from '../../shared/contract.js';
import { WorkspaceAccessDeniedError } from '../../shared/errors.js';
import type {
  ListThreadsInput,
  MarkAllReadInput,
  MarkThreadReadInput,
} from './contract.js';
import { listThreads, readSummary } from './list.queries.js';
import { markAllRead, markThreadRead } from './mark-read.repository.js';

const STATEMENT_TIMEOUT_MILLIS = 2_000;

export type WorkspaceInboxStore = ReturnType<typeof createWorkspaceInboxStore>;

/**
 * ADR 055: reading and marking threads. Someone who can't see the workspace has
 * an empty Inbox rather than an error, which is why a denial becomes a value here.
 */
export function createWorkspaceInboxStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const access = <T>(
    actor: WorkspaceActor,
    {
      mode,
      statuses,
      whenDenied,
    }: Readonly<{
      mode: 'read' | 'change';
      statuses: WorkspaceStatusList;
      whenDenied: T;
    }>,
    work: (client: PoolClient, resources: FolderScope) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      {
        mode,
        capability: 'workspace:read',
        statuses,
        statementTimeoutMillis: STATEMENT_TIMEOUT_MILLIS,
      },
      async (client, role) =>
        work(client, await readFolderScope(client, actor, role)),
    ).catch((error: unknown) => {
      if (error instanceof WorkspaceAccessDeniedError) return whenDenied;
      throw error;
    });
  const read = {
    mode: 'read',
    statuses: BROWSABLE_WORKSPACE_STATUSES,
  } as const;
  const change = {
    mode: 'change',
    statuses: ACTIVE_WORKSPACE_STATUSES,
  } as const;
  return {
    close: () => lease.close(),
    listThreads: (input: ListThreadsInput) =>
      access(
        input,
        { ...read, whenDenied: { items: [], next: null, revision: '0' } },
        (client, resources) => listThreads(client, input, resources),
      ),
    readSummary: (input: WorkspaceActor) =>
      access(
        input,
        { ...read, whenDenied: { unreadCount: 0, revision: '0' } },
        (client, resources) => readSummary(client, input, resources),
      ),
    markThreadRead: (input: MarkThreadReadInput) =>
      access(input, { ...change, whenDenied: undefined }, (client, resources) =>
        markThreadRead(client, input, resources),
      ),
    markAllRead: (input: MarkAllReadInput) =>
      access(
        input,
        { ...change, whenDenied: { marked: 0 } },
        (client, resources) => markAllRead(client, input, resources),
      ),
  };
}
