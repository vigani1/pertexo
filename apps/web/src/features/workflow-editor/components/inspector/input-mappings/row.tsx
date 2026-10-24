import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { StatusGlyph } from '@/components/ui/status';

import {
  inputMappingKeyControlId,
  type InputMappingDraftRow,
  type InputMappingRowErrors,
} from '../../../model/inspector/input-mappings/draft';
import type { InputKeySuggestion } from '../../../model/inspector/input-mappings/schema';
import { MappingValueEditor, type MappingSources } from './value-editor';
import { MappingSummary } from './summary';

/** Puts the cursor in a field as it appears, e.g. a just-added input's name. */
function focusOnMount(element: HTMLInputElement | null) {
  element?.focus();
}

type RowProps = Readonly<{
  row: InputMappingDraftRow;
  suggestions: readonly InputKeySuggestion[];
  errors: InputMappingRowErrors | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
  onRemove: () => void;
  context: MappingSources;
}>;

/**
 * One input: a compact `field ← source` summary that opens its editor in
 * place. A closed row still says what's wrong with it.
 */
export function MappingRow({
  disclosure,
  ...props
}: RowProps &
  Readonly<{
    disclosure: Readonly<{
      open: boolean;
      /** Focus the field name when the editor appears (a new input). */
      focusKey: boolean;
      onToggle: () => void;
      onFocusRow: () => void;
      onLeaveRow: () => void;
    }>;
  }>) {
  const { open, focusKey, onToggle, onFocusRow, onLeaveRow } = disclosure;

  const { row, errors } = props;
  const { nodeId } = props.context;
  const keyId = inputMappingKeyControlId(nodeId, row.id);
  const editorId = `${keyId}-editor`;
  const problemId = `${keyId}-problem`;
  const problem = errors?.destinationKey ?? errors?.source;
  const suggestion = props.suggestions.find(
    ({ key }) => key === row.destinationKey,
  );
  const showProblem = !open && problem !== undefined;
  return (
    <li
      className="rounded-lg border border-surface-ink/7 bg-recess-ink/18 p-3"
      onFocus={onFocusRow}
      onBlur={onLeaveRow}
    >
      <MappingSummary
        row={row}
        graph={props.context.graph}
        type={suggestion?.type}
        open={open}
        controlsId={editorId}
        describedBy={showProblem ? problemId : undefined}
        onToggle={onToggle}
      />
      {showProblem ? (
        <p
          id={problemId}
          className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
        >
          <StatusGlyph tone="failure" className="mt-px shrink-0" />
          {problem}
        </p>
      ) : null}
      <div
        id={editorId}
        hidden={!open}
        className="mt-3 flex flex-col gap-3 border-t border-surface-ink/7 pt-3"
      >
        {open ? <MappingEditor {...props} focusKey={focusKey} /> : null}
      </div>
    </li>
  );
}

/** A row's editor: its field name, where its value comes from, and removal. */
function MappingEditor({
  row,
  suggestions,
  errors,
  disabled,
  focusKey,
  onChange,
  onRemove,
  context,
}: RowProps & Readonly<{ focusKey: boolean }>) {
  const { nodeId, graph, predecessors, loopPorts } = context;

  const keyId = inputMappingKeyControlId(nodeId, row.id);
  const keyErrorId = `${keyId}-error`;
  const listId = `${keyId}-suggestions`;
  const suggestion = suggestions.find(({ key }) => key === row.destinationKey);
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <Field data-invalid={errors?.destinationKey !== undefined}>
          <FieldLabel htmlFor={keyId}>Field</FieldLabel>
          <Input
            ref={focusKey ? focusOnMount : undefined}
            id={keyId}
            name={`inputMapping.${row.id}.key`}
            autoComplete="off"
            spellCheck={false}
            list={suggestions.length === 0 ? undefined : listId}
            className="font-mono"
            value={row.destinationKey}
            disabled={disabled}
            aria-invalid={errors?.destinationKey !== undefined}
            aria-describedby={
              errors?.destinationKey === undefined ? undefined : keyErrorId
            }
            onChange={(event) => {
              onChange({ ...row, destinationKey: event.currentTarget.value });
            }}
          />
          {suggestions.length === 0 ? null : (
            <datalist id={listId}>
              {suggestions.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))}
            </datalist>
          )}
        </Field>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="mb-1"
          aria-label={`Remove ${row.destinationKey === '' ? 'this input' : `the ${row.destinationKey} input`}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {errors?.destinationKey === undefined ? null : (
        <FieldError id={keyErrorId}>{errors.destinationKey}</FieldError>
      )}
      {suggestion?.description === undefined ? null : (
        <p className="-mt-1 text-xs text-subtle-foreground">
          {suggestion.description}
        </p>
      )}
      <MappingValueEditor
        row={row}

        type={suggestion?.type}
        error={errors?.source}
        disabled={disabled}
        onChange={onChange}
        context={{
          nodeId: nodeId,
          graph: graph,
          predecessors: predecessors,
          loopPorts: loopPorts,
        }}
      />
    </>
  );
}
