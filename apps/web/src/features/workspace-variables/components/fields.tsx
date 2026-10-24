import type { WorkspaceVariablesResponse } from '@pertexo/contracts';
import {
  workspaceVariableNameSchema,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { VariableSaveFeedback } from './feedback';
import { VariableColumns } from './columns';
import { VariableRow } from './row';
import { variableUnsaved, type VariableRow as Row } from '../model/draft';

type VariableFieldCommands = Readonly<{
  change: (id: string, row: Row) => void;
  toggle: (input: Readonly<{ id: string; opened: boolean }>) => void;
  inspect: (value: Readonly<{ name: string; removeId?: string }>) => void;
  remove: (id: string) => void;
  add: () => void;
}>;
export function VariableFields({
  rows,
  base,
  visible,
  open,
  filter,
  commands,
}: Readonly<{
  rows: readonly Row[];
  base: WorkspaceVariablesResponse;
  visible: readonly Row[];
  open: ReadonlySet<string>;
  filter: string;
  commands: VariableFieldCommands;
}>) {
  return (
    <>
      <VariableListHeading
        total={rows.length}
        visible={visible.length}
        filter={filter}
      />
      {visible.map((row) => (
        <VariableRow
          key={row.id}
          row={row}
          open={open.has(row.id)}
          unsaved={variableUnsaved(row, base)}
          onOpen={() => {
            commands.toggle({ id: row.id, opened: true });
          }}
          onClose={() => {
            commands.toggle({ id: row.id, opened: false });
          }}
          onChange={(next) => {
            commands.change(row.id, next);
          }}
          onInspect={() => {
            commands.inspect({ name: row.name });
          }}
          onRemove={() => {
            if (workspaceVariableNameSchema.safeParse(row.name).success)
              commands.inspect({ name: row.name, removeId: row.id });
            else commands.remove(row.id);
          }}
        />
      ))}
      <Button
        className="mt-4"
        type="button"
        variant="outline"
        disabled={rows.length >= WORKSPACE_VARIABLE_LIMITS.count}
        onClick={commands.add}
      >
        Add variable
      </Button>
    </>
  );
}
export function VariableSaveActions({
  changed,
  serverChanged,
  locked,
  pending,
  saved,
  onReload,
}: Readonly<{
  changed: boolean;
  serverChanged: boolean;
  locked: boolean;
  pending: boolean;
  saved: number | undefined;
  onReload: () => void;
}>) {
  return (
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
        {pending ? 'Saving…' : 'Save variables'}
      </Button>
      {/* Only offered when there is something to discard or newer
              values to load. */}
      {changed || serverChanged ? (
        <Button
          type="button"
          variant="ghost"
          disabled={locked}
          onClick={() => {
            onReload();
          }}
        >
          {changed ? 'Discard changes' : 'Load the latest values'}
        </Button>
      ) : null}
      <VariableSaveFeedback revision={saved} />
    </div>
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
