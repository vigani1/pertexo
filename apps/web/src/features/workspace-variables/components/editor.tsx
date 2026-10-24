import { VariableFields, VariableSaveActions } from './fields';
import { VariableEditorFeedback } from './feedback';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { canonicalJson } from '@pertexo/workflow-model';
import type {
  WorkspaceVariablesResponse,
  WorkspaceVariablesRequest,
} from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { replaceVariables, type VariablesScope } from '../data/variables.api';
import { variableKeys, variablesQueryOptions } from '../data/variables.queries';
import {
  variableMatches,
  variableRows,
  readVariableRows,
  type VariableRow as Row,
} from '../model/draft';
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
  const rows = useVariableRows({
    snapshot,
    onEdit: () => {
      command.reset();
    },
  });
  const { draft, open, error, inspect, saved } = rows.state;
  const {
    change,
    remove,
    toggle,
    add,
    setError,
    setSaved,
    setInspect,
    setDraft,
    setOpen,
  } = rows.actions;
  const [reloading, setReloading] = useState(false);
  const command = useRetainedCommand(
    (
      body: WorkspaceVariablesRequest & {
        descriptions: WorkspaceVariablesResponse['descriptions'];
      },
      key: string,
    ) => replaceVariables(scope, body, key),
    (result, body) =>
      acceptVariables({ scope, cache, actions: rows.actions }, result, body),
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
  const reload = () =>
    reloadVariables({
      scope,
      cache,
      command,
      draft,
      open,
      locked,
      setReloading,
      setError,
      setSaved,
      setOpen,
      setDraft,
    });

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
          <VariableFields
            rows={draft.rows}
            base={draft.base}
            visible={visible}
            open={open}
            filter={filter}
            commands={{
              change,
              toggle,
              inspect: setInspect,
              remove,
              add,
            }}
          />
        </fieldset>
        <VariableEditorFeedback
          baseRevision={draft.base.revision}
          serverChanged={serverChanged}
          error={error}
          command={command}
        />
        <VariableSaveActions
          changed={changed}
          serverChanged={serverChanged}
          locked={locked}
          pending={command.pending}
          saved={saved}
          onReload={() => {
            void reload();
          }}
        />
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

interface VariableDraft {
  base: WorkspaceVariablesResponse;
  rows: Row[];
}
type VariableReloadContext = Readonly<{
  scope: VariablesScope;
  cache: QueryClient;
  command: Pick<ReturnType<typeof useRetainedCommand>, 'reset'>;
  draft: VariableDraft;
  open: ReadonlySet<string>;
  locked: boolean;
  setReloading: (value: boolean) => void;
  setError: (value: string | undefined) => void;
  setSaved: (value: number | undefined) => void;
  setOpen: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setDraft: Dispatch<SetStateAction<VariableDraft>>;
}>;
async function reloadVariables({
  scope,
  cache,
  command,
  draft,
  open,
  locked,
  setReloading,
  setError,
  setSaved,
  setOpen,
  setDraft,
}: VariableReloadContext) {
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

function useVariableRows({
  snapshot,
  onEdit,
}: Readonly<{ snapshot: WorkspaceVariablesResponse; onEdit: () => void }>) {
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
  function change(id: string, row: Row) {
    setError(undefined);
    setSaved(undefined);
    onEdit();
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
  function add() {
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
  }
  return {
    state: { draft, open, error, inspect, saved },
    actions: {
      change,
      remove,
      toggle,
      add,
      setError,
      setSaved,
      setInspect,
      setDraft,
      setOpen,
    },
  };
}

async function acceptVariables(
  {
    scope,
    cache,
    actions,
  }: Readonly<{
    scope: VariablesScope;
    cache: QueryClient;
    actions: Pick<
      ReturnType<typeof useVariableRows>['actions'],
      'setDraft' | 'setOpen' | 'setSaved' | 'setError'
    >;
  }>,
  result: Awaited<ReturnType<typeof replaceVariables>>,
  body: WorkspaceVariablesRequest & {
    descriptions: WorkspaceVariablesResponse['descriptions'];
  },
) {
  const { setDraft, setOpen, setSaved, setError } = actions;
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
}
