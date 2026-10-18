import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover';
import type { EditorPresenceSource } from '@/features/workflow-editor/public';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { COLLABORATION_LIMITS } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import {
  heartbeatPresence,
  type CollaborationScope,
} from '../data/collaboration.api';
import { presenceQuery } from '../data/collaboration.queries';
import { PresenceContext, useWorkflowPresence } from '../model/context';
import { VIEWING_PRESENCE, type EditingPresence } from '../model/presence';
export function WorkflowPresenceProvider({
  scope,
  children,
}: {
  scope: CollaborationScope;
  children: ReactNode;
}) {
  const [tabId] = useState(() => crypto.randomUUID());
  const state = useRef(VIEWING_PRESENCE);
  const renew = useRef<(() => void) | undefined>(undefined);
  const sequence = useRef(0);
  const cache = useQueryClient();
  const { apiClient, userId, workspaceId, workflowId } = scope;
  const stableScope = useMemo(
    () => ({ apiClient, userId, workspaceId, workflowId }),
    [apiClient, userId, workspaceId, workflowId],
  );
  const report = useCallback((next: EditingPresence) => {
    if (
      state.current.editing === next.editing &&
      state.current.dirty === next.dirty &&
      state.current.baseRevision === next.baseRevision
    )
      return;
    state.current = next;
    renew.current?.();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const heartbeat = () => {
      if (document.visibilityState !== 'visible') return;
      void heartbeatPresence(
        stableScope,
        tabId,
        { ...state.current, sequence: ++sequence.current },
        controller.signal,
      )
        .then(() => {
          if (!controller.signal.aborted)
            void cache.invalidateQueries({
              queryKey: presenceQuery(stableScope, tabId).queryKey,
            });
        })
        .catch(() => {
          /* Advisory presence expires; draft saves retain their own authority. */
        });
    };
    renew.current = heartbeat;
    heartbeat();
    const timer = window.setInterval(
      heartbeat,
      COLLABORATION_LIMITS.heartbeatMs,
    );
    document.addEventListener('visibilitychange', heartbeat);
    window.addEventListener('online', heartbeat);
    return () => {
      renew.current = undefined;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', heartbeat);
      window.removeEventListener('online', heartbeat);
    };
  }, [stableScope, tabId, cache]);
  const value = useMemo(
    () => ({ scope: stableScope, tabId, report }),
    [stableScope, tabId, report],
  );
  return <PresenceContext value={value}>{children}</PresenceContext>;
}
export function WorkflowPresenceSummary() {
  const { scope, tabId } = useWorkflowPresence();
  const query = useQuery(presenceQuery(scope, tabId));
  if (query.isError)
    return (
      <Popover>
        <PopoverTrigger
          render={<Button type="button" variant="ghost" size="sm" />}
          aria-label="Presence unavailable"
        >
          <Status tone="neutral">Presence</Status>
        </PopoverTrigger>
        <PopoverContent align="end">
          <PopoverTitle>Presence unavailable</PopoverTitle>
          <p className="mt-2 text-sm">
            You can edit and save normally. Presence will retry automatically.
          </p>
        </PopoverContent>
      </Popover>
    );
  const people = query.data?.people ?? [];
  if (people.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        aria-label="People viewing this workflow"
      >
        <Status
          tone={people.some((person) => person.dirty) ? 'attention' : 'live'}
        >
          {String(people.length)} here
        </Status>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>Here with you</PopoverTitle>
        <ul className="mt-3 space-y-3">
          {people.map((person) => (
            <li key={person.userId} className="space-y-1">
              <p className="wrap-anywhere font-medium">
                {person.displayName}
                {person.userId === scope.userId ? ' (your other tab)' : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {person.dirty
                  ? 'Editing · unsaved changes'
                  : person.editing
                    ? 'Editing'
                    : 'Viewing'}
                {person.tabCount > 1
                  ? ' · ' + String(person.tabCount) + ' tabs'
                  : ''}
              </p>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
export function WorkflowPresenceWarning() {
  const { scope, tabId } = useWorkflowPresence();
  const query = useQuery(presenceQuery(scope, tabId));
  const dirty = query.data?.people.filter((person) => person.dirty) ?? [];
  if (dirty.length === 0) return null;
  return (
    <Notice tone="warning">
      <strong>Unsaved changes in another tab.</strong>{' '}
      {dirty.map((person) => person.displayName).join(', ')}{' '}
      {dirty.length === 1 ? 'has' : 'have'} edits in progress. Check with them
      before saving; a stale draft cannot overwrite a newer save.
    </Notice>
  );
}

export function WorkflowEditingPresence({
  source,
}: {
  source: EditorPresenceSource;
}) {
  const { report } = useWorkflowPresence();
  useEffect(() => {
    const unsubscribe = source.subscribe(report);
    return () => {
      unsubscribe();
      report(VIEWING_PRESENCE);
    };
  }, [source, report]);
  return null;
}
