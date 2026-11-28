import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from '@/components/patterns/states/empty';
import { Row, RowList } from '@/components/patterns/lists/row';
import { StatusMark } from '@/components/patterns/status/status-mark';

/** Nothing starts runs yet: where to add the first trigger. */
export function NoTriggers({
  workspaceId,
  workflowId,
  published,
  runNow,
}: Readonly<{
  workspaceId: string;
  workflowId: string;
  published: boolean;
  runNow: ReactNode;
}>) {
  // The tab's first content sits right under the hub bar, like the Versions
  // tab's empty state: no divider above it.
  return (
    <>
      <Empty spacing="flush">
        <EmptyTitle>
          {published
            ? 'This version starts by hand'
            : 'Nothing is published yet'}
        </EmptyTitle>
        <EmptyDescription>
          {published
            ? 'Runs start only when someone runs the workflow. To start them on their own, add a Webhook, Schedule or Form step in Build, then publish.'
            : 'Triggers come from the published version. Add a trigger step in Build, then publish.'}
        </EmptyDescription>
        <EmptyActions>
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={{ workspaceId, workflowId }}
            className={buttonVariants({ variant: 'primary' })}
          >
            Open Build
          </Link>
          {runNow}
        </EmptyActions>
      </Empty>
      {published ? <WaysIn /> : null}
    </>
  );
}

const WAYS_IN = [
  { name: 'By hand', detail: 'Someone runs it from the workflow.', on: true },
  { name: 'Webhook', detail: 'Another system sends it an event.', on: false },
  { name: 'Schedule', detail: 'It runs on a timetable.', on: false },
  { name: 'Form', detail: 'Someone submits its form.', on: false },
  {
    name: 'On failure',
    detail: 'Another workflow fails and hands its error here.',
    on: false,
  },
] as const;

/** The ways a run can start, with the one this version has lit. */
function WaysIn() {
  return (
    <RowList aria-label="Ways a run can start" className="my-1 max-w-lg">
      {WAYS_IN.map((way) => (
        <Row
          key={way.name}
          lift="none"
          typography="body"
          className="grid-cols-[minmax(0,1fr)_auto] py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)_auto]"
        >
          <span className="font-medium">{way.name}</span>
          <span className="text-muted-foreground max-sm:col-start-1 max-sm:row-start-2 max-sm:text-xs">
            {way.detail}
          </span>
          <StatusMark tone={way.on ? 'success' : 'off'}>
            {way.on ? 'On' : 'Not added'}
          </StatusMark>
        </Row>
      ))}
    </RowList>
  );
}
