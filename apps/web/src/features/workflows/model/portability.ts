import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import {
  parsePortableJson,
  PortableJsonError,
  canonicalWorkflowPortableJson,
  workflowPortableManifestSchema,
  WORKFLOW_PORTABILITY_LIMITS,
  type WorkflowPortableManifest,
} from '@pertexo/workflow-model';

const TOO_LARGE =
  'This file is larger than 2 MB, the most a workflow file can be.';
const NOT_JSON =
  'This file isn’t valid JSON. Choose a workflow file exported from Pertexo.';

/** Reads a chosen file, saying in words why one can't be imported. */
export async function readPortableWorkflowFile(
  file: File,
): Promise<WorkflowPortableManifest> {
  if (file.size > WORKFLOW_PORTABILITY_LIMITS.bytes) throw new Error(TOO_LARGE);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error(NOT_JSON);
  }
  let value: unknown;
  try {
    value = parsePortableJson(text);
  } catch (error) {
    throw new Error(portableJsonFailure(error, text));
  }
  const parsed = workflowPortableManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(foreignFileMessage(value));
}

function looksLikeJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Why a JSON file isn't a Pertexo workflow, naming the tool it came from. */
function foreignFileMessage(value: unknown): string {
  const read = (key: string): unknown =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Reflect.get(value, key)
      : undefined;
  if (read('format') === 'pertexo.workflow')
    return 'This Pertexo workflow file is damaged or comes from a newer Pertexo, so it can’t be read here.';
  if (Array.isArray(read('nodes')) && typeof read('connections') === 'object')
    return 'This looks like an n8n workflow. Pertexo imports workflow files exported from Pertexo; rebuild the steps here instead.';
  if (Array.isArray(read('flow')))
    return 'This looks like a Make scenario. Pertexo imports workflow files exported from Pertexo; rebuild the steps here instead.';
  return 'This isn’t a Pertexo workflow file. Choose one made with Export… on a workflow.';
}

/** Fixed name, ephemeral object URL, no source names or resource identifiers. */
export function downloadPortableWorkflow(manifest: WorkflowPortableManifest) {
  const url = URL.createObjectURL(
    new Blob([canonicalWorkflowPortableJson(manifest)], {
      type: 'application/json',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pertexo-workflow.json';
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

type GraphNode = WorkflowPortableManifest['graph']['nodes'][number];

/**
 * The connection slots a file's steps can run without (HTTP to a public
 * API, say), from the catalog; import asks only for the others.
 */
export function optionalConnectionSlots(
  manifest: WorkflowPortableManifest,
  definitions: readonly Pick<
    NodeDefinitionCatalogItem,
    'definition' | 'optionalConnections'
  >[],
): ReadonlySet<string> {
  const optional = new Set<string>();
  const visit = (nodes: readonly GraphNode[]) => {
    for (const node of nodes) {
      const item = definitions.find(
        ({ definition }) =>
          definition.key === node.definition.key &&
          definition.version === node.definition.version,
      );
      for (const slot of item?.optionalConnections ?? [])
        optional.add(connectionSlotKey(node.id, slot));
      if (node.structured !== undefined) visit(node.structured.body.nodes);
    }
  };
  visit(manifest.graph.nodes);
  return optional;
}

export function connectionSlotKey(nodeId: string, slot: string): string {
  return JSON.stringify([nodeId, slot]);
}

function portableJsonFailure(error: unknown, text: string): string {
  const overLimit =
    error instanceof PortableJsonError && error.code === 'portable_json_limit';
  if (overLimit) return TOO_LARGE;
  return looksLikeJson(text)
    ? 'This file is nested too deeply or holds content a workflow file can’t, such as repeated keys.'
    : NOT_JSON;
}
