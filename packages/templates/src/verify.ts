import {
  canonicalWorkflowPortableJson,
  type PortableIssue,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowPortableManifest,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';

import {
  CURATED_WORKFLOW_TEMPLATES,
  type CuratedTemplateSetupTarget,
  type CuratedWorkflowTemplate,
} from './catalog.js';
import { isCuratedHttpsEndpoint } from './https-endpoint.js';
import { workflowTemplateOriginRequestSchema } from './origin.js';

type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly PortableIssue[] };

function invalid(
  code: string,
  path = 'templateOrigin',
): { readonly ok: false; readonly issues: readonly PortableIssue[] } {
  return {
    ok: false,
    issues: [
      {
        code,
        path,
        message:
          'Reviewed template origin or setup does not match the bounded contract',
      },
    ],
  };
}

/** No coercion, normalization, network access or uploaded values in findings. */
export function validateCuratedTemplateSetupValue(
  valueKind: string,
  value: unknown,
): ValidationResult {
  if (typeof value !== 'string')
    return invalid('template_setup_invalid', 'setup');
  if (valueKind === 'slack_channel_id') {
    return value.length >= 2 &&
      value.length <= 128 &&
      /^[CDGU][A-Z0-9]+$/u.test(value)
      ? { ok: true }
      : invalid('template_setup_invalid', 'setup');
  }
  return valueKind === 'https_endpoint' && isCuratedHttpsEndpoint(value)
    ? { ok: true }
    : invalid('template_setup_invalid', 'setup');
}

function findNodes(graph: WorkflowGraph, id: string): WorkflowNode[] {
  return graph.nodes.flatMap((node) => [
    ...(node.id === id ? [node] : []),
    ...(node.structured === undefined
      ? []
      : findNodes(node.structured.body, id)),
  ]);
}

function restoreTarget(
  manifest: WorkflowPortableManifest,
  base: WorkflowPortableManifest,
  target: CuratedTemplateSetupTarget,
): boolean {
  const nodes = findNodes(manifest.graph, target.nodeId);
  const bases = findNodes(base.graph, target.nodeId);
  const node = nodes[0];
  const baseNode = bases[0];
  if (
    nodes.length !== 1 ||
    bases.length !== 1 ||
    node === undefined ||
    baseNode === undefined
  )
    return false;
  if (target.location === 'config') {
    if (
      !Object.hasOwn(node.config, target.key) ||
      !Object.hasOwn(baseNode.config, target.key) ||
      !validateCuratedTemplateSetupValue(
        target.valueKind,
        node.config[target.key],
      ).ok
    )
      return false;
    (node.config as Record<string, unknown>)[target.key] =
      baseNode.config[target.key];
    return true;
  }
  const mapping = node.inputMappings[target.key];
  const baseMapping = baseNode.inputMappings[target.key];
  if (
    mapping?.kind !== 'literal' ||
    baseMapping?.kind !== 'literal' ||
    !validateCuratedTemplateSetupValue(target.valueKind, mapping.value).ok
  )
    return false;
  (node.inputMappings as Record<string, unknown>)[target.key] = {
    ...mapping,
    value: baseMapping.value,
  };
  return true;
}

/** Exact reviewed literal-only delta. Ordinary catalog/binding/authority admission still required. */
export function verifyCuratedTemplateManifest(
  manifest: unknown,
  origin: unknown,
):
  | { readonly ok: true; readonly descriptor: CuratedWorkflowTemplate }
  | { readonly ok: false; readonly issues: readonly PortableIssue[] } {
  try {
    const request = workflowTemplateOriginRequestSchema.safeParse(origin);
    if (!request.success) return invalid('template_origin_invalid');
    const descriptor = CURATED_WORKFLOW_TEMPLATES.find(
      (candidate) =>
        candidate.templateId === request.data.templateId &&
        candidate.templateVersion === request.data.templateVersion &&
        candidate.baseManifestDigest === request.data.baseManifestDigest,
    );
    if (descriptor === undefined) return invalid('template_origin_unknown');
    const parsed = workflowPortableManifestSchema.safeParse(manifest);
    if (!parsed.success)
      return invalid('template_manifest_invalid', 'manifest');
    for (const target of descriptor.setupTargets) {
      if (!restoreTarget(parsed.data, descriptor.manifest, target))
        return invalid('template_setup_invalid', 'manifest');
    }
    if (
      canonicalWorkflowPortableJson(parsed.data) !==
      canonicalWorkflowPortableJson(descriptor.manifest)
    )
      return invalid('template_manifest_mismatch', 'manifest');
    return { ok: true, descriptor };
  } catch {
    return invalid('template_manifest_invalid', 'manifest');
  }
}
