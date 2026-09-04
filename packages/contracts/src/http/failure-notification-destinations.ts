import { z } from 'zod';
import {
  FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT,
  FailureNotificationDestinationConfigSchema,
  type FailureNotificationDestinationConfig,
} from '@pertexo/workflow-model/failure-notification';

export const failureNotificationDestinationKindSchema = z.enum([
  'slack',
  'email',
]);
export const failureNotificationDestinationStatusSchema = z.enum([
  'enabled',
  'disabled',
]);
export const failureNotificationDestinationConfigSchema =
  FailureNotificationDestinationConfigSchema;

export const failureNotificationDestinationCreateRequestSchema =
  failureNotificationDestinationConfigSchema.describe(
    'Failure notification destination creation request',
  );
export const failureNotificationDestinationAppendVersionRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    config: failureNotificationDestinationConfigSchema,
  })
  .strict();
export const failureNotificationDestinationResponseSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    kind: failureNotificationDestinationKindSchema,
    status: failureNotificationDestinationStatusSchema,
    currentVersion: z.number().int().positive(),
    config: failureNotificationDestinationConfigSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const failureNotificationDestinationListResponseSchema = z
  .object({
    items: z
      .array(failureNotificationDestinationResponseSchema)
      .max(FAILURE_NOTIFICATION_DESTINATION_LIST_LIMIT),
  })
  .strict();
export const workflowFailureNotificationPolicyRequestSchema = z
  .object({ destinationId: z.uuid() })
  .strict();
export const failureNotificationDestinationStatusRequestSchema = z
  .object({ status: failureNotificationDestinationStatusSchema })
  .strict();

export type { FailureNotificationDestinationConfig };
export type FailureNotificationDestinationResponse = z.output<
  typeof failureNotificationDestinationResponseSchema
>;
