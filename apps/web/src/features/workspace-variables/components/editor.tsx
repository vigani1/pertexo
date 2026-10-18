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
import { replaceVariables, type VariablesScope } from '../data/variables.api';
import { variableKeys, variablesQueryOptions } from '../data/variables.queries';
import {
  variableRows,
  readVariableRows,
  type VariableRow as Row,
} from '../model/draft';
import { VariableRow } from './row';
import { VariableUsageDialog } from './usage';
export function VariablesEditor({
  scope,
  snapshot,
}: Readonly<{ scope: VariablesScope; snapshot: WorkspaceVariablesResponse }>) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    base: snapshot,
    rows: variableRows(snapshot.values, snapshot.descriptions),
  }));
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
      setDraft({
        base: latest,
        rows: variableRows(latest.values, latest.descriptions),
      });
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
          {draft.rows.length === 0 ? (
            <p className="py-5 text-sm text-muted-foreground">
              No variables yet. Add a reusable non-secret value, such as
              CURRENCY or BASE_URL.
            </p>
          ) : null}
          {draft.rows.map((row) => (
            <VariableRow
              key={row.id}
              row={row}
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
              setDraft((current) => ({
                ...current,
                rows: [
                  ...current.rows,
                  {
                    id: crypto.randomUUID(),
                    name: '',
                    type: 'text',
                    value: '',
                    description: '',
                  },
                ],
              }));
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
        <div className="flex flex-wrap items-center gap-3">
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
