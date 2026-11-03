import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/policy';
import { z } from 'zod';

import { responseReference } from '../../openapi/primitives.js';
import type { NamedSchema, RouteAccess } from '../define.js';
import { named } from '../define.js';

/** Authoring answers "not found" to anyone who may not see the workflow. */
export function session(
  name: AuthorizationCapability,
  statuses: WorkspaceStatusList = ACTIVE_WORKSPACE_STATUSES,
): RouteAccess {
  return {
    auth: 'session',
    capabilities: [{ name, statuses, disclosure: 'not_found' }],
  };
}
export const reading = session('workflow:read', BROWSABLE_WORKSPACE_STATUSES);
export const updating = session('workflow:update');
export const publishing = session('workflow:publish');

export const workspaceParams = z.object({ workspaceId: z.uuid() }).strict();
export const WORKFLOW = '/v1/workspaces/{workspaceId}/workflows/{workflowId}';

const PROBLEMS: Readonly<Record<string, unknown>> = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '500': responseReference('Unexpected'),
};
export const problems = (...statuses: readonly string[]) =>
  Object.fromEntries(statuses.map((status) => [status, PROBLEMS[status]]));
export const readProblems = problems('400', '401', '403', '404', '500');

/** Authoring schemas are recursive enough to need the shared projection. */
export function projected<Schema extends z.ZodType, const Name extends string>(
  name: Name,
  schema: Schema,
): NamedSchema<Schema, Name> {
  return named(name, schema, { projected: true });
}

/** A 409 that is either this command's own problem or the generic one. */
export function conflictOf(...names: readonly string[]) {
  return {
    content: {
      'application/problem+json': {
        schema: {
          oneOf: [
            ...names.map((name) => ({ $ref: `#/components/schemas/${name}` })),
            { $ref: '#/components/schemas/ApiProblem' },
          ],
        },
      },
    },
  };
}
