import { VariableEditorFeedback, VariableSaveFeedback } from './feedback';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  canonicalJson,
  workspaceVariableNameSchema,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';
import type {
  WorkspaceVariablesResponse,
  WorkspaceVariablesRequest,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { cn } from '@/lib/utils';
import { replaceVariables, type VariablesScope } from '../data/variables.api';
import { variableKeys, variablesQueryOptions } from '../data/variables.queries';
import {
  variableMatches,
  variableRows,
  variableUnsaved,
  readVariableRows,
  type VariableRow as Row,
} from '../model/draft';
import { VariableColumns } from './columns';
import { VariableRow } from './row';
import { VariableUsageDialog } from './usage';
export function VariablesEditor({
  scope,
  snapshot,
  filter,
}: Readonly<{
  scope: VariablesScope;
  snapshot: WorkspaceVariablesResponse;
  filter: string;
}>) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    base: snapshot,
    rows: variableRows(snapshot.values, snapshot.descriptions),
  }));
  // Rows being edited show their fields; the rest stay one line each.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [inspect, setInspect] =
    useState<Readonly<{ name: string; removeId?: string }>>();
  const [saved, setSaved] = useState<number>();
  const [reloading, setReloading] = useState(false);
  const command = useRetainedCommand(
    (
      body: WorkspaceVariablesRequest & {
        descriptions: WorkspaceVariablesResponse['descriptions'];
      },
      key: string,
    ) => replaceVariables(scope, body, key),
    async (result, body) => {
      const accepted = {
        revision: result.revision,
        values: body.values,
        descriptions: body.descriptions,
      };
      setDraft((current) => ({ ...current, base: accepted }));
      setOpen(new Set());
      setSaved(result.revision);
      setError(undefined);
      const key = variablesQueryOptions(scope).queryKey;
      const current = cache.getQueryData(key);
      if (current === undefined || current.revision <= accepted.revision)
        cache.setQueryData(key, accepted);
      await cache.invalidateQueries({ queryKey: variableKeys.scope(scope) });
    },
    {
      action: 'saving workspace variables',
      expiredMessage:
        'The 24-hour retry window ended. Check the current variables, then reload before saving again.',
    },
  );
  const parsed = readVariableRows(draft.rows);
  const changed =
    parsed.values === undefined ||
    canonicalJson({
      values: parsed.values,
      descriptions: parsed.descriptions,
    }) !==
      canonicalJson({
        values: draft.base.values,
        descriptions: draft.base.descriptions,
      });
  const locked = command.pending || command.uncertain || reloading;
  const visible = draft.rows.filter(
    (row) => open.has(row.id) || variableMatches(row, filter),
  );
  const removalId = inspect?.removeId;
  const serverChanged = snapshot.revision !== draft.base.revision;
  function change(id: string, row: Row) {
    setError(undefined);
    setSaved(undefined);
    command.reset();
    setDraft((current) => ({
      ...current,
      rows: current.rows.map((item) => (item.id === id ? row : item)),
    }));
  }
  function remove(id: string) {
    setError(undefined);
    setSaved(undefined);
    setDraft((current) => ({
      ...current,
      rows: current.rows.filter((row) => row.id !== id),
    }));
    setInspect(undefined);
  }
  function toggle({ id, opened }: Readonly<{ id: string; opened: boolean }>) {
    setOpen((current) => {
      const next = new Set(current);
      if (opened) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  async function reload() {
    if (locked) return;
    setReloading(true);
    try {
      const latest = await cache.query({
        ...variablesQueryOptions(scope),
        staleTime: 0,
      });
      command.reset();
      setError(undefined);
      setSaved(undefined);
      const rows = variableRows(latest.values, latest.descriptions);
      // A variable that was open stays open with its reloaded value.
      const openNames = new Set(
        draft.rows.filter((row) => open.has(row.id)).map((row) => row.name),
      );
      setOpen(
        new Set(
          rows.filter((row) => openNames.has(row.name)).map((row) => row.id),
        ),
      );
      setDraft({ base: latest, rows });
    } catch {
      setError(
        'Current variables could not be loaded. Your edits are kept. Try reloading again.',
      );
    } finally {
      setReloading(false);
    }
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (locked) return;
          if (parsed.values === undefined) {
            setError(parsed.error);
            return;
          }
          setError(undefined);
          void command.send({
            expectedRevision: draft.base.revision,
            values: parsed.values,
            descriptions: parsed.descriptions,
          });
        }}
        className="flex flex-col gap-4"
      >
        <fieldset disabled={locked} className="min-w-0 border-0 p-0">
          <legend className="sr-only">Workspace variables</legend>
          <VariableListHeading
            total={draft.rows.length}
            visible={visible.length}
            filter={filter}
          />
          {visible.map((row) => (
            <VariableRow
              key={row.id}
              row={row}
              open={open.has(row.id)}
              unsaved={variableUnsaved(row, draft.base)}
              onOpen={() => {
                toggle({ id: row.id, opened: true });
              }}
              onClose={() => {
                toggle({ id: row.id, opened: false });
              }}
              onChange={(next) => {
                change(row.id, next);
              }}
              onInspect={() => {
                setInspect({ name: row.name });
              }}
              onRemove={() => {
                if (workspaceVariableNameSchema.safeParse(row.name).success)
                  setInspect({ name: row.name, removeId: row.id });
                else remove(row.id);
              }}
            />
          ))}
          <Button
            className="mt-4"
            type="button"
            variant="outline"
            disabled={draft.rows.length >= WORKSPACE_VARIABLE_LIMITS.count}
            onClick={() => {
              const id = crypto.randomUUID();
              setDraft((current) => ({
                ...current,
                rows: [
                  ...current.rows,
                  { id, name: '', type: 'text', value: '', description: '' },
                ],
              }));
              toggle({ id, opened: true });
              setSaved(undefined);
            }}
          >
            Add variable
          </Button>
        </fieldset>
        <VariableEditorFeedback
          baseRevision={draft.base.revision}
          serverChanged={serverChanged}
          error={error}
          command={command}
        />
        <div
          className={cn(
            'flex flex-wrap items-center gap-3',
            // Unsaved edits keep Save in view however long the list is.
            changed &&
              // On phones it sits above the navigation dock, as run actions do.
              'sticky bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.25rem)] z-10 -mx-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm md:bottom-0',
          )}
        >
          <Button type="submit" variant="primary" disabled={locked || !changed}>
            {command.pending ? 'Saving…' : 'Save variables'}
          </Button>
          {/* Only offered when there is something to discard or newer
              values to load. */}
          {changed || serverChanged ? (
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                void reload();
              }}
            >
              {changed ? 'Discard changes' : 'Load the latest values'}
            </Button>
          ) : null}
          <VariableSaveFeedback revision={saved} />
        </div>
      </form>
      {inspect === undefined ? null : (
        <VariableUsageDialog
          scope={scope}
          name={inspect.name}
          onClose={() => {
            setInspect(undefined);
          }}
          {...(removalId === undefined
            ? {}
            : {
                onRemove: () => {
                  remove(removalId);
                },
              })}
        />
      )}
    </>
  );
}

function VariableListHeading({
  total,
  visible,
  filter,
}: Readonly<{ total: number; visible: number; filter: string }>) {
  if (total === 0)
    return (
      <p className="py-5 text-sm text-muted-foreground">
        No variables yet. Add a reusable non-secret value, such as CURRENCY or
        BASE_URL.
      </p>
    );
  if (visible === 0)
    return (
      <p className="py-5 text-sm text-muted-foreground">
        No variables match “{filter.trim()}”.
      </p>
    );
  return <VariableColumns />;
}
