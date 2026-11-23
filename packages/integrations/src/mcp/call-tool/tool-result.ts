import {
  boundedNodeJsonRecordSchema,
  type SchemaDocument,
} from '@pertexo/node-sdk';
import { z } from 'zod';
import { MCP_LIMITS } from '../mcp-limits.js';
import type { compileBoundedObjectSchema } from '../../structured-data/object-schema.js';
import { callToolFailure } from './call-tool.errors.js';

const resultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: boundedNodeJsonRecordSchema.optional(),
  content: z
    .array(z.object({ type: z.literal('text'), text: z.string() }))
    .max(MCP_LIMITS.contentBlocks)
    .optional(),
});

export function toolResult(
  value: SchemaDocument,
  validate: ReturnType<typeof compileBoundedObjectSchema>,
) {
  if (value.isError === true)
    throw callToolFailure('tool_failed', 'failed', true);
  const result = resultSchema.safeParse(value);
  if (!result.success)
    throw callToolFailure('invalid_response', 'failed', true);
  const { structuredContent, content } = result.data;
  if (structuredContent !== undefined) {
    if (validate?.(structuredContent) === false)
      throw callToolFailure('invalid_response', 'failed', true);
    return { kind: 'structured', data: structuredContent } as const;
  }
  if (content === undefined || validate !== undefined)
    throw callToolFailure('invalid_response', 'failed', true);
  return { kind: 'text', text: content.map(({ text }) => text) } as const;
}
