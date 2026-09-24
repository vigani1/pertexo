import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  BoxIcon,
  BracesIcon,
  CalendarClockIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  GlobeIcon,
  HandIcon,
  HashIcon,
  HourglassIcon,
  ListChecksIcon,
  MailIcon,
  OctagonXIcon,
  RepeatIcon,
  SplitIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';

export type StepFamily = NodeDefinitionCatalogItem['family'];

/**
 * How a step reads to people: a name, one line about what it does, an icon
 * and its family colour. The catalog has no display metadata yet, so this
 * client registry keyed by definition key fills the gap; unknown keys fall
 * back to a prettified key rather than leaking the raw identifier.
 */
export type StepPresentation = Readonly<{
  name: string;
  description: string;
  icon: LucideIcon;
  family: StepFamily | 'unknown';
  /** Plain words for what a real test of this step does outside Pertexo. */
  sideEffect?: string;
}>;

type RegistryEntry = Omit<StepPresentation, 'family'> &
  Readonly<{ family: StepFamily }>;

const registry: Readonly<Record<string, RegistryEntry>> = Object.freeze({
  'core.webhook': {
    name: 'Webhook',
    description: 'Start when another app sends a request',
    icon: WebhookIcon,
    family: 'trigger',
  },
  'core.schedule': {
    name: 'Schedule',
    description: 'Start on a repeating timetable',
    icon: CalendarClockIcon,
    family: 'trigger',
  },
  'core.manual': {
    name: 'Manual start',
    description: 'Start when someone runs it by hand',
    icon: HandIcon,
    family: 'trigger',
  },
  'core.set': {
    name: 'Set fields',
    description: 'Build an object from mapped values',
    icon: BracesIcon,
    family: 'transform',
  },
  'core.validate': {
    name: 'Validate',
    description: 'Check data against rules before continuing',
    icon: ListChecksIcon,
    family: 'transform',
  },
  'core.condition': {
    name: 'Condition',
    description: 'Send the run down the true or false branch',
    icon: GitBranchIcon,
    family: 'logic',
  },
  'core.switch': {
    name: 'Switch',
    description: 'Route the run to one of several cases',
    icon: SplitIcon,
    family: 'logic',
  },
  'core.parallel': {
    name: 'Parallel',
    description: 'Run several branches at the same time',
    icon: GitForkIcon,
    family: 'logic',
  },
  'core.merge': {
    name: 'Merge',
    description: 'Wait for parallel branches and join them',
    icon: GitMergeIcon,
    family: 'logic',
  },
  'core.foreach': {
    name: 'For each',
    description: 'Repeat steps for every item in a list',
    icon: RepeatIcon,
    family: 'logic',
  },
  'core.wait': {
    name: 'Wait',
    description: 'Pause the run for a set time',
    icon: HourglassIcon,
    family: 'logic',
  },
  'core.terminate': {
    name: 'Stop run',
    description: 'End the run here with a result',
    icon: OctagonXIcon,
    family: 'output',
  },
  'http.request': {
    name: 'HTTP request',
    description: 'Call a web API',
    icon: GlobeIcon,
    family: 'action',
    sideEffect: 'This sends a real HTTP request to the address you set up.',
  },
  'slack.send_message': {
    name: 'Send Slack message',
    description: 'Post text to a channel',
    icon: HashIcon,
    family: 'action',
    sideEffect: 'This sends a real Slack message.',
  },
  'email.send_notification': {
    name: 'Send email',
    description: 'Email a notification',
    icon: MailIcon,
    family: 'action',
    sideEffect: 'This sends a real email.',
  },
});

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

export const stepGroups: readonly Readonly<{
  family: StepFamily;
  title: string;
}>[] = Object.freeze([
  { family: 'trigger', title: 'Start with' },
  { family: 'action', title: 'Do something' },
  { family: 'logic', title: 'Decide & flow' },
  { family: 'transform', title: 'Shape data' },
  { family: 'output', title: 'Finish' },
]);

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

const connectionWords: Readonly<Record<string, string>> = {
  slack_bot_token: 'Slack',
  resend_api_key: 'Email (Resend)',
  http_headers: 'HTTP headers',
};

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
  unsafe:
    'Won’t retry automatically, because repeating it could repeat its effect.',
};

export function describeRetryBehaviour(
  retryClass: NodeDefinitionCatalogItem['retryClass'],
): string {
  return retryWords[retryClass];
}
