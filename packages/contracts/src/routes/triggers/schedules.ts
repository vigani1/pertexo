import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';

import { responseReference } from '../../openapi/primitives.js';
import {
  scheduleFireTimesResponseSchema,
  scheduleManagementCommandRequestSchema,
  scheduleManagementCommandResponseSchema,
  scheduleNextRunsQuerySchema,
  scheduleOccurrenceListQuerySchema,
  scheduleOccurrenceListResponseSchema,
  schedulePreviewRequestSchema,
  scheduleTriggerListResponseSchema,
} from '../../schemas/triggers/schedules.js';
import { defineRoute, named, type RouteCapability } from '../define.js';

const WORKFLOW = '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers';
const TRIGGER = `${WORKFLOW}/{triggerId}/schedule` as const;
const workflow = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() });
const trigger = workflow.extend({ triggerId: z.uuid() });

const read = (
  statuses: RouteCapability['statuses'],
): readonly RouteCapability[] => [
  { name: 'workflow:read', statuses, disclosure: 'not_found' },
];
const update: readonly RouteCapability[] = [
  {
    name: 'workflow:update',
    statuses: ACTIVE_WORKSPACE_STATUSES,
    disclosure: 'not_found',
  },
];
const problem = (status: string, name: string) => ({
  [status]: responseReference(name),
});
const readProblems = {
  ...problem('400', 'BadRequest'),
  ...problem('401', 'Unauthenticated'),
  ...problem('403', 'Forbidden'),
  ...problem('404', 'NotFound'),
  ...problem('429', 'RateLimited'),
  ...problem('500', 'Unexpected'),
};
const commandProblems = {
  ...problem('400', 'BadRequest'),
  ...problem('401', 'Unauthenticated'),
  ...problem('403', 'Forbidden'),
  ...problem('404', 'NotFound'),
  ...problem('409', 'Conflict'),
  ...problem('500', 'Unexpected'),
};
const fireTimes = named(
  'ScheduleFireTimesResponse',
  scheduleFireTimesResponseSchema,
);

/** The command takes no fields; an empty object keeps a stray one from looking applied. */
const command = (operationId: string, path: `/${string}`) =>
  defineRoute({
    operationId,
    method: 'post',
    path,
    params: trigger,
    access: { auth: 'session', capabilities: update },
    rateLimit: 'trigger_mutation',
    idempotent: true,
    body: named(
      'ScheduleManagementCommandRequest',
      scheduleManagementCommandRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Schedule trigger command completed',
      body: named(
        'ScheduleManagementCommandResponse',
        scheduleManagementCommandResponseSchema,
      ),
    },
    problems: commandProblems,
  });

export const scheduleRoutes = {
  list: defineRoute({
    operationId: 'listScheduleTriggers',
    method: 'get',
    path: `${WORKFLOW}/schedules`,
    params: workflow,
    access: {
      auth: 'session',
      capabilities: read(BROWSABLE_WORKSPACE_STATUSES),
    },
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Published schedule trigger health',
      body: named(
        'ScheduleTriggerListResponse',
        scheduleTriggerListResponseSchema,
      ),
    },
    problems: {
      ...problem('401', 'Unauthenticated'),
      ...problem('403', 'Forbidden'),
      ...problem('404', 'NotFound'),
      ...problem('500', 'Unexpected'),
    },
  }),
  occurrences: defineRoute({
    operationId: 'listScheduleOccurrences',
    method: 'get',
    path: `${TRIGGER}/occurrences`,
    params: trigger,
    query: scheduleOccurrenceListQuerySchema,
    access: {
      auth: 'session',
      capabilities: read(BROWSABLE_WORKSPACE_STATUSES),
    },
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Retained occurrence metadata, newest first',
      body: named(
        'ScheduleOccurrenceListResponse',
        scheduleOccurrenceListResponseSchema,
      ),
    },
    problems: readProblems,
  }),
  nextRuns: defineRoute({
    operationId: 'listScheduleNextRuns',
    method: 'get',
    path: `${TRIGGER}/next-runs`,
    params: trigger,
    query: scheduleNextRunsQuerySchema,
    access: {
      auth: 'session',
      capabilities: read(BROWSABLE_WORKSPACE_STATUSES),
    },
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Upcoming fire times of a published schedule',
      body: fireTimes,
    },
    problems: readProblems,
  }),
  // Side-effect free, but computed per request like draft validation. Previewing is
  // part of editing a schedule, so it stays with active workspaces.
  preview: defineRoute({
    operationId: 'previewScheduleRuns',
    method: 'post',
    path: `${WORKFLOW}/schedules/preview`,
    params: workflow,
    access: { auth: 'session', capabilities: read(ACTIVE_WORKSPACE_STATUSES) },
    rateLimit: 'workflow_compile',
    body: named('SchedulePreviewRequest', schedulePreviewRequestSchema),
    success: {
      status: 200,
      description:
        'Fire times an unsaved schedule rule would have if published now',
      body: fireTimes,
    },
    problems: readProblems,
  }),
  enable: command('enableScheduleTrigger', `${TRIGGER}/enable`),
  disable: command('disableScheduleTrigger', `${TRIGGER}/disable`),
};
