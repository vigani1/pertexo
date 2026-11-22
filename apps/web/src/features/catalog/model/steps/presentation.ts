import { TIMED_OUT_PORT, WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import type {
  ConnectionFormDefinition,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  catalogIcons,
  stepIcons,
  type StepFamily,
  type StepPresentation,
} from './registry';
import {
  BoxIcon,
  BracesIcon,
  GitBranchIcon,
  GlobeIcon,
  OctagonXIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';

const familyIcons: Readonly<Record<StepFamily | 'unknown', LucideIcon>> = {
  trigger: WebhookIcon,
  action: GlobeIcon,
  logic: GitBranchIcon,
  transform: BracesIcon,
  output: OctagonXIcon,
  unknown: BoxIcon,
};

const coreDefinitions = new Map(
  CORE_NODE_CATALOG.definitions.map((item) => [item.definition.key, item]),
);

type StepIdentity = string | NodeDefinitionCatalogItem['definition'];
type StepMetadata = Pick<
  NodeDefinitionCatalogItem,
  'display' | 'family' | 'presentation'
>;

export type DescribeStep = (
  identity: StepIdentity,
  family?: StepFamily,
) => StepPresentation;

/** Index the served versioned definitions. Key-only readers use the latest version. */
export function catalogStepDescriptions(
  items: readonly NodeDefinitionCatalogItem[],
): DescribeStep {
  const versions = new Map<string, Map<number, NodeDefinitionCatalogItem>>();
  const latest = new Map<string, NodeDefinitionCatalogItem>();
  for (const item of items) {
    const { key, version } = item.definition;
    let byVersion = versions.get(key);
    if (byVersion === undefined) {
      byVersion = new Map();
      versions.set(key, byVersion);
    }
    byVersion.set(version, item);
    const previous = latest.get(key);
    if (previous === undefined || previous.definition.version < version)
      latest.set(key, item);
  }
  return (identity, family) => {
    const item =
      typeof identity === 'string'
        ? latest.get(identity)
        : versions.get(identity.key)?.get(identity.version);
    return describeStep(identity, family, item);
  };
}

/** `acme_crm.create_contact` → "Create contact". */
export function prettifyDefinitionKey(key: string): string {
  const lastSegment = key.split('.').at(-1) ?? key;
  const words = lastSegment.replaceAll(/[_-]+/gu, ' ').trim();
  if (words === '') return 'Step';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function describeStep(
  identity: StepIdentity,
  family?: StepFamily,
  metadata?: StepMetadata,
): StepPresentation {
  const key = typeof identity === 'string' ? identity : identity.key;
  const core = coreDefinitions.get(key);
  const resolvedFamily =
    family ?? metadata?.family ?? core?.family ?? 'unknown';
  const presentation = metadata?.presentation;
  const display = metadata?.display ?? core?.display;
  return {
    name: presentation?.name ?? display?.name ?? prettifyDefinitionKey(key),
    description: display?.description ?? 'A step from the catalog',
    sideEffect: display?.sideEffect,
    icon: resolveStepIcon(key, resolvedFamily, presentation?.icon),
    family: resolvedFamily,
  };
}

function resolveStepIcon(
  key: string,
  family: StepFamily | 'unknown',
  icon: string | undefined,
): LucideIcon {
  const servedIcon = icon === undefined ? undefined : catalogIcons.get(icon);
  const coreIcon = Object.hasOwn(stepIcons, key) ? stepIcons[key] : undefined;
  return servedIcon ?? coreIcon ?? familyIcons[family];
}

export type StepGroup = Readonly<{
  id: string;
  family: StepFamily;
  title: string;
  /** Steps this section lists first, in this order. */
  keys?: readonly string[];
  /** Steps from other families shown after this section's own, in this order. */
  extras?: readonly string[];
  /** Takes its family's steps that no section lists. */
  rest?: true;
}>;

/**
 * The add-step sections. Data steps are split by what they work on, the way
 * n8n groups its transform nodes, so a long flat list stays scannable.
 */
export const stepGroups: readonly StepGroup[] = Object.freeze([
  { id: 'start', family: 'trigger', title: 'Start with', rest: true },
  {
    id: 'act',
    family: 'action',
    title: 'Do something',
    // Saving run values acts on the run itself; reading a table sits with its writes.
    extras: ['core.run_values', 'core.table_find'],
    rest: true,
  },
  { id: 'flow', family: 'logic', title: 'Decide & flow', rest: true },
  {
    id: 'lists',
    family: 'transform',
    title: 'Work with lists',
    keys: [
      'core.filter',
      'core.sort',
      'core.unique',
      'core.take',
      'core.summarize',
      'core.batch',
      'core.concat',
    ],
  },
  {
    id: 'values',
    family: 'transform',
    title: 'Text, numbers and dates',
    keys: ['core.text', 'core.number', 'core.date'],
  },
  {
    id: 'files',
    family: 'transform',
    title: 'Files and formats',
    keys: ['core.read_file', 'core.create_file', 'core.xml', 'core.html'],
  },
  {
    id: 'signatures',
    family: 'transform',
    title: 'IDs and signatures',
    keys: ['core.crypto', 'core.hmac'],
  },
  {
    id: 'fields',
    family: 'transform',
    title: 'Fields and code',
    keys: ['core.set', 'core.validate', 'core.code'],
    rest: true,
  },
  { id: 'finish', family: 'output', title: 'Finish', rest: true },
]);

/** The section a step belongs to: the one that lists it, else its family's catch-all. */
export function stepGroupFor(
  key: string,
  family: StepFamily | undefined,
): StepGroup | undefined {
  return (
    stepGroups.find((group) => {
      const isInGroup =
        (group.keys?.includes(key) ?? false) ||
        (group.extras?.includes(key) ?? false);
      return isInGroup;
    }) ??
    stepGroups.find((group) => group.family === family && (group.rest ?? false))
  );
}

const familyWords: Readonly<Record<StepFamily | 'unknown', string>> = {
  trigger: 'Trigger',
  action: 'Action',
  logic: 'Logic',
  transform: 'Data',
  output: 'Finish',
  unknown: 'Step',
};

export function familyWord(family: StepFamily | 'unknown'): string {
  return familyWords[family];
}

/** The connections a step can't run without; optional ones, such as auth for a public API, are left out. */
export function requiredConnections(
  definition: Pick<
    NodeDefinitionCatalogItem,
    'connectionRequirements' | 'optionalConnections'
  >,
): readonly string[] {
  const optional = new Set(definition.optionalConnections ?? []);
  return definition.connectionRequirements.filter(
    (requirement) => !optional.has(requirement),
  );
}

/** A connection requirement such as `slack_bot_token` → "Slack connection". */
export function describeConnectionRequirement(
  requirement: string,
  definitions: readonly ConnectionFormDefinition[],
): string {
  return (
    definitions.find((entry) => entry.authType === requirement)?.presentation
      .requirement ?? `${prettifyDefinitionKey(requirement)} connection`
  );
}

const retryWords: Readonly<
  Record<NodeDefinitionCatalogItem['retryClass'], string>
> = {
  safe: 'Pertexo can automatically retry eligible failures.',
  'idempotent-with-key':
    'Retries reuse an idempotency key, so a retry can’t repeat the effect.',
  unsafe: 'Retries never repeat a possibly dispatched effect.',
};

export function describeRetryBehaviour(
  retryClass: NodeDefinitionCatalogItem['retryClass'],
): string {
  return retryWords[retryClass];
}

/**
 * A port as people read it: "Branch 2" for `branch-02`, "Case 1" for
 * `case-01`, "Otherwise" for a Switch's `default`; other ports as named.
 */
export function portName(port: string, position?: number): string {
  if (port === WORKFLOW_FAILURE_PORT) return 'Failure';
  if (port === TIMED_OUT_PORT) return 'Timed out';
  if (port === 'pass') return 'Pass';
  if (port === 'fail') return 'Fail';
  const numbered = /^(branch|case|category)-0*(\d+)$/u.exec(port);
  if (numbered?.[1] !== undefined) {
    const kind = numbered[1];
    const number =
      position === undefined ? (numbered[2] ?? '') : String(position + 1);
    return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${number}`;
  }
  return port === 'default' ? 'Otherwise' : port;
}
