import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover';
import type { EditorPresenceSource } from '@/features/workflow-editor/public';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { COLLABORATION_LIMITS } from '@pertexo/contracts';
import { Notice } from '@/components/ui/notice';
import { formatInitials } from '@/lib/format/initials';
import { cn } from '@/lib/utils';
import { Status } from '@/components/ui/status';
import {
  heartbeatPresence,
  type CollaborationScope,
} from '../data/collaboration.api';
import { presenceQuery } from '../data/collaboration.queries';
import { PresenceContext, useWorkflowPresence } from '../model/context';
import {
  browserTabId,
  VIEWING_PRESENCE,
  type EditingPresence,
} from '../model/presence';
// Route remounts and reloads retain the server lease.
const tabId = browserTabId(window.sessionStorage);
let sequence = 0;

export function WorkflowPresenceProvider({
  scope,
  paused = false,
  children,
}: {
  scope: CollaborationScope;
  /** A suspended workspace still shows who's here but records nothing new. */
  paused?: boolean;
  children: ReactNode;
}) {
  const state = useRef(VIEWING_PRESENCE);
  const renew = useRef<(() => void) | undefined>(undefined);
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
    if (paused) return;
    const controller = new AbortController();
    const heartbeat = () => {
      if (document.visibilityState !== 'visible') return;
      void heartbeatPresence(
        stableScope,
        tabId,
        { ...state.current, sequence: ++sequence },
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
  }, [stableScope, cache, paused]);
  const value = useMemo(
    () => ({ scope: stableScope, tabId, report }),
    [stableScope, report],
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
  const everyone = query.data?.people ?? [];
  const people = everyone.filter((person) => person.userId !== scope.userId);
  const ownTabs = everyone.find((person) => person.userId === scope.userId);
  if (everyone.length === 0) return null;
  const names = people.map((person) => person.displayName);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Only your own other tab: worth a word on a wide bar, not a
            // phone's, where it would wrap the title when it arrives.
            className={people.length === 0 ? 'max-sm:hidden' : undefined}
          />
        }
        aria-label={
          people.length === 0
            ? 'Also open in another of your tabs'
            : `Here with you: ${names.join(', ')}`
        }
      >
        {people.length === 0 ? (
          <span className="text-xs text-subtle-foreground">
            Also in another tab
          </span>
        ) : (
          <span aria-hidden="true" className="flex items-center -space-x-1.5">
            {people.slice(0, 3).map((person) => (
              <span
                key={person.userId}
                title={person.displayName}
                className={cn(
                  'grid size-6 place-items-center rounded-full border border-background bg-raised font-mono text-[0.6rem] text-foreground ring-1',
                  presencePresentation(person).ring,
                )}
              >
                {formatInitials(person.displayName)}
              </span>
            ))}
            {people.length > 3 ? (
              <span className="grid size-6 place-items-center rounded-full border border-background bg-raised font-mono text-[0.6rem] text-muted-foreground ring-1 ring-border-strong">
                +{people.length - 3}
              </span>
            ) : null}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>
          {people.length === 0 ? 'Only you' : 'Here with you'}
        </PopoverTitle>
        <ul className="mt-3 space-y-3">
          {people.map((person) => (
            <li key={person.userId} className="space-y-1">
              <p className="wrap-anywhere font-medium">{person.displayName}</p>
              <p className="text-xs text-muted-foreground">
                {presencePresentation(person).status}
                {person.tabCount > 1
                  ? ' · ' + String(person.tabCount) + ' tabs'
                  : ''}
              </p>
            </li>
          ))}
          {ownTabs === undefined ? null : (
            <li className="text-xs text-muted-foreground">
              You also have this workflow open in{' '}
              {ownTabs.tabCount === 1
                ? 'another tab'
                : `${String(ownTabs.tabCount)} other tabs`}
              {ownTabs.dirty ? ', with unsaved changes there' : ''}.
            </li>
          )}
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
  const others = dirty.filter((person) => person.userId !== scope.userId);
  const mine = others.length < dirty.length;
  return (
    <Notice tone="warning">
      <strong>Unsaved changes in another tab.</strong>{' '}
      {others.length === 0
        ? 'You have edits in progress in another tab. Save or discard them there first;'
        : `${others.map((person) => person.displayName).join(', ')}${mine ? ' and you' : ''} ${others.length === 1 && !mine ? 'has' : 'have'} edits in progress. Check with them before saving;`}{' '}
      a stale draft can’t overwrite a newer save.
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

function presencePresentation({
  dirty,
  editing,
}: Readonly<{ dirty: boolean; editing: boolean }>) {
  if (dirty)
    return { ring: 'ring-warning', status: 'Editing · unsaved changes' };
  if (editing) return { ring: 'ring-primary', status: 'Editing' };
  return { ring: 'ring-border-strong', status: 'Viewing' };
}
