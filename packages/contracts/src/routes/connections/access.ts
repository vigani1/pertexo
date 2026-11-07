import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/policy';

import { responseReference } from '../openapi-primitives.js';
import type { RouteAccess } from '../define.js';

function session(
  name: AuthorizationCapability,
  statuses: WorkspaceStatusList,
): RouteAccess {
  return {
    auth: 'session',
    capabilities: [{ name, statuses, disclosure: 'not_found' }],
  };
}

export const managing = session('connection:manage', ACTIVE_WORKSPACE_STATUSES);
export const using = session('connection:use', ACTIVE_WORKSPACE_STATUSES);
export const readingSession = session(
  'connection:read',
  BROWSABLE_WORKSPACE_STATUSES,
);
/** Alert destinations and a workflow's alert policy are read as an editor may. */
export const readingAlerts = session(
  'workflow:update',
  BROWSABLE_WORKSPACE_STATUSES,
);
export const editingWorkflow = session(
  'workflow:update',
  ACTIVE_WORKSPACE_STATUSES,
);

export const problem = (...statuses: readonly string[]) =>
  Object.fromEntries(statuses.map((status) => [status, PROBLEMS[status]]));

const PROBLEMS: Readonly<Record<string, unknown>> = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
  '503': responseReference('ConnectionServiceUnavailable'),
};
