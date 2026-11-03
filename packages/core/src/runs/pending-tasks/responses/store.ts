import { readFolderScope } from '../../../shared/facts.queries.js';
import { readWorkspacePeople } from '../../../tenant-access/members/discovery.queries.js';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { withWorkspaceAccess } from '../../../shared/workspace-access.js';
import type {
  ApprovalAudienceInspectionRequest,
  ApprovalAudienceQuery,
  PendingTaskListQuery,
} from '@pertexo/contracts';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { respondToTask } from './respond.repository.js';
import { inspectAudience } from './inspect-audience.queries.js';
import { listTasks, projectTask, readTaskRow } from './records.repository.js';
import type {
  PendingTaskDecision,
  PendingTaskRead,
  PendingTaskScope,
  PendingTaskSubmission,
} from './contract.js';

export type PendingTaskStore = ReturnType<typeof createPendingTaskStore>;

const READ_TASKS = {
  mode: 'read',
  capability: 'run:read',
  statuses: BROWSABLE_WORKSPACE_STATUSES,
} as const;
const RESPOND_TO_TASK = {
  mode: 'change',
  capability: 'run:read',
  statuses: ACTIVE_WORKSPACE_STATUSES,
} as const;

export function createPendingTaskStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    close: () => lease.close(),
    list: (input: PendingTaskScope & PendingTaskListQuery) =>
      withWorkspaceAccess(pool, input, READ_TASKS, async (client, role) =>
        listTasks(
          client,
          input,
          role,
          await readFolderScope(client, input, role),
        ),
      ),
    read: (input: PendingTaskRead) =>
      withWorkspaceAccess(pool, input, READ_TASKS, async (client, role) =>
        projectTask(
          await readTaskRow(client, input, {
            role,
            resources: await readFolderScope(client, input, role),
          }),
        ),
      ),
    decide: (input: PendingTaskDecision) =>
      withWorkspaceAccess(pool, input, RESPOND_TO_TASK, async (client, role) =>
        respondToTask(
          client,
          { ...input, kind: 'approval' },
          role,
          await readFolderScope(client, input, role),
        ),
      ),
    submit: (input: PendingTaskSubmission) =>
      withWorkspaceAccess(pool, input, RESPOND_TO_TASK, async (client, role) =>
        respondToTask(
          client,
          { ...input, kind: 'input_request' },
          role,
          await readFolderScope(client, input, role),
        ),
      ),
    inspectAudience: (
      input: PendingTaskScope & ApprovalAudienceInspectionRequest,
    ) =>
      withWorkspaceAccess(
        pool,
        input,
        {
          mode: 'read',
          capability: 'workflow:update',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        (client) => inspectAudience(client, input),
      ),
    audience: (input: PendingTaskScope & ApprovalAudienceQuery) =>
      withWorkspaceAccess(
        pool,
        input,
        {
          mode: 'read',
          capability: 'workflow:update',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
        },
        (client) => readWorkspacePeople(client, input),
      ),
  });
}
