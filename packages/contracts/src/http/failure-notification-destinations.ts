import { z } from 'zod';
import {
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
  failureNotificationDestinationConfigSchema;
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
  .object({ items: z.array(failureNotificationDestinationResponseSchema) })
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
