import {
  parseWorkspaceId,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { databaseSchema } from '@pertexo/database/schema';
import { ACTIVE_WORKSPACE_STATUSES, type Role } from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { withWorkspaceAccess } from '../../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { PreviewAdmissionDeniedError } from '../errors.js';
import { acceptPreviewRun } from './accept.js';
import type {
  AcceptPreviewRunInput,
  ReadPreviewRunInput,
} from './acceptance/contract.js';
import type { ResolvePreviewReplayInput } from './contract.js';
import { readPreviewRun } from './records.queries.js';
import { resolvePreviewReplay } from './resolve-replay.js';

type InWorkspace = Readonly<{ workspaceId: string }>;

/**
 * Testing a step takes a member who can edit the workflow, including to read a
 * result or look up a replay. These reads lock too, so authority can't be lost
 * before the answer is given.
 */
export function createPreviewRunStore(pool: Pool) {
  const access = async <T>(
    workspaceId: string,
    actorUserId: string,
    work: (transaction: WorkspaceTransaction, role: Role) => Promise<T>,
  ): Promise<T> => {
    try {
      return await withWorkspaceAccess(
        pool,
        { workspaceId, actorId: actorUserId },
        {
          mode: 'change',
          capability: 'workflow:update',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        (client, role) =>
          work(
            Object.freeze({
              db: drizzle(client, { schema: databaseSchema }),
              workspaceId: parseWorkspaceId(workspaceId),
            }),
            role,
          ),
      );
    } catch (error) {
      if (error instanceof WorkspaceAccessDeniedError)
        throw new PreviewAdmissionDeniedError('actor');
      throw error;
    }
  };
  return {
    acceptPreview: ({
      workspaceId,
      ...input
    }: AcceptPreviewRunInput & InWorkspace) =>
      access(workspaceId, input.actorUserId, (transaction, role) =>
        acceptPreviewRun(transaction, input, role),
      ),
    readPreview: ({
      workspaceId,
      ...input
    }: ReadPreviewRunInput & InWorkspace) =>
      access(workspaceId, input.actorUserId, (transaction, role) =>
        readPreviewRun(transaction, input, role),
      ),
    resolvePreviewReplay: ({
      workspaceId,
      ...input
    }: ResolvePreviewReplayInput & InWorkspace) =>
      access(workspaceId, input.actorUserId, (transaction, role) =>
        resolvePreviewReplay(transaction, input, role),
      ),
  };
}
