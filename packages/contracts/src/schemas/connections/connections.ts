import { responseSchema } from '../shared/response-schema.js';
import { signingKeyCredentialSchema } from '@pertexo/node-sdk';
export { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import { utf8ByteLength } from '@pertexo/workflow-model';

import {
  connectionIdentifierSchema,
  connectionNameSchema,
  connectionResponseFields,
  connectionSecretVersionIdentifierSchema,
} from './connection-fields.js';
import {
  oauth2ConnectionResponseSchema,
  oauth2CredentialSchema,
} from './oauth2-connections.js';
import {
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  resendApiKeyCredentialSchema,
  smtpCredentialSchema,
  connectionCredentialSchema,
} from './connection-credentials.js';
export { connectionStatusSchema } from './connection-fields.js';

/** How long testing a connection waits for the provider before it gives up. */
export const CONNECTION_TEST_TIMEOUT_MILLIS = 15_000;

const connectionCursorSchema = z.string().min(1).max(512);
const connectionPageLimitSchema = z.coerce.number().int().min(1).max(100);

export const connectionCreateRequestSchema = z.discriminatedUnion(
  'providerKey',
  [
    z
      .object({
        providerKey: z.literal('signing'),
        name: connectionNameSchema,
        credential: signingKeyCredentialSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        providerKey: z.literal('http'),
        name: connectionNameSchema,
        credential: z.discriminatedUnion('type', [
          httpHeadersCredentialSchema,
          oauth2CredentialSchema,
        ]),
      })
      .strict()
      .readonly(),
    z
      .object({
        providerKey: z.literal('email'),
        name: connectionNameSchema,
        credential: z.discriminatedUnion('type', [
          resendApiKeyCredentialSchema,
          smtpCredentialSchema,
        ]),
      })
      .strict()
      .readonly(),
    z
      .object({
        providerKey: z.literal('slack'),
        name: connectionNameSchema,
        credential: slackBotTokenCredentialSchema,
      })
      .strict()
      .readonly(),
  ],
);

export const connectionRotateSecretRequestSchema = z
  .object({
    expectedSecretVersionId: connectionSecretVersionIdentifierSchema,
    credential: connectionCredentialSchema,
  })
  .strict()
  .readonly();

const httpConnectionTestRequestSchema = z
  .object({
    url: z
      .url()
      .max(2_048)
      .refine(
        (value) => utf8ByteLength(value) <= 2_048,
        'URL exceeds byte limit',
      )
      .refine(
        (value) =>
          /^https:\/\/[^/?#@]+(?:[/?]|$)/u.test(value) && !value.includes('#'),
        'connection tests require an HTTPS URL without credentials or a fragment',
      ),
  })
  .strict()
  .readonly();

const slackConnectionTestRequestSchema = z
  .object({ providerKey: z.literal('slack') })
  .strict()
  .readonly();

const emailConnectionTestRequestSchema = z
  .object({
    providerKey: z.literal('email'),
    sideEffectDisclosureAccepted: z.literal(true),
  })
  .strict()
  .readonly();

export const connectionTestRequestSchema = z.union([
  z
    .object({ providerKey: z.literal('signing') })
    .strict()
    .readonly(),
  httpConnectionTestRequestSchema,
  slackConnectionTestRequestSchema,
  emailConnectionTestRequestSchema,
  z
    .object({ providerKey: z.literal('email'), transport: z.literal('smtp') })
    .strict()
    .readonly(),
]);

export const connectionResponseSchema = responseSchema(
  z.union([
    z
      .object({
        ...connectionResponseFields,
        authType: z.enum([
          'hmac_key',
          'http_headers',
          'slack_bot_token',
          'resend_api_key',
          'smtp',
        ]),
      })
      .strict()
      .readonly(),
    oauth2ConnectionResponseSchema,
  ]),
);

export const connectionListQuerySchema = z
  .object({
    limit: connectionPageLimitSchema.optional(),
    after: connectionCursorSchema.optional(),
  })
  .strict();

export const connectionListResponseSchema = responseSchema(
  z
    .object({
      items: z.array(connectionResponseSchema).max(100),
      nextCursor: connectionCursorSchema.nullable(),
    })
    .strict()
    .readonly(),
);

const connectionUsageItemSchema = z
  .object({
    workflowId: z.uuid(),
    workflowName: z.string().min(1).max(128),
    workflowLifecycleStatus: z.enum(['active', 'archived']),
    workflowVersionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    isCurrentPublication: z.boolean(),
    operationKeys: z.array(z.string().min(1).max(128)),
  })
  .strict()
  .readonly();

export const connectionUsageResponseSchema = responseSchema(
  z
    .object({
      items: z.array(connectionUsageItemSchema).max(100),
      nextCursor: connectionCursorSchema.nullable(),
    })
    .strict()
    .readonly(),
);

export type ConnectionUsageResponse = z.output<
  typeof connectionUsageResponseSchema
>;

const connectionTestOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      httpStatus: z.number().int().min(100).max(599),
      errorCode: z.null(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ok: z.literal(false),
      httpStatus: z.number().int().min(100).max(599).nullable(),
      errorCode: z.string().min(1).max(128),
    })
    .strict()
    .readonly(),
]);

export const connectionTestResponseSchema = responseSchema(
  z
    .object({
      connection: connectionResponseSchema,
      outcome: connectionTestOutcomeSchema,
    })
    .strict()
    .readonly(),
);

export const connectionIdParamSchema = z
  .object({ workspaceId: z.uuid(), connectionId: connectionIdentifierSchema })
  .strict();

export type ConnectionCreateRequest = z.input<
  typeof connectionCreateRequestSchema
>;
export type ConnectionRotateSecretRequest = z.input<
  typeof connectionRotateSecretRequestSchema
>;
export type ConnectionTestRequest = z.input<typeof connectionTestRequestSchema>;
export type ConnectionResponse = z.output<typeof connectionResponseSchema>;
export type ConnectionListResponse = z.output<
  typeof connectionListResponseSchema
>;
export type ConnectionTestResponse = z.output<
  typeof connectionTestResponseSchema
>;
