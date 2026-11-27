import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover';
import type { EditorPresenceSource } from '@/features/workflow-editor/public';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { formatInitials } from '@/lib/format/initials';
import { cn } from '@/lib/class-names';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { CollaborationScope } from '../data/collaboration.api';
import { presenceTabId, usePresenceLease } from '../data/presence-lease';
import { presenceQuery } from '../data/collaboration.queries';
import {
  PresenceContext,
  useWorkflowPresence,
} from '../model/discussion-context';
import { VIEWING_PRESENCE, type EditingPresence } from '../model/presence';
import { pluralWord } from '@/lib/format/count';
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
  const { apiClient, userId, workspaceId, workflowId } = scope;
  const stableScope = useMemo(
    () => ({ apiClient, userId, workspaceId, workflowId }),
    [apiClient, userId, workspaceId, workflowId],
  );
  const renew = usePresenceLease(stableScope, state, paused);
  const report = useCallback(
    (next: EditingPresence) => {
      if (
        state.current.editing === next.editing &&
        state.current.dirty === next.dirty &&
        state.current.baseRevision === next.baseRevision
      )
        return;
      state.current = next;
      renew.current?.();
    },
    [renew],
  );
  const value = useMemo(
    () => ({ scope: stableScope, tabId: presenceTabId, report }),
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
          <StatusMark tone="neutral">Presence</StatusMark>
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
                  'grid size-6 place-items-center rounded-full border border-background bg-raised font-mono text-micro text-foreground ring-1',
                  presencePresentation(person).ring,
                )}
              >
                {formatInitials(person.displayName)}
              </span>
            ))}
            {people.length > 3 ? (
              <span className="grid size-6 place-items-center rounded-full border border-background bg-raised font-mono text-micro text-muted-foreground ring-1 ring-border-strong">
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
              {pluralWord(
                ownTabs.tabCount,
                'another tab',
                `${String(ownTabs.tabCount)} other tabs`,
              )}
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
