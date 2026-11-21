import { RESOURCE_NAME_MAX_LENGTH } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';
import { NODE_FAILURE_FIELD_LIMITS } from '@pertexo/node-sdk';
export { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import { utf8ByteLength } from '@pertexo/workflow-model';

import {
  connectionIdentifierSchema,
  connectionNameSchema,
  connectionProviderKeySchema,
  connectionResponseFields,
  connectionSecretVersionIdentifierSchema,
} from './connection-fields.js';
import { oauth2ConnectionResponseSchema } from './oauth2-connections.js';
import {
  connectionCredentialSchema,
  type ParsedConnectionCredential,
} from './connection-credentials.js';

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

export const connectionCreateRequestSchema = z
  .strictObject({
    providerKey: connectionProviderKeySchema,
    name: connectionNameSchema,
    credential: connectionCredentialSchema,
  })
  .readonly();

export const connectionRotateSecretRequestSchema = z
  .strictObject({
    expectedSecretVersionId: connectionSecretVersionIdentifierSchema,
    credential: connectionCredentialSchema,
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

export const connectionTestRequestSchema = z.union([
  z.strictObject({ providerKey: connectionProviderKeySchema }).readonly(),
  httpConnectionTestRequestSchema,
  z
    .strictObject({
      providerKey: connectionProviderKeySchema,
      sideEffectDisclosureAccepted: z.literal(true),
    })
    .readonly(),
  z
    .strictObject({
      providerKey: connectionProviderKeySchema,
      transport: z.literal('smtp'),
    })
    .readonly(),
]);

export const connectionResponseSchema = responseSchema(
  z.union([
    z.object(connectionResponseFields).strict().readonly(),
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
  credential: ParsedConnectionCredential;
}>;
export type ConnectionRotateSecretRequest = Readonly<{
  expectedSecretVersionId: string;
  credential: ParsedConnectionCredential;
}>;
export type ConnectionTestRequest = z.input<typeof connectionTestRequestSchema>;
export type ConnectionResponse = z.output<typeof connectionResponseSchema>;
export type ConnectionListResponse = z.output<
  typeof connectionListResponseSchema
>;
export type ConnectionTestResponse = z.output<
  typeof connectionTestResponseSchema
>;
