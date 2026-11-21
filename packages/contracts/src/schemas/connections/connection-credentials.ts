import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import { connectionProviderKeySchema } from './connection-fields.js';

const { $schema, ...typeProjection } = z.toJSONSchema(
  connectionProviderKeySchema,
);

export const connectionCredentialSchema = boundedNodeJsonRecordSchema
  .refine(
    (credential): credential is typeof credential & { readonly type: string } =>
      connectionProviderKeySchema.safeParse(credential.type).success,
    { path: ['type'], message: 'Expected a connection credential type' },
  )
  .meta({
    type: 'object',
    properties: { type: typeProjection },
    required: ['type'],
  });

export type ParsedConnectionCredential = Readonly<
  Record<string, unknown> & { type: string }
>;
