import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { registry, type StepFamily, type StepPresentation } from './registry';
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

/** `acme_crm.create_contact` → "Create contact". */
export function prettifyDefinitionKey(key: string): string {
  const lastSegment = key.split('.').at(-1) ?? key;
  const words = lastSegment.replaceAll(/[_-]+/gu, ' ').trim();
  if (words === '') return 'Step';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function describeStep(
  definitionKey: string,
  family?: StepFamily,
): StepPresentation {
  const known = registry[definitionKey];
  if (known !== undefined) return known;
  const resolvedFamily = family ?? 'unknown';
  return {
    name: prettifyDefinitionKey(definitionKey),
    description: 'A step from the catalog',
    icon: familyIcons[resolvedFamily],
    family: resolvedFamily,
  };
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
    stepGroups.find(
      (group) =>
        (group.keys?.includes(key) ?? false) ||
        (group.extras?.includes(key) ?? false),
    ) ??
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

// Named as the Connections page names them, so a slot and its page agree.
const connectionWords: Readonly<Record<string, string>> = {
  slack_bot_token: 'Slack',
  resend_api_key: 'Email · Resend',
  hmac_key: 'Signing key',
  http_headers: 'HTTP',
};

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
export function describeConnectionRequirement(requirement: string): string {
  const known = connectionWords[requirement];
  return `${known ?? prettifyDefinitionKey(requirement)} connection`;
}

const retryWords: Readonly<
  Record<NodeDefinitionCatalogItem['retryClass'], string>
> = {
  safe: 'Safe to retry: running it again has no extra effect.',
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
export function portName(port: string): string {
  if (port === WORKFLOW_FAILURE_PORT) return 'Failure';
  const numbered = /^(branch|case)-0*(\d+)$/u.exec(port);
  if (numbered !== null)
    return `${numbered[1] === 'branch' ? 'Branch' : 'Case'} ${numbered[2] ?? ''}`;
  return port === 'default' ? 'Otherwise' : port;
}
