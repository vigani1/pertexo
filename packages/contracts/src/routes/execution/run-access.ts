import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/policy';

import {
  problemResponse,
  responseReference,
} from '../openapi-primitives.js';
import type { RouteAccess } from '../define.js';

export const WORKSPACE = '/v1/workspaces/{workspaceId}';
export const RUN = `${WORKSPACE}/runs/{runId}` as const;

export function capability(
  name: AuthorizationCapability,
  statuses: WorkspaceStatusList,
) {
  return { name, statuses, disclosure: 'not_found' } as const;
}
// Run history stays readable until the workspace is purged.
export const read = capability('run:read', UNPURGED_WORKSPACE_STATUSES);
export const readData = capability(
  'run:read-data',
  UNPURGED_WORKSPACE_STATUSES,
);
export const replay = capability('run:replay', ACTIVE_WORKSPACE_STATUSES);
export const session = (
  ...capabilities: ReturnType<typeof capability>[]
): RouteAccess => ({ auth: 'session', capabilities });
export const sessionOrToken = (
  ...capabilities: ReturnType<typeof capability>[]
): RouteAccess => ({ auth: 'session_or_token', capabilities });

const PROBLEMS: Readonly<Record<string, unknown>> = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '422': responseReference('RunUnprocessable'),
  '500': responseReference('Unexpected'),
};
export const problems = (...statuses: readonly string[]) =>
  Object.fromEntries(statuses.map((status) => [status, PROBLEMS[status]]));
/** What a token caller may also meet: the limiter and token authentication. */
export const tokenProblems = {
  '429': problemResponse('Rate limited; see Retry-After'),
  '503': problemResponse(
    'Automation token authentication, limiter or operation dependencies unavailable',
  ),
};
export const rateLimited = { '429': problemResponse('Rate limited') };
export const noStore = 'private, no-store';
