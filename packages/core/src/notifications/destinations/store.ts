import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
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
} from './contract.js';
import { destinationError } from './command.js';
import {
  appendDestinationVersion,
  createDestination,
  listDestinations,
  setDestinationStatus,
} from './manage.repository.js';
import { readFailureNotificationDestination } from './records.queries.js';

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
    work: (client: PoolClient) => Promise<T>,
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
        throw destinationError('not_found', 'Destination is not visible');
      throw error;
    }
  };
  /** Where alerts go is an owner's or admin's decision. */
  const manage = <T>(
    input: CommandMetadata,
    work: (client: PoolClient) => Promise<T>,
  ) => access(input, 'governance:manage', ACTIVE_WORKSPACE_STATUSES, work);
  const browse = <T>(
    input: CommandMetadata,
    work: (client: PoolClient) => Promise<T>,
  ) => access(input, 'workflow:update', BROWSABLE_WORKSPACE_STATUSES, work);
  const edit = <T>(
    input: CommandMetadata,
    work: (client: PoolClient) => Promise<T>,
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
    list: (input: CommandMetadata) =>
      browse(input, (client) => listDestinations(client, input.workspaceId)),
    appendVersion: (input: AppendDestinationVersionInput) =>
      manage(input, (client) => appendDestinationVersion(client, input)),
    setStatus: (input: SetDestinationStatusInput) =>
      manage(input, (client) => setDestinationStatus(client, input)),
    setWorkflowPolicy: (input: SetWorkflowPolicyInput) =>
      edit(input, (client) => setWorkflowPolicy(client, input)),
    clearWorkflowPolicy: (input: ClearWorkflowPolicyInput) =>
      edit(input, (client) => clearWorkflowPolicy(client, input)),
    getWorkflowPolicy: (input: WorkflowPolicyInput) =>
      browse(input, (client) => readWorkflowPolicy(client, input)),
    close: () => lease.close(),
  });
}
