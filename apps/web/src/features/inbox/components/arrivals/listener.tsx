import type {
  WorkspaceInboxSummaryResponse,
  WorkspaceInboxThread,
} from '@pertexo/contracts';
import { Toast } from '@base-ui/react/toast';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { InboxArrivalCard } from './inbox-arrival-card';
import {
  useMarkThreadReadMutation,
  type InboxScope,
} from '../../data/inbox.mutations';
import {
  ARRIVAL_GAP_PX,
  mergeArrivals,
  type InboxArrivalData,
  type InboxArrivalSide,
} from '../../model/inbox-arrival';
import { useInboxArrivals } from './use-subscription';

/** Long enough to read a name and a step and decide; hovering pauses it. */
const ARRIVAL_TIMEOUT_MS = 8_000;

/** The Inbox destination the notice hangs from, and which side it opens on. */
export type InboxArrivalAnchor = Readonly<{
  element: Element;
  side: InboxArrivalSide;
}>;

type ArrivalManager = ReturnType<
  typeof Toast.createToastManager<InboxArrivalData>
>;

function ArrivalList({
  workspaceId,
  onOpenRun,
}: Readonly<{
  workspaceId: string;
  onOpenRun: (thread: WorkspaceInboxThread) => void;
}>) {
  const { toasts, close } = Toast.useToastManager<InboxArrivalData>();
  return toasts.map((toast) => {
    const card = (
      <InboxArrivalCard
        key={toast.id}
        workspaceId={workspaceId}
        toast={toast}
        onOpenRun={(thread) => {
          onOpenRun(thread);
          close(toast.id);
        }}
        onOpenInbox={() => {
          close(toast.id);
        }}
      />
    );
    return toast.positionerProps === undefined ? (
      card
    ) : (
      <Toast.Positioner
        key={toast.id}
        toast={toast}
        className="z-45 data-anchor-hidden:hidden"
      >
        {card}
      </Toast.Positioner>
    );
  });
}

/**
 * Shows one notice when a workflow starts failing, or fails again, while the
 * person is in the workspace. Failures that arrive while it shows join it;
 * failures that arrive while the tab is hidden wait until it is shown. The
 * notice hangs from the Inbox destination when one is on screen.
 */
export function InboxArrivals({
  scope,
  summary,
  quiet,
  findAnchor,
}: Readonly<{
  scope: InboxScope;
  summary: WorkspaceInboxSummaryResponse | undefined;
  /** The inbox page is open: its list shows new failures in place. */
  quiet: boolean;
  findAnchor: () => InboxArrivalAnchor | undefined;
}>) {
  const [manager] = useState<ArrivalManager>(() =>
    Toast.createToastManager<InboxArrivalData>(),
  );
  const showing = useRef<
    Readonly<{ id: string; data: InboxArrivalData }> | undefined
  >(undefined);
  const pending = useRef<readonly WorkspaceInboxThread[]>([]);
  const markRead = useMarkThreadReadMutation(scope);

  function present(arrived: readonly WorkspaceInboxThread[]) {
    if (document.visibilityState === 'hidden') {
      pending.current = mergeArrivals(pending.current, arrived);
      return;
    }
    const current = showing.current;
    const [newest, ...rest] = mergeArrivals(
      current?.data.threads ?? [],
      arrived,
    );
    if (newest === undefined) return;
    if (current !== undefined) {
      const data = {
        ...current.data,
        threads: [newest, ...rest] as const,
        sequence: current.data.sequence + 1,
      };
      showing.current = { id: current.id, data };
      manager.update(current.id, { data, timeout: ARRIVAL_TIMEOUT_MS });
      return;
    }
    const anchor = findAnchor();
    const data: InboxArrivalData = {
      threads: [newest, ...rest],
      sequence: 0,
      ...(anchor === undefined ? {} : { side: anchor.side }),
    };
    const id = manager.add({
      data,
      timeout: ARRIVAL_TIMEOUT_MS,
      ...(anchor === undefined
        ? {}
        : {
            positionerProps: {
              anchor: anchor.element,
              // The spine and the phone bar are fixed; so is the notice.
              positionMethod: 'fixed',
              side: anchor.side,
              sideOffset: ARRIVAL_GAP_PX[anchor.side],
              collisionPadding: 12,
            },
          }),
      onClose: () => {
        if (showing.current?.id === id) showing.current = undefined;
      },
    });
    showing.current = { id, data };
  }

  useInboxArrivals(scope, summary, (arrived) => {
    if (!quiet) present(arrived);
  });

  const flush = useEffectEvent(() => {
    if (document.visibilityState === 'hidden') return;
    const waiting = pending.current;
    pending.current = [];
    if (waiting.length > 0) present(waiting);
  });
  useEffect(() => {
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

  // Opening the inbox shows everything the notice would.
  useEffect(() => {
    if (!quiet) return;
    pending.current = [];
    if (showing.current !== undefined) manager.close(showing.current.id);
  }, [manager, quiet]);

  // A notice belongs to the workspace it arrived in.
  useEffect(
    () => () => {
      pending.current = [];
      if (showing.current !== undefined) manager.close(showing.current.id);
    },
    [manager, scope.workspaceId],
  );

  return (
    <Toast.Provider toastManager={manager} limit={1}>
      <Toast.Portal>
        {/* Above the spine it hangs from, below dialogs and sheets. */}
        <Toast.Viewport
          aria-label="New failures"
          className="fixed top-0 left-0 z-45 outline-none"
        >
          <ArrivalList
            workspaceId={scope.workspaceId}
            onOpenRun={(thread) => {
              markRead.mutate({
                workflowId: thread.workflowId,
                revision: thread.revision,
              });
            }}
          />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
