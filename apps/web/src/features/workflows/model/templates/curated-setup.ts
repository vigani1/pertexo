import type { NodeDefinitionListResponse } from '@pertexo/contracts';
import type { WorkflowPortableManifest } from '@pertexo/workflow-model';
import {
  type CuratedWorkflowTemplate,
  validateCuratedTemplateSetupValue,
} from '@pertexo/templates';

export type CuratedTemplate = CuratedWorkflowTemplate;
export type SetupTarget = CuratedTemplate['setupTargets'][number];

export function templateOrigin(template: CuratedTemplate) {
  return {
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    baseManifestDigest: template.baseManifestDigest,
  };
}

export function templateUnavailableReasons(
  template: CuratedTemplate,
  catalog: NodeDefinitionListResponse | undefined,
): string[] {
  if (catalog === undefined) return ['Current catalog is unavailable.'];
  return template.manifest.requirements.definitions.flatMap((required) => {
    const item = catalog.items.find(
      (candidate) =>
        candidate.definition.key === required.key &&
        candidate.definition.version === required.version,
    );
    const pin = `${required.key}@${String(required.version)}`;
    if (item === undefined)
      return [`${pin} is missing from the current catalog.`];
    if (item.configVersion !== required.configVersion)
      return [`${pin} has a different config version in the current catalog.`];
    return [];
  });
}

export function setupValueError(target: SetupTarget, value: string) {
  return validateCuratedTemplateSetupValue(target.valueKind, value).ok
    ? undefined
    : target.valueKind === 'https_endpoint'
      ? 'Use lowercase https://, a lowercase ASCII DNS host and an explicit /path (at most 2,048 bytes). No ports, punycode, userinfo, fragments, dot segments or credential query names; escapes must be uppercase %HH.'
      : 'Use a Slack channel ID of 2–128 characters beginning C, D, G or U, followed by uppercase letters or digits.';
}

/** Only reviewed graph-node properties; never traverse arbitrary literal data. */
export function configureTemplate(
  template: CuratedTemplate,
  values: readonly string[],
): WorkflowPortableManifest | undefined {
  if (
    values.length !== template.setupTargets.length ||
    template.setupTargets.some(
      (target, index) =>
        setupValueError(target, values[index] ?? '') !== undefined,
    )
  )
    return undefined;
  let manifest = structuredClone(template.manifest);
  for (const [index, target] of template.setupTargets.entries()) {
    const node = manifest.graph.nodes.find(
      (candidate) => candidate.id === target.nodeId,
    );
    const value = values[index];
    if (node === undefined || value === undefined) return undefined;
    const mapping = node.inputMappings[target.key];
    if (target.location === 'literalInput' && mapping?.kind !== 'literal')
      return undefined;
    const replacement =
      target.location === 'config'
        ? { ...node, config: { ...node.config, [target.key]: value } }
        : {
            ...node,
            inputMappings: {
              ...node.inputMappings,
              [target.key]: { kind: 'literal' as const, value },
            },
          };
    manifest = {
      ...manifest,
      graph: {
        ...manifest.graph,
        nodes: manifest.graph.nodes.map((candidate) =>
          candidate.id === target.nodeId ? replacement : candidate,
        ),
      },
    };
  }
  return manifest;
}
