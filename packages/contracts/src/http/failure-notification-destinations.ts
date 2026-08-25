import { z } from 'zod';

const slackChannelIdSchema = z.string().regex(/^[CDGU][A-Z0-9]{1,79}$/u);
export const failureNotificationDestinationKindSchema = z.enum([
  'slack',
  'email',
]);
export const failureNotificationDestinationStatusSchema = z.enum([
  'enabled',
  'disabled',
]);
export const failureNotificationDestinationConfigSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('slack'),
        connectionId: z.uuid(),
        channelId: slackChannelIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('email'),
        connectionId: z.uuid(),
        toEmail: z
          .email()
          .max(254)
          .overwrite((value) => {
            const at = value.lastIndexOf('@');
            return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
          }),
      })
      .strict(),
  ],
);

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

export type FailureNotificationDestinationConfig = z.output<
  typeof failureNotificationDestinationConfigSchema
>;
export type FailureNotificationDestinationResponse = z.output<
  typeof failureNotificationDestinationResponseSchema
>;
