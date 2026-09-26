import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { StatusGlyph } from '@/components/ui/status';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { GraphLevel } from '../../../model/graph-scopes';
import {
  changeInputMappingKind,
  inputMappingKeyControlId,
  isEditableInputMappingKind,
  type EditableInputMappingKind,
  type InputKeySuggestion,
  type InputMappingDraftRow,
  type InputMappingRowErrors,
  type PredecessorOption,
} from '../../../model/input-mappings';
import { MappingSourceEditor } from './mapping-source-editor';
import { MappingSummary } from './mapping-summary';

type KindOption = Readonly<{ kind: EditableInputMappingKind; label: string }>;

const kinds: readonly KindOption[] = [
  { kind: 'literal', label: 'Value' },
  { kind: 'run_input', label: 'Run input' },
  { kind: 'node_output', label: 'Step output' },
  { kind: 'expression', label: 'Expression' },
];
/** Offered inside a For each body, or kept visible where one is stored. */
const loopItemKind: KindOption = {
  kind: 'structured_input',
  label: 'Loop item',
};

/** Puts the cursor in a field as it appears, e.g. a just-added input's name. */
function focusOnMount(element: HTMLInputElement | null) {
  element?.focus();
}

type RowProps = Readonly<{
  nodeId: string;
  row: InputMappingDraftRow;
  /** The level the step is on, to name the step a row reads from. */
  graph: GraphLevel;
  suggestions: readonly InputKeySuggestion[];
  predecessors: readonly PredecessorOption[];
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  errors: InputMappingRowErrors | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
  onRemove: () => void;
}>;

/**
 * One input: a compact `field ← source` summary that opens its editor in
 * place. A closed row still says what's wrong with it.
 */
export function MappingRow({
  open,
  focusKey,
  onToggle,
  onFocusRow,
  onLeaveRow,
  ...props
}: RowProps &
  Readonly<{
    open: boolean;
    /** Focus the field name when the editor appears (a new input). */
    focusKey: boolean;
    onToggle: () => void;
    onFocusRow: () => void;
    onLeaveRow: () => void;
  }>) {
  const { nodeId, row, errors } = props;
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
      className="rounded-lg border border-white/7 bg-black/18 p-3"
      onFocus={onFocusRow}
      onBlur={onLeaveRow}
    >
      <MappingSummary
        row={row}
        graph={props.graph}
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
        className="mt-3 flex flex-col gap-3 border-t border-white/7 pt-3"
      >
        {open ? <MappingEditor {...props} focusKey={focusKey} /> : null}
      </div>
    </li>
  );
}

/** A row's editor: its field name, where its value comes from, and removal. */
function MappingEditor({
  nodeId,
  row,
  suggestions,
  predecessors,
  loopPorts,
  errors,
  disabled,
  focusKey,
  onChange,
  onRemove,
}: RowProps & Readonly<{ focusKey: boolean }>) {
  const keyId = inputMappingKeyControlId(nodeId, row.id);
  const keyErrorId = `${keyId}-error`;
  const listId = `${keyId}-suggestions`;
  const suggestion = suggestions.find(({ key }) => key === row.destinationKey);
  const options =
    loopPorts.length > 0 || row.kind === 'structured_input'
      ? [...kinds, loopItemKind]
      : kinds;
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
      <ToggleGroup
        aria-label="Source"
        value={[row.kind]}
        disabled={disabled}
        // The options share the width, tighter than a page toggle, so all
        // four fit the inspector on one line.
        className="w-full flex-wrap [&>*]:flex-1 [&>*]:px-1.5 [&>*]:text-[0.78rem]"
        onValueChange={(values) => {
          const kind: unknown = values[0];
          if (!isEditableInputMappingKind(kind)) return;
          onChange(changeInputMappingKind(row, kind, predecessors[0]?.nodeId));
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.kind} value={option.kind}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <MappingSourceEditor
        nodeId={nodeId}
        row={row}
        type={suggestion?.type}
        predecessors={predecessors}
        loopPorts={loopPorts}
        error={errors?.source}
        disabled={disabled}
        onChange={onChange}
      />
    </>
  );
}
