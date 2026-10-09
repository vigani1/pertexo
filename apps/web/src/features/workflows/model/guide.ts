import type { GuideSection } from '@/components/patterns/guidance/status-guide';

/** What a workflow's state and the bits of its row mean, in plain words. */
export const WORKFLOW_LIST_GUIDE: readonly GuideSection[] = [
  {
    title: 'Workflows',
    entries: [
      {
        label: 'Draft',
        tone: 'neutral',
        meaning: 'Not published yet. Publish it from Build to run it.',
      },
      {
        label: 'Live',
        tone: 'success',
        meaning:
          'Published and ready. Its trigger starts runs, and you can run it yourself.',
      },
      {
        label: 'Starting',
        tone: 'live',
        meaning: 'Switching its trigger on after a publish.',
      },
      {
        label: 'Stopping',
        tone: 'waiting',
        meaning: 'Switching its trigger off, for example while it’s archived.',
      },
      {
        label: 'Degraded',
        tone: 'attention',
        meaning:
          'Live, but its trigger isn’t fully working. Open it to see what needs fixing.',
      },
      {
        label: 'Error',
        tone: 'failure',
        meaning:
          'Its trigger couldn’t be switched on, so nothing starts it. Open it to see why.',
      },
      {
        label: 'Archived',
        tone: 'canceled',
        meaning: 'Put away. It doesn’t run, and you can restore it any time.',
      },
    ],
  },
  {
    title: 'On each row',
    entries: [
      {
        label: 'Run strip',
        meaning:
          'Its last 20 runs, oldest on the left, each coloured by how it ended.',
      },
      {
        label: 'Updated',
        meaning: 'When it last changed: an edit, a publish or a rename.',
      },
    ],
  },
];
