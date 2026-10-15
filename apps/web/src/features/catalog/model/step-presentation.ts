import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import {
  BoxIcon,
  FileJsonIcon,
  BracesIcon,
  ArrowDownWideNarrowIcon,
  CopyMinusIcon,
  FilterIcon,
  SigmaIcon,
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
  'core.read_file': {
    name: 'Read file',
    description: 'Turn a CSV or JSON file into data',
    icon: FileJsonIcon,
    family: 'transform',
  },
  'core.batch': {
    name: 'Batch items',
    description: 'Split a list into ordered batches',
    icon: SplitIcon,
    family: 'transform',
  },
  'core.take': {
    name: 'Take first items',
    description: 'Keep the first N items in a list',
    icon: ListChecksIcon,
    family: 'transform',
  },
  'core.concat': {
    name: 'Concatenate lists',
    description: 'Append a second list, keeping order and duplicates',
    icon: GitMergeIcon,
    family: 'transform',
  },
  'core.filter': {
    name: 'Filter items',
    description: 'Keep items that match a field or value',
    icon: FilterIcon,
    family: 'transform',
  },
  'core.sort': {
    name: 'Sort items',
    description: 'Order items by a number or text field',
    icon: ArrowDownWideNarrowIcon,
    family: 'transform',
  },
  'core.unique': {
    name: 'Remove duplicates',
    description: 'Keep the first item for each distinct value',
    icon: CopyMinusIcon,
    family: 'transform',
  },
  'core.summarize': {
    name: 'Summarize items',
    description: 'Count and total numbers, optionally by group',
    icon: SigmaIcon,
    family: 'transform',
  },
  'core.date': {
    name: 'Convert date',
    description: 'Format timestamps, convert time zones or add a duration',
    icon: CalendarClockIcon,
    family: 'transform',
  },
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
  'core.call': {
    name: 'Call workflow',
    description: 'Run an exact published workflow and wait for its result',
    icon: GitForkIcon,
    family: 'logic',
  },
  'core.workflow_error': {
    name: 'When a workflow fails',
    description: 'Receive a safe summary after another workflow fails',
    icon: OctagonXIcon,
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

// Named as the Connections page names them, so a slot and its page agree.
const connectionWords: Readonly<Record<string, string>> = {
  slack_bot_token: 'Slack',
  resend_api_key: 'Email · Resend',
  http_headers: 'HTTP',
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
