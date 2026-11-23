import { mcpToolNameSchema } from '@pertexo/contracts';
import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model';
import { z } from 'zod';
import { compileBoundedObjectSchema } from '../structured-data/object-schema.js';
import type { openMcpSession } from './client.js';
import { MCP_LIMITS } from './mcp-limits.js';
import { McpProtocolError } from './mcp.errors.js';

const toolSchema = z.object({
  name: mcpToolNameSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: boundedNodeJsonRecordSchema,
  outputSchema: boundedNodeJsonRecordSchema.optional(),
  execution: z
    .object({
      taskSupport: z.enum(['forbidden', 'optional', 'required']).optional(),
    })
    .optional(),
});

const pageSchema = z.object({
  tools: z.array(toolSchema).max(MCP_LIMITS.tools),
  nextCursor: z.string().min(1).max(MCP_LIMITS.cursorCharacters).optional(),
});

export async function listTools(
  request: Awaited<ReturnType<typeof openMcpSession>>,
) {
  const tools = new Map<string, z.output<typeof toolSchema>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MCP_LIMITS.pages; page += 1) {
    const response = pageSchema.safeParse(
      await request('tools/list', cursor === undefined ? {} : { cursor }),
    );
    if (!response.success) throw new McpProtocolError('Invalid MCP tool list');
    for (const tool of response.data.tools) {
      if (tools.has(tool.name) || tools.size >= MCP_LIMITS.tools)
        throw new McpProtocolError('MCP tool list exceeds its bounds');
      tools.set(tool.name, tool);
    }
    cursor = response.data.nextCursor;
    if (cursor === undefined) return tools;
    if (cursors.has(cursor))
      throw new McpProtocolError('Repeated MCP tool cursor');
    cursors.add(cursor);
  }
  throw new McpProtocolError('Too many MCP tool list pages');
}

type McpTool = z.output<typeof toolSchema>;

export function prepareTool(tool: McpTool) {
  if (tool.execution?.taskSupport === 'required') return undefined;
  const input = compileToolSchema(tool.inputSchema);
  if (input === undefined) return undefined;
  const output =
    tool.outputSchema === undefined
      ? undefined
      : compileToolSchema(tool.outputSchema);
  if (tool.outputSchema !== undefined && output === undefined) return undefined;
  return {
    inputSchema: boundedNodeJsonRecordSchema.parse(
      JSON.parse(canonicalJson(input.shape)) as unknown,
    ),
    validateInput: input.validate,
    validateOutput: output?.validate,
  };
}

function compileToolSchema(document: McpTool['inputSchema']) {
  const { $schema: dialect, ...shape } = document;
  if (
    dialect !== undefined &&
    dialect !== 'https://json-schema.org/draft/2020-12/schema'
  )
    return undefined;
  const validate = compileBoundedObjectSchema(shape);
  return validate === undefined ? undefined : { shape, validate };
}
