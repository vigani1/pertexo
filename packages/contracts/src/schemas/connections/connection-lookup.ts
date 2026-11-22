import { responseSchema } from '../shared/response-schema.js';
import {
  NODE_IDENTITY_KEY_MAX_CHARACTERS,
  isBoundedNodeJson,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const CONNECTION_LOOKUP_LIMITS = {
  items: 100,
  labelCharacters: 256,
  descriptionCharacters: 1_024,
  bytes: 256 * 1_024,
  timeoutMillis: 15_000,
  exchanges: 12,
} as const;

const key = z
  .string()
  .min(1)
  .max(NODE_IDENTITY_KEY_MAX_CHARACTERS)
  .regex(/^[a-z][a-z0-9_]*$/u);
const json = z.unknown().refine(isBoundedNodeJson);

export const connectionLookupRequestSchema = z.strictObject({
  providerKey: key,
  lookup: key,
  input: json.optional(),
});

export const connectionLookupResponseSchema = responseSchema(
  z.strictObject({
    items: z
      .array(
        z.strictObject({
          value: z
            .string()
            .min(1)
            .max(CONNECTION_LOOKUP_LIMITS.labelCharacters),
          label: z
            .string()
            .min(1)
            .max(CONNECTION_LOOKUP_LIMITS.labelCharacters),
          description: z
            .string()
            .max(CONNECTION_LOOKUP_LIMITS.descriptionCharacters)
            .optional(),
          attach: json.optional(),
          unavailableReason: key.optional(),
        }),
      )
      .max(CONNECTION_LOOKUP_LIMITS.items),
  }),
);

export type ConnectionLookupRequest = z.output<
  typeof connectionLookupRequestSchema
>;
export type ConnectionLookupResponse = z.output<
  typeof connectionLookupResponseSchema
>;

export const CONNECTION_LOOKUP_PATH =
  '/v1/workspaces/{workspaceId}/connections/{connectionId}/lookup';

export const CONNECTION_LOOKUP_FIELD = 'x-pertexo-connection-lookup';
export const INPUT_SCHEMA_SETTING = 'x-pertexo-input-schema-setting';
export const connectionLookupFieldSchema = z.strictObject({
  providerKey: key,
  lookup: key,
  slot: key,
  attachTo: z.string().min(1).max(NODE_IDENTITY_KEY_MAX_CHARACTERS).optional(),
});
export type ConnectionLookupField = z.output<
  typeof connectionLookupFieldSchema
>;

export function connectionLookupPath(
  workspaceId: string,
  connectionId: string,
): `/v1${string}` {
  return CONNECTION_LOOKUP_PATH.replace(
    '{workspaceId}',
    encodeURIComponent(workspaceId),
  ).replace(
    '{connectionId}',
    encodeURIComponent(connectionId),
  ) as `/v1${string}`;
}
