import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';

import {
  usageCapacityResponseSchema,
  workflowRunListParamsSchema,
} from '../../schemas/execution/runs.js';
import {
  usageTrendsQuerySchema,
  usageTrendsResponseSchema,
} from '../../schemas/execution/usage-trends.js';
import { defineRoute, named } from '../define.js';
import {
  capability,
  noStore,
  problems,
  rateLimited,
  read,
  session,
  WORKSPACE,
} from './run-access.js';

/** Operational usage, not billing. */
export const usageRoutes = {
  trends: defineRoute({
    operationId: 'getWorkspaceUsageTrends',
    method: 'get',
    path: `${WORKSPACE}/usage-trends`,
    params: workflowRunListParamsSchema,
    query: usageTrendsQuerySchema,
    access: session(read),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Retained ordinary-run trends over UTC days; not billing',
      body: named('UsageTrendsResponse', usageTrendsResponseSchema),
    },
    problems: {
      ...problems('400', '401', '403', '404'),
      ...rateLimited,
      ...problems('500'),
    },
  }),
  capacity: defineRoute({
    operationId: 'getWorkspaceUsageCapacity',
    method: 'get',
    path: `${WORKSPACE}/usage-capacity`,
    params: workflowRunListParamsSchema,
    access: session(
      read,
      capability('artifact:read', BROWSABLE_WORKSPACE_STATUSES),
    ),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Current operational capacity; not billing',
      body: named('UsageCapacityResponse', usageCapacityResponseSchema),
    },
    problems: problems('400', '401', '403', '404', '500'),
  }),
};
