import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import {
  KeyRoundIcon,
  CaseSensitiveIcon,
  CodeXmlIcon,
  BinaryIcon,
  Table2Icon,
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

export const registry: Readonly<Record<string, RegistryEntry>> = Object.freeze({
  'core.text': {
    name: 'Format text',
    description: 'Case, trim, replace, split or truncate text',
    icon: CaseSensitiveIcon,
    family: 'transform',
  },
  'core.number': {
    name: 'Format number',
    description: 'Format decimals, percentages and currency',
    icon: HashIcon,
    family: 'transform',
  },
  'core.crypto': {
    name: 'Crypto',
    description: 'Hash text or generate UUIDs and random IDs',
    icon: BinaryIcon,
    family: 'transform',
  },
  'core.hmac': {
    name: 'HMAC signature',
    description: 'Sign text with an encrypted key',
    icon: KeyRoundIcon,
    family: 'transform',
  },
  'core.xml': {
    name: 'Convert XML',
    description: 'Convert XML to JSON and back',
    icon: CodeXmlIcon,
    family: 'transform',
  },
  'core.html': {
    name: 'Extract HTML',
    description: 'Select text or attributes with CSS selectors',
    icon: CodeXmlIcon,
    family: 'transform',
  },
  'core.run_values': {
    name: 'Save run values',
    description: 'Save business values on a run for exact lookup',
    icon: Table2Icon,
    family: 'transform',
  },
  'core.table_find': {
    name: 'Find rows',
    description: 'Find rows in a workspace data table',
    icon: Table2Icon,
    family: 'transform',
  },
  'core.table_insert': {
    name: 'Insert row',
    description: 'Insert row in a workspace data table',
    icon: Table2Icon,
    family: 'action',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  'core.table_update': {
    name: 'Update rows',
    description: 'Update rows in a workspace data table',
    icon: Table2Icon,
    family: 'action',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  'core.table_upsert': {
    name: 'Upsert by key',
    description: 'Upsert by key in a workspace data table',
    icon: Table2Icon,
    family: 'action',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  'core.table_delete': {
    name: 'Delete rows',
    description: 'Delete rows in a workspace data table',
    icon: Table2Icon,
    family: 'action',
    sideEffect: 'This changes real rows in a workspace data table.',
  },
  'core.code': {
    name: 'Code',
    description: 'Transform data with JavaScript or Python',
    icon: BracesIcon,
    family: 'transform',
  },
  'core.respond_webhook': {
    name: 'Respond to webhook',
    description: 'Reply to the waiting webhook caller, then continue',
    icon: WebhookIcon,
    family: 'output',
  },
  'core.create_file': {
    name: 'Create file',
    description: 'Turn data into a CSV, Excel, JSON or text file',
    icon: FileJsonIcon,
    family: 'transform',
  },
  'core.read_file': {
    name: 'Read file',
    description: 'Turn a CSV, Excel or JSON file into data',
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
  'core.form': {
    name: 'Form',
    description: 'Start when someone submits a form',
    icon: ListChecksIcon,
    family: 'trigger',
  },
  'core.request_input': {
    name: 'Request input',
    description: 'Wait for an allowed member to fill in a form',
    icon: ListChecksIcon,
    family: 'logic',
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
    description: 'Wait for parallel branches and pass on what each produced',
    icon: GitMergeIcon,
    family: 'logic',
  },
  'core.foreach': {
    name: 'For each',
    description: 'Repeat steps for every item in a list',
    icon: RepeatIcon,
    family: 'logic',
  },
  'core.approval': {
    name: 'Approval',
    description: 'Pause for an eligible member to approve or reject',
    icon: HandIcon,
    family: 'logic',
  },
  'core.wait': {
    name: 'Wait',
    description: 'Pause for a duration or until called back',
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
