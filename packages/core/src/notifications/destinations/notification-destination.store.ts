import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type Role,
  type WorkspaceStatusList,
} from '@pertexo/policy';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../../shared/workspace-access.errors.js';
import {
  clearWorkflowPolicy,
  readWorkflowPolicy,
  setWorkflowPolicy,
} from '../policies/workflow-policy.js';
import type {
  AppendDestinationVersionInput,
  ClearWorkflowPolicyInput,
  CommandMetadata,
  CreateDestinationInput,
  DestinationInput,
  SetDestinationStatusInput,
  SetWorkflowPolicyInput,
  WorkflowPolicyInput,
} from './notification-destination.types.js';
import { FailureNotificationDestinationError } from './notification-destination.errors.js';
import {
  appendDestinationVersion,
  createDestination,
  listDestinations,
  setDestinationStatus,
} from './manage.repository.js';
import { readFailureNotificationDestination } from './notification-destinations.repository.js';

export type NotificationDestinationStore = ReturnType<
  typeof createNotificationDestinationStore
>;

export function createNotificationDestinationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  /**
   * These reads lock too, so a choice can't be read while it's being replaced.
   * Someone without access sees "not found" rather than learning it exists.
   */
  const access = async <T>(
    input: CommandMetadata,
    capability: AuthorizationCapability,
    statuses: WorkspaceStatusList,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ): Promise<T> => {
    const actor: WorkspaceActor = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
    };
    try {
      return await withWorkspaceAccess(
        lease.pool,
        actor,
        { mode: 'change', capability, statuses },
        work,
      );
    } catch (error) {
      if (error instanceof WorkspaceAccessDeniedError)
        throw new FailureNotificationDestinationError(
          'not_found',
          'Destination is not visible',
        );
      throw error;
    }
  };
  /** Where alerts go is an owner's or admin's decision. */
  const manage = <T>(
    input: CommandMetadata,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) => access(input, 'governance:manage', ACTIVE_WORKSPACE_STATUSES, work);
  const browse = <T>(
    input: CommandMetadata,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) => access(input, 'workflow:update', BROWSABLE_WORKSPACE_STATUSES, work);
  const edit = <T>(
    input: CommandMetadata,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) => access(input, 'workflow:update', ACTIVE_WORKSPACE_STATUSES, work);
  return Object.freeze({
    create: (input: CreateDestinationInput) =>
      manage(input, (client) => createDestination(client, input)),
    get: (input: DestinationInput) =>
      browse(input, (client) =>
        readFailureNotificationDestination(
          client,
          input.workspaceId,
          input.destinationId,
        ),
      ),
    list: (input: CommandMetadata & Readonly<{ afterId?: string }>) =>
      browse(input, (client) =>
        listDestinations(client, input.workspaceId, input.afterId),
      ),
    appendVersion: (input: AppendDestinationVersionInput) =>
      manage(input, (client) => appendDestinationVersion(client, input)),
    setStatus: (input: SetDestinationStatusInput) =>
      manage(input, (client) => setDestinationStatus(client, input)),
    setWorkflowPolicy: (input: SetWorkflowPolicyInput) =>
      edit(input, (client, role) => setWorkflowPolicy(client, input, role)),
    clearWorkflowPolicy: (input: ClearWorkflowPolicyInput) =>
      edit(input, (client, role) => clearWorkflowPolicy(client, input, role)),
    getWorkflowPolicy: (input: WorkflowPolicyInput) =>
      browse(input, (client, role) => readWorkflowPolicy(client, input, role)),
    close: () => lease.close(),
  });
}
