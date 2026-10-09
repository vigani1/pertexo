import './server-only.js';

import { verifyCuratedTemplateManifest } from '@pertexo/templates';
import {
  type WorkflowGraph,
  type WorkflowNode,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';
import {
  parseSupportedPlatformRelease,
  resolvePlatformNodeDefinitionForRelease,
} from './definition-resolution.js';

function nodesIn(graph: WorkflowGraph): readonly WorkflowNode[] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(node.structured === undefined ? [] : nodesIn(node.structured.body)),
  ]);
}

/** Server registration validation is separate from portable config-only admission. */
export function validateRegisteredCuratedTemplateSetup(
  releaseInput: unknown,
  manifest: unknown,
  origin: unknown,
): boolean {
  try {
    const verified = verifyCuratedTemplateManifest(manifest, origin);
    if (!verified.ok) return false;
    const release = parseSupportedPlatformRelease(releaseInput);
    const parsed = workflowPortableManifestSchema.parse(manifest);
    const nodes = nodesIn(parsed.graph);
    for (const target of verified.descriptor.setupTargets) {
      const matching = nodes.filter((node) => node.id === target.nodeId);
      const node = matching[0];
      if (matching.length !== 1 || node === undefined) return false;
      const registration = resolvePlatformNodeDefinitionForRelease(
        release,
        node.definition,
      );
      if (target.location === 'config') {
        if (!registration.configSchema.safeParse(node.config).success)
          return false;
      } else {
        const inputs: Record<string, unknown> = {};
        for (const [key, mapping] of Object.entries(node.inputMappings)) {
          if (mapping.kind !== 'literal') return false;
          inputs[key] = mapping.value;
        }
        if (!registration.inputSchema.safeParse(inputs).success) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
