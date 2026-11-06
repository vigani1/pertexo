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

/** Browser rendering choices; display vocabulary belongs to each node definition. */
export type StepPresentation = Readonly<{
  name: string;
  description: string;
  icon: LucideIcon;
  family: StepFamily | 'unknown';
  sideEffect?: string | undefined;
}>;

export const stepIcons: Readonly<Partial<Record<string, LucideIcon>>> =
  Object.freeze({
    'core.text': CaseSensitiveIcon,
    'core.number': HashIcon,
    'core.crypto': BinaryIcon,
    'core.hmac': KeyRoundIcon,
    'core.xml': CodeXmlIcon,
    'core.html': CodeXmlIcon,
    'core.run_values': Table2Icon,
    'core.table_find': Table2Icon,
    'core.table_insert': Table2Icon,
    'core.table_update': Table2Icon,
    'core.table_upsert': Table2Icon,
    'core.table_delete': Table2Icon,
    'core.code': BracesIcon,
    'core.respond_webhook': WebhookIcon,
    'core.create_file': FileJsonIcon,
    'core.read_file': FileJsonIcon,
    'core.batch': SplitIcon,
    'core.take': ListChecksIcon,
    'core.concat': GitMergeIcon,
    'core.filter': FilterIcon,
    'core.sort': ArrowDownWideNarrowIcon,
    'core.unique': CopyMinusIcon,
    'core.summarize': SigmaIcon,
    'core.date': CalendarClockIcon,
    'core.form': ListChecksIcon,
    'core.request_input': ListChecksIcon,
    'core.webhook': WebhookIcon,
    'core.schedule': CalendarClockIcon,
    'core.call': GitForkIcon,
    'core.workflow_error': OctagonXIcon,
    'core.manual': HandIcon,
    'core.set': BracesIcon,
    'core.validate': ListChecksIcon,
    'core.condition': GitBranchIcon,
    'core.switch': SplitIcon,
    'core.parallel': GitForkIcon,
    'core.merge': GitMergeIcon,
    'core.foreach': RepeatIcon,
    'core.approval': HandIcon,
    'core.wait': HourglassIcon,
    'core.terminate': OctagonXIcon,
    'http.request': GlobeIcon,
    'slack.send_message': HashIcon,
    'email.send_notification': MailIcon,
  });
