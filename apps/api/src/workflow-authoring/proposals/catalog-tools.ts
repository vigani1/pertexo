import {
  AGENT_TOOL_LIMITS,
  placeableDefinitions,
  workflowNodes,
  type JsonValue,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { ListNodeDefinitionsService } from '../../catalog/index.js';
import { z } from 'zod';

const CATALOG_SEARCH_PAGE_LIMIT = 12;
const searchArguments = z.strictObject({ query: z.string() });
const detailArguments = z.strictObject({
  key: z.string(),
  version: z.int().positive(),
});

const argumentDocument = z.record(z.string(), z.json());

export const proposalTools = [
  {
    name: 'search_catalog',
    description:
      'Search for steps available in the editor. Use an empty query to browse.',
    inputSchema: argumentDocument.parse(z.toJSONSchema(searchArguments)),
  },
  {
    name: 'get_step_details',
    description:
      'Read the editor definition with exact version, ports and settings.',
    inputSchema: argumentDocument.parse(z.toJSONSchema(detailArguments)),
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
  draft: WorkflowGraph,
): JsonValue {
  const { items, codeSettings } = catalog.execute();
  const placeable = placeableDefinitions(items, codeSettings);
  if (name === 'search_catalog') {
    const parsed = searchArguments.safeParse(args);
    if (!parsed.success) return { issue: 'invalid_search' };
    const query = parsed.data.query.trim().toLowerCase();
    return placeable
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
  const matches = ({ key, version }: typeof parsed.data) =>
    key === parsed.data.key && version === parsed.data.version;
  const item =
    placeable.find(({ definition }) => matches(definition)) ??
    ([...workflowNodes(draft)].some(({ definition }) => matches(definition))
      ? items.find(({ definition }) => matches(definition))
      : undefined);
  if (item === undefined) return { issue: 'step_unavailable' };
  const serialized = JSON.stringify(item);
  return Buffer.byteLength(serialized) > AGENT_TOOL_LIMITS.resultBytes
    ? { issue: 'step_details_too_large' }
    : z.json().parse(JSON.parse(serialized));
}
