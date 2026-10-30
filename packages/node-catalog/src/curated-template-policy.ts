import {
  verifyCuratedTemplateManifest,
  type CuratedTemplateSetupTarget,
} from '@pertexo/templates';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { resolvePlatformNodeDefinition } from './catalog.js';

function nodesIn(graph: WorkflowGraph): readonly WorkflowNode[] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(node.structured === undefined ? [] : nodesIn(node.structured.body)),
  ]);
}

/** Server registration validation is separate from portable config-only admission. */
export function validateRegisteredCuratedTemplateSetup(
  manifest: unknown,
  origin: unknown,
): boolean {
  const verified = verifyCuratedTemplateManifest(manifest, origin);
  if (!verified.ok) return false;
  const nodes = nodesIn(verified.manifest.graph);
  for (const target of verified.descriptor.setupTargets) {
    const matching = nodes.filter((node) => node.id === target.nodeId);
    const node = matching[0];
    if (matching.length !== 1 || node === undefined) return false;
    if (!targetSetupIsValid(node, target)) return false;
  }
  return true;
}

function targetSetupIsValid(
  node: WorkflowNode,
  target: CuratedTemplateSetupTarget,
): boolean {
  const registration = resolvePlatformNodeDefinition(node.definition);
  if (target.location === 'config')
    return registration.configSchema.safeParse(node.config).success;
  const inputs: Record<string, unknown> = {};
  for (const [key, mapping] of Object.entries(node.inputMappings)) {
    if (mapping.kind !== 'literal') return false;
    inputs[key] = mapping.value;
  }
  return registration.inputSchema.safeParse(inputs).success;
}
