import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';
import {
  NODE_FAILURE_FIELD_LIMITS,
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
  boundedNodeJsonRecordSchema,
} from '@pertexo/node-sdk';
export { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import { utf8ByteLength } from '@pertexo/workflow-model';

import {
  connectionIdentifierSchema,
  connectionNameSchema,
  connectionResponseFields,
  connectionSecretVersionIdentifierSchema,
} from './connection-fields.js';
import { oauth2ConnectionResponseSchema } from './oauth2-connections.js';
import type { connectionCredentialSchema } from './connection-credentials.js';

const CONNECTIONS_BOUNDS = Object.freeze({
  connectionCursorCharacters: 512,
  connectionPageLimitMaximum: 100,
  urlCharacters: 2048,
  connectionListPageItems: 100,
  workflowNameCharacters: RESOURCE_NAME_MAX_LENGTH,
  operationKeysItemCharacters: 128,
  connectionUsagePageItems: 100,
  errorCodeCharacters: NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters,
  urlBytes: 2048,
});
export {
  connectionProviderKeySchema,
  connectionStatusSchema,
} from './connection-fields.js';

/** How long testing a connection waits for the provider before it gives up. */
export const CONNECTION_TEST_TIMEOUT_MILLIS = 15_000;

const connectionCursorSchema = z
  .string()
  .min(1)
  .max(CONNECTIONS_BOUNDS.connectionCursorCharacters);
const connectionPageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(CONNECTIONS_BOUNDS.connectionPageLimitMaximum);

const connectionCredentialTypeSchema = z
  .string()
  .min(1)
  .max(NODE_IDENTITY_KEY_MAX_CHARACTERS);
const { $schema, ...connectionCredentialTypeProjection } = z.toJSONSchema(
  connectionCredentialTypeSchema,
);

const connectionCredentialEnvelopeSchema = boundedNodeJsonRecordSchema
  .refine(
    (credential): credential is typeof credential & { readonly type: string } =>
      connectionCredentialTypeSchema.safeParse(credential.type).success,
    { path: ['type'], message: 'Expected a connection credential type' },
  )
  .meta({
    type: 'object',
    properties: { type: connectionCredentialTypeProjection },
    required: ['type'],
  });

export const connectionCreateRequestSchema = z
  .strictObject({
    providerKey: z.string().min(1).max(NODE_IDENTITY_KEY_MAX_CHARACTERS),
    name: connectionNameSchema,
    credential: connectionCredentialEnvelopeSchema,
  })
  .readonly();

export const connectionRotateSecretRequestSchema = z
  .strictObject({
    expectedSecretVersionId: connectionSecretVersionIdentifierSchema,
    credential: connectionCredentialEnvelopeSchema,
  })
  .readonly();

const httpConnectionTestRequestSchema = z
  .object({
    url: z
      .url()
      .max(CONNECTIONS_BOUNDS.urlCharacters)
      .refine(
        (value) => utf8ByteLength(value) <= CONNECTIONS_BOUNDS.urlBytes,
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
  z.strictObject({ providerKey: z.literal('postgres') }).readonly(),
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
          'postgres',
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
      items: z
        .array(connectionResponseSchema)
        .max(CONNECTIONS_BOUNDS.connectionListPageItems),
      nextCursor: connectionCursorSchema.nullable(),
    })
    .strict()
    .readonly(),
);

const connectionUsageItemSchema = z
  .object({
    workflowId: z.uuid(),
    workflowName: z
      .string()
      .min(1)
      .max(CONNECTIONS_BOUNDS.workflowNameCharacters),
    workflowLifecycleStatus: z.enum(['active', 'archived']),
    workflowVersionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    isCurrentPublication: z.boolean(),
    operationKeys: z.array(
      z.string().min(1).max(CONNECTIONS_BOUNDS.operationKeysItemCharacters),
    ),
  })
  .strict()
  .readonly();

export const connectionUsageResponseSchema = responseSchema(
  z
    .object({
      items: z
        .array(connectionUsageItemSchema)
        .max(CONNECTIONS_BOUNDS.connectionUsagePageItems),
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
      errorCode: z.string().min(1).max(CONNECTIONS_BOUNDS.errorCodeCharacters),
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

export type ConnectionCreateRequest = Readonly<{
  providerKey: string;
  name: string;
  credential: z.input<typeof connectionCredentialSchema>;
}>;
export type ConnectionRotateSecretRequest = Readonly<{
  expectedSecretVersionId: string;
  credential: z.input<typeof connectionCredentialSchema>;
}>;
export type ConnectionTestRequest = z.input<typeof connectionTestRequestSchema>;
export type ConnectionResponse = z.output<typeof connectionResponseSchema>;
export type ConnectionListResponse = z.output<
  typeof connectionListResponseSchema
>;
export type ConnectionTestResponse = z.output<
  typeof connectionTestResponseSchema
>;
