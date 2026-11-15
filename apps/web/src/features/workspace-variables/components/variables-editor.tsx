import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { variablesQueryOptions } from '../data/variables.queries';
import { VariableLeaveConfirmation } from './leave-confirmation';
import { VariableFields, VariableSaveActions } from './variable-fields';
import { VariableEditorFeedback } from './variable-feedback';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { WorkspaceVariablesResponse } from '@pertexo/contracts';
import {
  useVariablesSave,
  type AcceptedVariables,
} from '../data/variables.mutations';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import {
  variableMatches,
  variableDraftChanged,
  variableRows,
  readVariableRows,
  type VariableRow as Row,
} from '../model/variable-draft';
import { VariableUsageDialog } from './variable-usage';
export function VariablesEditor({
  scope,
  snapshot,
  filter,
}: Readonly<{
  scope: WorkspaceApiScope;
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
  const command = useVariablesSave(scope, (accepted) => {
    acceptVariables(rows.actions, accepted);
  });
  const parsed = readVariableRows(draft.rows);
  const changed = variableDraftChanged(draft.base, parsed);
  const locked = command.pending || command.uncertain || reloading;
  const visible = draft.rows.filter(
    (row) => open.has(row.id) || variableMatches(row, filter),
  );
  const removalId = inspect?.removeId;
  const serverChanged = snapshot.revision !== draft.base.revision;

  return (
    <>
      <VariableLeaveConfirmation
        dirty={changed || command.pending}
        uncertain={command.uncertain}
      />
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
            void reloadVariables({
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
  scope: WorkspaceApiScope;
  cache: QueryClient;
  command: Pick<ReturnType<typeof useVariablesSave>, 'reset'>;
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
      staleTime: QUERY_FRESHNESS.none,
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

function acceptVariables(
  {
    setDraft,
    setOpen,
    setSaved,
    setError,
  }: Pick<
    ReturnType<typeof useVariableRows>['actions'],
    'setDraft' | 'setOpen' | 'setSaved' | 'setError'
  >,
  accepted: AcceptedVariables,
) {
  setDraft((current) => ({ ...current, base: accepted }));
  setOpen(new Set());
  setSaved(accepted.revision);
  setError(undefined);
}
