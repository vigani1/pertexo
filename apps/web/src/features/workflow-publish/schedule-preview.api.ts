import {
  scheduleFireTimesResponseSchema,
  schedulePreviewRequestSchema,
  type ScheduleFireTimesResponse,
  type ScheduleStepConfig,
} from '@pertexo/contracts/schemas/schedules';
import type { ApiClient } from '@/lib/api/client';

/** How many upcoming run times the editor shows for a draft rule. */
const PREVIEW_COUNT = 3;

/**
 * When an unsaved Schedule step would run if published now, computed by the
 * server's scheduler. Side-effect free, but a POST, so it carries CSRF.
 */
export function previewScheduleRuns(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{ config: ScheduleStepConfig; signal?: AbortSignal }>,
): Promise<ScheduleFireTimesResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/triggers/schedules/preview`,
    method: 'POST',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    body: schedulePreviewRequestSchema.parse({
      config: input.config,
      count: PREVIEW_COUNT,
    }),
    response: {
      kind: 'json',
      decode: (value) => scheduleFireTimesResponseSchema.parse(value),
    },
  });
}
