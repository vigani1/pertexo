import { ArrowLeftIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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

/** One input: `field ← source`, with the source's own editor below. */
export function MappingRow({
  nodeId,
  row,
  suggestions,
  predecessors,
  loopPorts,
  errors,
  disabled,
  onChange,
  onRemove,
  onFocusRow,
}: Readonly<{
  nodeId: string;
  row: InputMappingDraftRow;
  suggestions: readonly InputKeySuggestion[];
  predecessors: readonly PredecessorOption[];
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  errors: InputMappingRowErrors | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
  onRemove: () => void;
  onFocusRow: () => void;
}>) {
  const keyId = inputMappingKeyControlId(nodeId, row.id);
  const keyErrorId = `${keyId}-error`;
  const listId = `${keyId}-suggestions`;
  const suggestion = suggestions.find(({ key }) => key === row.destinationKey);
  const options =
    loopPorts.length > 0 || row.kind === 'structured_input'
      ? [...kinds, loopItemKind]
      : kinds;
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-white/7 bg-black/18 p-3"
      onFocus={onFocusRow}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
        <Field data-invalid={errors?.destinationKey !== undefined}>
          <FieldLabel htmlFor={keyId}>Field</FieldLabel>
          <Input
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
        <ArrowLeftIcon
          aria-hidden="true"
          className="mb-2.5 size-4 text-subtle-foreground"
        />
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
        className="w-full flex-wrap"
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
    </li>
  );
}
