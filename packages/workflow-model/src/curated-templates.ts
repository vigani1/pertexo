import { z } from 'zod';

import { CURATED_TEMPLATE_MANIFESTS } from './curated-template-assets.js';
import type { WorkflowGraph, WorkflowNode } from './graph-contract.js';
import {
  canonicalWorkflowPortableJson,
  workflowPortableManifestSchema,
  type PortableIssue,
  type WorkflowPortableManifest,
} from './portability-contract.js';

const originFields = {
  schemaVersion: z.literal(1),
  templateId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  templateVersion: z.number().int().min(1).max(2_147_483_647),
  baseManifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
};

export const workflowTemplateOriginRequestSchema = z
  .object(originFields)
  .strict();
export const workflowTemplateOriginSchema = z
  .object({
    ...originFields,
    creationCommandDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    derivation: z.enum(['direct', 'inherited']),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(canonicalWorkflowPortableJson(value))
        .byteLength <= 512,
  );

export type WorkflowTemplateOriginRequest = z.infer<
  typeof workflowTemplateOriginRequestSchema
>;
export type WorkflowTemplateOrigin = z.infer<
  typeof workflowTemplateOriginSchema
>;
export type CuratedTemplateSetupValueKind =
  'https_endpoint' | 'slack_channel_id';
export interface CuratedTemplateSetupTarget {
  readonly nodeId: string;
  readonly location: 'config' | 'literalInput';
  readonly key: string;
  readonly valueKind: CuratedTemplateSetupValueKind;
}
export interface CuratedWorkflowTemplate {
  readonly schemaVersion: 1;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly baseManifestDigest: string;
  readonly title: string;
  readonly description: string;
  readonly inputSummary: string;
  readonly effectsSummary: string;
  readonly boundsSummary: string;
  readonly supportedProfile: 'validate_activation';
  readonly manifest: WorkflowPortableManifest;
  readonly setupTargets: readonly CuratedTemplateSetupTarget[];
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

const descriptorDetails = [
  {
    templateId: 'webhook-validation-routing',
    baseManifestDigest:
      '054903475c92270db247af785f4be6ba806e68023c167770cb9f767c77bb5239',
    title: 'Validate and route a webhook',
    description:
      'Check a request type and route valid and invalid inputs to explicit outcomes.',
    inputSummary:
      'Webhook request JSON: {"type":"notification"}; missing or other types take the rejected branch.',
    effectsSummary:
      'Only validation and routing. No external provider effects. Publishing and webhook activation are separate.',
    boundsSummary:
      'Five worst-case expanded invocations; no loop; five-minute run limit.',
    setupTargets: [],
  },
  {
    templateId: 'schedule-bounded-batch',
    baseManifestDigest:
      '1ecab1f1b462fca2ad6542178952067eff50311e637caed1342d727fe2817a5d',
    title: 'Schedule a bounded example batch',
    description: 'Process two fixed instructional items in a sequential loop.',
    inputSummary:
      'A registered hourly interval schedule envelope; batch items are fixed alpha/beta literals, not trigger data.',
    effectsSummary:
      'Local Set results only; no provider effects. Publishing and schedule activation are separate.',
    boundsSummary:
      'At most three iterations, concurrency one, six expanded invocations; five-minute run limit.',
    setupTargets: [],
  },
  {
    templateId: 'controlled-http-notification',
    baseManifestDigest:
      'be2a8daaa8d220abf8be00c936df2cc3198cf8e64b88f0713baff8e3cebfdd46',
    title: 'Check an endpoint and notify Slack',
    description:
      'Request an explicitly configured HTTPS endpoint and notify an explicitly configured channel only for status 200.',
    inputSummary:
      'Webhook trigger; configure your endpoint and channel and explicitly bind HTTP and Slack connections before creation.',
    effectsSummary:
      'When separately published and run, performs HTTP GET and may send one Slack message. Other 2xx statuses skip Slack; non-2xx may fail or have unknown outcome. Placeholder values are not runnable setup.',
    boundsSummary:
      'No redirects or loop; one-second provider timeouts, 1,024-byte response limits, six expanded invocations; five-minute run limit.',
    setupTargets: [
      {
        nodeId: 'controlled-http',
        location: 'config',
        key: 'url',
        valueKind: 'https_endpoint',
      },
      {
        nodeId: 'slack-notification',
        location: 'literalInput',
        key: 'channelId',
        valueKind: 'slack_channel_id',
      },
    ],
  },
] as const;

/** Public instructional assets, not capability/selection authority or a safety assertion. */
export const CURATED_WORKFLOW_TEMPLATES: readonly CuratedWorkflowTemplate[] =
  freezeJson(
    descriptorDetails.map((details, index) => {
      const manifest = CURATED_TEMPLATE_MANIFESTS[index];
      if (manifest === undefined)
        throw new Error('Missing reviewed curated template asset');
      return {
        ...details,
        schemaVersion: 1 as const,
        templateVersion: 1,
        supportedProfile: 'validate_activation' as const,
        manifest,
      };
    }),
  );

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

const endpointSchema = z.url().max(2_048);
const credentialQueryName = /(?:auth|credential|secret|token|api[-_]?key)/iu;

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
  if (valueKind !== 'https_endpoint' || value.length > 2_048)
    return invalid('template_setup_invalid', 'setup');
  const parsed = endpointSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data !== value ||
    new TextEncoder().encode(value).byteLength > 2_048
  )
    return invalid('template_setup_invalid', 'setup');
  const url = new URL(value);
  return url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    [...url.searchParams.keys()].every((key) => !credentialQueryName.test(key))
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
