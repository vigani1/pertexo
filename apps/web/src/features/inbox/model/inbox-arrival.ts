import type { WorkspaceInboxThread } from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import { describeRunStatus } from '@/features/workflow-runs/run-labels.public';
import { describeInboxThread } from './inbox-thread';

/** Revisions are PostgreSQL bigints as decimal strings; compare them exactly. */
export function isLaterRevision(revision: string, than: string): boolean {
  return BigInt(revision) > BigInt(than);
}

/**
 * The unread notices that changed after the revision this tab last saw: a
 * workflow that started failing, or failed again, while the person was here.
 */
export function arrivedThreads(
  threads: readonly WorkspaceInboxThread[],
  since: string,
): WorkspaceInboxThread[] {
  return threads.filter(
    (thread) => thread.unread && isLaterRevision(thread.revision, since),
  );
}

/**
 * Adds new arrivals to the ones still showing: one entry per workflow, at its
 * newest failure, newest first.
 */
export function mergeArrivals(
  showing: readonly WorkspaceInboxThread[],
  arrived: readonly WorkspaceInboxThread[],
): WorkspaceInboxThread[] {
  const byWorkflow = new Map(
    showing.map((thread) => [thread.workflowId, thread]),
  );
  for (const thread of arrived) {
    const shown = byWorkflow.get(thread.workflowId);
    if (shown === undefined || isLaterRevision(thread.revision, shown.revision))
      byWorkflow.set(thread.workflowId, thread);
  }
  return [...byWorkflow.values()].sort((left, right) =>
    isLaterRevision(right.revision, left.revision) ? 1 : -1,
  );
}

/** Which side of the Inbox icon the notice opens on: the spine, or the phone bar. */
export type InboxArrivalSide = 'right' | 'top';

export type InboxArrivalData = Readonly<{
  threads: readonly [WorkspaceInboxThread, ...WorkspaceInboxThread[]];
  /** Changes when more failures join, restarting the timer thread. */
  sequence: number;
  side?: InboxArrivalSide;
}>;

/**
 * Swiping the notice toward the Inbox files it away: left into the spine,
 * down into the phone bar.
 */
export const ARRIVAL_SWIPE_DIRECTION: Readonly<
  Record<InboxArrivalSide, 'left' | 'down'>
> = {
  right: 'left',
  top: 'down',
};

/** How far the notice sits from the icon: the snag thread spans the gap. */
export const ARRIVAL_GAP_PX: Readonly<Record<InboxArrivalSide, number>> = {
  right: 48,
  top: 36,
};

/** At most this many glyphs; the text carries the exact count. */
const MAX_MARKS = 5;

/** How the arrival notice reads: one failing workflow, or several at once. */
export type InboxArrivalView = Readonly<{
  tone: StatusTone;
  /** "Failed", "Timed out" or "3 workflows". */
  kicker: string;
  title: string;
  detail: string;
  /**
   * One glyph per failure of the workflow, or per workflow when several
   * arrive together, capped; `more` counts the rest.
   */
  marks: readonly StatusTone[];
  more: number;
  /** The single thread, or undefined when the notice groups several. */
  thread?: WorkspaceInboxThread;
}>;

function listNames(threads: readonly WorkspaceInboxThread[]): string {
  const [first, second, ...rest] = threads.map((thread) => thread.workflowName);
  if (second === undefined) return first ?? '';
  if (rest.length === 0) return `${first ?? ''} and ${second}`;
  return `${first ?? ''}, ${second} and ${String(rest.length)} more`;
}

export function describeInboxArrival(
  threads: readonly [WorkspaceInboxThread, ...WorkspaceInboxThread[]],
): InboxArrivalView {
  const [newest] = threads;
  const look = describeRunStatus(newest.kind);
  if (threads.length === 1) {
    const view = describeInboxThread(newest);
    return {
      tone: look.tone,
      kicker: look.label,
      title: newest.workflowName,
      detail:
        view.step === undefined
          ? view.occurrences
          : `${view.occurrences} · at ${view.step}`,
      marks: Array.from(
        { length: Math.min(newest.occurrenceCount, MAX_MARKS) },
        () => look.tone,
      ),
      more: Math.max(0, newest.occurrenceCount - MAX_MARKS),
      thread: newest,
    };
  }
  return {
    tone: look.tone,
    kicker: `${String(threads.length)} workflows`,
    title: 'Several workflows are failing',
    detail: listNames(threads),
    marks: threads
      .slice(0, MAX_MARKS)
      .map((thread) => describeRunStatus(thread.kind).tone),
    more: Math.max(0, threads.length - MAX_MARKS),
  };
}
