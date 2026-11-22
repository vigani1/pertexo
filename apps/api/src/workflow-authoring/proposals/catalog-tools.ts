import { AGENT_TOOL_LIMITS, type JsonValue } from '@pertexo/workflow-model';
import type { ListNodeDefinitionsService } from '../../catalog/index.js';
import { z } from 'zod';

const CATALOG_SEARCH_PAGE_LIMIT = 12;
const searchArguments = z.strictObject({ query: z.string() });
const detailArguments = z.strictObject({
  key: z.string(),
  version: z.int().positive(),
});

export const proposalTools = [
  {
    name: 'search_catalog',
    description:
      'Search for steps available in the editor. Use an empty query to browse.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_step_details',
    description:
      'Read the editor definition with exact version, ports and settings.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, version: { type: 'integer' } },
      required: ['key', 'version'],
    },
  },
  {
    name: 'propose_draft',
    description:
      'Return the complete candidate workflow draft graph for review.',
    inputSchema: {
      type: 'object',
      properties: { graph: { type: 'object' } },
      required: ['graph'],
    },
  },
] as const;

export function catalogToolResult(
  catalog: ListNodeDefinitionsService,
  name: string,
  args: unknown,
): JsonValue {
  const { items } = catalog.execute();
  if (name === 'search_catalog') {
    const parsed = searchArguments.safeParse(args);
    if (!parsed.success) return { issue: 'invalid_search' };
    const query = parsed.data.query.trim().toLowerCase();
    return items
      .filter(({ definition, display }) =>
        [definition.key, display?.name, display?.description].some((text) =>
          text?.toLowerCase().includes(query),
        ),
      )
      .slice(0, CATALOG_SEARCH_PAGE_LIMIT)
      .map(({ definition, display }) => ({
        ...definition,
        name: display?.name ?? definition.key,
      }));
  }
  const parsed = detailArguments.safeParse(args);
  if (!parsed.success) return { issue: 'invalid_step_identity' };
  const item = items.find(
    ({ definition }) =>
      definition.key === parsed.data.key &&
      definition.version === parsed.data.version,
  );
  if (item === undefined) return { issue: 'step_unavailable' };
  const serialized = JSON.stringify(item);
  return Buffer.byteLength(serialized) > AGENT_TOOL_LIMITS.resultBytes
    ? { issue: 'step_details_too_large' }
    : z.json().parse(JSON.parse(serialized));
}
