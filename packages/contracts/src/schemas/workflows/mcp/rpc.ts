import { z } from 'zod';
import { mcpToolNameSchema } from './exposure.js';
import { isRecord } from '@pertexo/workflow-model';
import { idempotencyKeySchema } from '../../shared/transport-headers.js';

const id = z.union([z.string(), z.number().int()]);
const request = z.object({ jsonrpc: z.literal('2.0'), id, method: z.string() });
const toolArguments = z
  .unknown()
  .transform((value, context) => {
    if (isRecord(value)) return value;
    context.addIssue({
      code: 'custom',
      message: 'Tool arguments must be an object.',
    });
    return z.NEVER;
  })
  .meta({ type: 'object' });
const metadata = z.object({
  'pertexo/waitMillis': z.number().int().nonnegative().optional(),
  'pertexo/idempotencyKey': idempotencyKeySchema.optional(),
});
export const mcpRpcRequestSchema = z.discriminatedUnion('method', [
  request.extend({
    method: z.literal('initialize'),
    params: z.object({
      protocolVersion: z.string(),
      capabilities: z.record(z.string(), z.unknown()),
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }),
  }),
  request.extend({ method: z.literal('ping') }),
  request.extend({
    method: z.literal('tools/list'),
    params: z.object({ cursor: mcpToolNameSchema.optional() }).optional(),
  }),
  request.extend({
    method: z.literal('tools/call'),
    params: z.object({
      name: mcpToolNameSchema,
      arguments: toolArguments.default({}),
      _meta: metadata.optional(),
    }),
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('notifications/initialized'),
    id: z.never().optional(),
  }),
]);
export type McpRequest = z.output<typeof mcpRpcRequestSchema>;
export const mcpRpcEnvelopeSchema = request.partial({ id: true });
