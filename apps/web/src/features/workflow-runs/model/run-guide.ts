import type {
  GuideEntry,
  GuideSection,
} from '@/components/patterns/status-guide';
import {
  describeNodeStatus,
  describeRunStatus,
  type NodeStatus,
  type RunStatus,
} from './run-status';

// Each status in one plain sentence, in the order people meet them.
const runMeanings: Readonly<Record<RunStatus, string>> = {
  queued: 'Accepted and waiting for a worker to pick it up.',
  running: 'Its steps are running right now.',
  waiting:
    'Paused on purpose, for example by a Wait step. It carries on by itself.',
  succeeded: 'It reached the end and every step it ran finished.',
  failed:
    'A step failed and couldn’t recover. Open the run to see which step and why.',
  timed_out: 'It passed its deadline, so Pertexo stopped it.',
  outcome_unknown:
    'A step may have reached another service, but the result couldn’t be confirmed. Check that service before you run it again.',
  canceled: 'Someone stopped it before it finished.',
};

const RUN_ORDER: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'timed_out',
  'outcome_unknown',
  'canceled',
];

function runEntry(status: RunStatus): GuideEntry {
  const look = describeRunStatus(status);
  return { label: look.label, tone: look.tone, meaning: runMeanings[status] };
}

function stepEntry(status: NodeStatus, meaning: string): GuideEntry {
  const look = describeNodeStatus(status);
  return { label: look.label, tone: look.tone, meaning };
}

const runsSection: GuideSection = {
  title: 'Runs',
  entries: RUN_ORDER.map(runEntry),
};

const triggersSection: GuideSection = {
  title: 'What started a run',
  entries: [
    { label: 'Manual', meaning: 'Someone pressed Run.' },
    { label: 'Schedule', meaning: 'Its Schedule step’s time came round.' },
    { label: 'Webhook', meaning: 'Another service called its webhook URL.' },
    { label: 'API', meaning: 'A program started it through Pertexo’s API.' },
    { label: 'Replay', meaning: 'Someone replayed an earlier run.' },
  ],
};

/** The runs list: its statuses and triggers. */
export const RUN_LIST_GUIDE: readonly GuideSection[] = [
  runsSection,
  triggersSection,
];

/** One run: its statuses, the ones only steps have, and its words. */
export const RUN_PAGE_GUIDE: readonly GuideSection[] = [
  runsSection,
  {
    title: 'Steps also show',
    entries: [
      stepEntry(
        'pending',
        'Next in line. It starts when the steps before it finish.',
      ),
      stepEntry(
        'skipped',
        'Not needed on the path this run took, like the other side of a condition.',
      ),
      {
        label: 'Not reached',
        meaning: 'The run ended before it got to this step.',
      },
    ],
  },
  {
    title: 'Words on this page',
    entries: [
      {
        label: 'Data in',
        meaning:
          'What a step received: the run’s input for the first step, then what the steps before it returned.',
      },
      {
        label: 'Data out',
        meaning: 'What a step returned. Pertexo keeps run data for 30 days.',
      },
      {
        label: 'Attempt',
        meaning:
          'One try at a step. Pertexo retries some failures by itself, and each retry is a new attempt.',
      },
      {
        label: 'Deadline',
        meaning:
          'The latest a run may finish. Past it, the run times out and stops.',
      },
      {
        label: 'Replay',
        meaning:
          'Starts a new run of the same version, with this run’s input or input you change.',
      },
    ],
  },
];
