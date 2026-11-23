import {
  CONNECTION_LOOKUP_FIELD,
  INPUT_SCHEMA_SETTING,
  mcpToolNameSchema,
} from '@pertexo/contracts';
import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import { compileBoundedObjectSchema } from '../../structured-data/object-schema.js';
import {
  MCP_AUTH_TYPE,
  MCP_PROVIDER_KEY,
  MCP_TOOLS_LOOKUP,
} from '../connections.definition.js';
import { MCP_LIMITS } from '../mcp-limits.js';

const TOOL_INPUT_SETTING = 'toolInputSchema';
const jsonObject = boundedNodeJsonRecordSchema.meta({
  type: 'object',
  additionalProperties: true,
  anyOf: undefined,
});

export const callToolConfigSchema = z.strictObject({
  toolName: mcpToolNameSchema.meta({
    title: 'Tool',
    [CONNECTION_LOOKUP_FIELD]: {
      providerKey: MCP_PROVIDER_KEY,
      lookup: MCP_TOOLS_LOOKUP,
      slot: MCP_AUTH_TYPE,
      attachTo: TOOL_INPUT_SETTING,
    },
  }),
  [TOOL_INPUT_SETTING]: jsonObject
    .refine(
      (schema) => compileBoundedObjectSchema(schema) !== undefined,
      'Expected a supported tool input schema',
    )
    .meta({
      ...jsonObject.meta(),
      title: 'Tool input schema',
      description: 'Review the tool’s input contract before mapping inputs.',
    }),
});

export const callToolInputSchema = jsonObject.meta({
  ...jsonObject.meta(),
  [INPUT_SCHEMA_SETTING]: TOOL_INPUT_SETTING,
});
export const callToolOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('structured'), data: jsonObject }),
  z.strictObject({
    kind: z.literal('text'),
    text: z.array(z.string()).max(MCP_LIMITS.contentBlocks),
  }),
]);
export type CallToolConfig = z.output<typeof callToolConfigSchema>;
