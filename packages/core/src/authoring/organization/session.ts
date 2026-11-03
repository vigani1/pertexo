import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type Role,
  type WorkspaceStatusList,
} from '@pertexo/policy';
import type { PoolClient } from 'pg';
import {
  withWorkspaceAccess,
  type WorkspaceAccess,
} from '../../shared/workspace-access.js';
import { readAsNotVisible } from '../workflows/access.js';

export type OrganizationScope = Readonly<{
  workspaceId: string;
  actorId: string;
  commandCredentialId?: string;
}>;
export type OrganizationRequestScope = OrganizationScope &
  Readonly<{ signal?: AbortSignal }>;
/** Who acts, with the role the fence found, so a flow never reads it again. */
export type OrganizationActor = OrganizationScope & Readonly<{ role: Role }>;

type Work<T> = (client: PoolClient, actor: OrganizationActor) => Promise<T>;

/** Organization's doors onto `withWorkspaceAccess`, on a leased pool. */
export function createOrganizationSession(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  function member<T>(
    input: OrganizationRequestScope,
    access: WorkspaceAccess,
    work: Work<T>,
  ): Promise<T> {
    const { workspaceId, actorId } = input;
    return withWorkspaceAccess(lease.pool, input, access, (client, role) =>
      work(client, {
        workspaceId,
        actorId,
        role,
        ...(input.commandCredentialId === undefined
          ? {}
          : { commandCredentialId: input.commandCredentialId }),
      }),
    );
  }
  return Object.freeze({
    /** Answers a denial as a denial, for the routes that say so. */
    member,
    /** Reads take the share locks too, and a denial reads as a missing workflow. */
    read: <T>(
      input: OrganizationRequestScope,
      capability: AuthorizationCapability,
      statuses: WorkspaceStatusList,
      work: Work<T>,
    ): Promise<T> =>
      member(input, { mode: 'change', capability, statuses }, work).catch(
        readAsNotVisible,
      ),
    /**
     * Commands in one workspace run one at a time. None locks a user for update,
     * and each touches one workspace, which is what makes `exclusive` safe here:
     * see lock-order.integration.test.ts.
     */
    command: <T>(
      input: OrganizationRequestScope,
      capability: AuthorizationCapability,
      work: Work<T>,
    ): Promise<T> =>
      member(
        input,
        {
          mode: 'exclusive',
          capability,
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        work,
      ).catch(readAsNotVisible),
    close: () => lease.close(),
  });
}
