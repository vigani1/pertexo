import { z } from 'zod';
import { NODE_FAILURE_FIELD_LIMITS } from '@pertexo/node-sdk';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';

export const pollingTriggerHealthSchema = responseSchema(
  z.strictObject({
    kind: z.literal('polling'),
    id: z.uuid(),
    workflowVersionId: z.uuid(),
    nodeId: z
      .string()
      .min(1)
      .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength),
    healthStatus: z.enum([
      'pending',
      'healthy',
      'degraded',
      'unhealthy',
      'disabled',
    ]),
    lastErrorCode: z
      .string()
      .max(NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters)
      .nullable(),
    baselineEstablished: z.boolean(),
    nextPollAt: z.iso.datetime().nullable(),
    paused: z.boolean(),
  }),
);

export type PollingTriggerHealth = z.output<typeof pollingTriggerHealthSchema>;
