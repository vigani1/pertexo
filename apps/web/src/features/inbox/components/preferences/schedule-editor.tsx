import {
  acceptedNotificationSchedule,
  notificationEmailUnavailable,
  type ScheduleTarget as Target,
} from '../../model/email-schedule';
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  noticePreferencesRequestSchema,
  noticeDefaultsRequestSchema,
  type NoticePreferencesResponse,
  type NoticePreferencesRequest,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  replaceNotificationDefaults,
  replaceNotificationPreferences,
} from '../../data/preferences.api';
import { notificationPreferencesQueryOptions } from '../../data/preferences.queries';
import { inboxKeys } from '../../data/inbox.queries';
import { NotificationSaveFeedback } from './feedback';
function initial(snapshot: NoticePreferencesResponse, target: Target) {
  const value = target === 'personal' ? snapshot : snapshot.defaults;
  return {
    baseRevision: value.revision,
    mode: value.mode ?? 'inherit',
    hour: String(value.hour),
    timeZone: value.timeZone,
  };
}
export function NotificationScheduleEditor({
  scope,
  snapshot,
  target,
}: {
  scope: WorkspaceApiScope;
  snapshot: NoticePreferencesResponse;
  target: Target;
}) {
  const cache = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState(() => initial(snapshot, target));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [reloading, setReloading] = useState(false);
  const command = useRetainedCommand(
    (body: NoticePreferencesRequest, key: string) =>
      target === 'personal'
        ? replaceNotificationPreferences(scope, body, key)
        : replaceNotificationDefaults(
            scope,
            noticeDefaultsRequestSchema.parse(body),
            key,
          ),
    async (result, body) => {
      cache.setQueryData(
        notificationPreferencesQueryOptions(scope).queryKey,
        (current) =>
          acceptedNotificationSchedule(current, { target, body, result }),
      );
      setDraft((current) => ({ ...current, baseRevision: result.revision }));
      setSaved(true);
      setError(undefined);
      await cache.invalidateQueries({
        queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
      });
    },
    { action: 'saving notification choices' },
  );
  const locked = command.pending || command.uncertain || reloading;
  const serverRevision =
    target === 'personal' ? snapshot.revision : snapshot.defaults.revision;
  const loaded = initial(snapshot, target);
  const changed =
    draft.mode !== loaded.mode ||
    draft.hour !== loaded.hour ||
    draft.timeZone !== loaded.timeZone;
  const stale = serverRevision !== draft.baseRevision;
  function change(patch: Partial<typeof draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    setError(undefined);
    command.reset();
  }
  async function reload() {
    setReloading(true);
    try {
      const latest = await cache.query({
        ...notificationPreferencesQueryOptions(scope),
        staleTime: 0,
      });
      setDraft(initial(latest, target));
      setError(undefined);
      setSaved(false);
      command.reset();
    } catch {
      setError('Current choices could not be loaded. Your edits are kept.');
    } finally {
      setReloading(false);
    }
  }
  const items = [
    ...(target === 'personal'
      ? [
          {
            value: 'inherit',
            label: `Use workspace default (${snapshot.defaults.mode})`,
          },
        ]
      : []),
    { value: 'off', label: 'Off' },
    { value: 'immediate', label: 'Immediate' },
    { value: 'hourly', label: 'Hourly digest' },
    { value: 'daily', label: 'Daily digest' },
  ];
  const idleReloadLabel = changed
    ? 'Discard changes'
    : 'Load the latest choices';
  const unavailable = notificationEmailUnavailable({
    emailAvailable: snapshot.emailAvailable,
    mode: draft.mode,
    defaultMode: snapshot.defaults.mode,
  });
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = noticePreferencesRequestSchema.safeParse({
          mode: draft.mode === 'inherit' ? null : draft.mode,
          hour: Number(draft.hour),
          timeZone: draft.timeZone,
          expectedRevision: draft.baseRevision,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Check the schedule.');
          return;
        }
        void command.send(parsed.data);
      }}
    >
      {stale ? (
        <Notice tone="warning">
          These choices changed elsewhere. Your edits are kept; discard them to
          load the latest choices, then save again.
        </Notice>
      ) : null}
      <NotificationScheduleFields
        id={id}
        items={items}
        draft={draft}
        disabled={locked}
        emailAvailable={snapshot.emailAvailable}
        defaultMode={snapshot.defaults.mode}
        onChange={change}
      />
      {error === undefined ? null : <Notice tone="destructive">{error}</Notice>}
      <NotificationSaveFeedback
        error={command.error}
        cause={command.cause}
        uncertain={command.uncertain}
        expired={command.expired}
        pending={command.pending}
        retry={command.retry}
        saved={saved}
      />
      <NotificationScheduleActions
        pending={command.pending}
        saveDisabled={
          locked || unavailable || serverRevision !== draft.baseRevision
        }
        reloadVisible={changed || stale}
        reloadDisabled={locked}
        reloadPending={reloading}
        reloadLabel={idleReloadLabel}
        onReload={() => void reload()}
      />
    </form>
  );
}

function NotificationScheduleFields({
  id,
  items,
  draft,
  disabled,
  emailAvailable,
  defaultMode,
  onChange,
}: Readonly<{
  id: string;
  items: readonly Readonly<{ value: string; label: string }>[];
  draft: ReturnType<typeof initial>;
  disabled: boolean;
  emailAvailable: boolean;
  defaultMode: NoticePreferencesResponse['defaults']['mode'];
  onChange: (patch: Partial<ReturnType<typeof initial>>) => void;
}>) {
  return (
    <fieldset disabled={disabled} className="contents">
      <LabelledField id={`${id}-mode`} label="Email frequency">
        {(control) => (
          <Select
            items={items}
            value={draft.mode}
            onValueChange={(value) => {
              if (value !== null) onChange({ mode: value });
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  disabled={notificationEmailUnavailable({
                    emailAvailable,
                    mode: item.value,
                    defaultMode,
                  })}
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {draft.mode === 'daily' ? (
        <>
          <LabelledField id={`${id}-hour`} label="Daily hour (0–23)">
            {(control) => (
              <Input
                {...control}
                type="number"
                required
                min={0}
                max={23}
                step={1}
                value={draft.hour}
                onChange={(e) => {
                  onChange({ hour: e.target.value });
                }}
              />
            )}
          </LabelledField>
          <LabelledField
            id={`${id}-zone`}
            label="Time zone"
            description="An IANA name, such as Europe/Paris or UTC."
          >
            {(control) => (
              <Input
                {...control}
                value={draft.timeZone}
                required
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  onChange({ timeZone: e.target.value });
                }}
              />
            )}
          </LabelledField>
        </>
      ) : null}
    </fieldset>
  );
}

function NotificationScheduleActions({
  pending,
  saveDisabled,
  reloadVisible,
  reloadDisabled,
  reloadPending,
  reloadLabel,
  onReload,
}: Readonly<{
  pending: boolean;
  saveDisabled: boolean;
  reloadVisible: boolean;
  reloadDisabled: boolean;
  reloadPending: boolean;
  reloadLabel: string;
  onReload: () => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={saveDisabled}>
        {pending ? 'Saving…' : 'Save choices'}
      </Button>
      {reloadVisible ? (
        <Button
          type="button"
          variant="ghost"
          disabled={reloadDisabled}
          onClick={onReload}
        >
          {reloadPending ? 'Loading…' : reloadLabel}
        </Button>
      ) : null}
    </div>
  );
}
