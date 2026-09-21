import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  changeInputMappingKind,
  inputMappingKeyControlId,
  isEditableInputMappingKind,
  type InputKeySuggestion,
  type InputMappingDraftRow,
  type InputMappingRowErrors,
  type PredecessorOption,
} from '../../../model/input-mappings';
import { InputMappingSourceControls } from './input-mapping-source-controls';

export function InputMappingRow({
  nodeId,
  row,
  index,
  suggestions,
  predecessors,
  errors,
  disabled,
  onChange,
  onRemove,
}: Readonly<{
  nodeId: string;
  row: InputMappingDraftRow;
  index: number;
  suggestions: readonly InputKeySuggestion[];
  predecessors: readonly PredecessorOption[];
  errors?: InputMappingRowErrors;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
  onRemove: () => void;
}>) {
  const keyId = inputMappingKeyControlId(nodeId, row.id);
  const keyErrorId = `${keyId}-error`;
  const kindId = `input-mapping-${nodeId}-${row.id}-kind`;
  const suggestionListId = `input-mapping-${nodeId}-${row.id}-keys`;
  const advanced = row.kind === 'advanced';
  const selectedSuggestion = suggestions.find(
    ({ key }) => key === row.destinationKey,
  );
  return (
    <li className="rounded-xl border border-white/8 bg-black/15 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Input {String(index + 1)}</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (
              advanced &&
              !window.confirm(
                'Remove this advanced mapping? It cannot be recreated in the visual editor.',
              )
            )
              return;
            onRemove();
          }}
        >
          Remove
        </Button>
      </div>
      <FieldGroup className="gap-3">
        <Field data-invalid={errors?.destinationKey !== undefined}>
          <FieldLabel htmlFor={keyId}>Destination key</FieldLabel>
          <Input
            id={keyId}
            name={`inputMapping.${row.id}.destinationKey`}
            autoComplete="off"
            list={suggestions.length === 0 ? undefined : suggestionListId}
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
            <datalist id={suggestionListId}>
              {suggestions.map((suggestion) => (
                <option key={suggestion.key} value={suggestion.key}>
                  {suggestion.label}
                </option>
              ))}
            </datalist>
          )}
          <FieldDescription>
            Creates one top-level property. Dots remain part of the literal key.
          </FieldDescription>
          {selectedSuggestion?.description === undefined ? null : (
            <FieldDescription>
              {selectedSuggestion.description}
            </FieldDescription>
          )}
          {errors?.destinationKey === undefined ? null : (
            <FieldError id={keyErrorId}>{errors.destinationKey}</FieldError>
          )}
        </Field>
        {advanced ? (
          <Field>
            <FieldLabel>Advanced source</FieldLabel>
            <p className="rounded-lg border border-white/8 bg-background/35 p-3 font-mono text-xs break-all text-muted-foreground">
              {advancedMappingLabel(row.source)}
            </p>
            <FieldDescription>
              This mapping is preserved exactly. Visual editing is not available
              for this source kind.
            </FieldDescription>
          </Field>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor={kindId}>Source</FieldLabel>
              <select
                id={kindId}
                name={`inputMapping.${row.id}.kind`}
                autoComplete="off"
                className="recessed-control h-10 rounded-lg border px-3 text-base"
                value={row.kind}
                disabled={disabled}
                onChange={(event) => {
                  const kind = event.currentTarget.value;
                  if (!isEditableInputMappingKind(kind)) return;
                  onChange(
                    changeInputMappingKind(row, kind, predecessors[0]?.nodeId),
                  );
                }}
              >
                <option value="literal">Literal JSON value</option>
                <option value="run_input">Run input</option>
                <option value="node_output">Connected node output</option>
              </select>
            </Field>
            <InputMappingSourceControls
              nodeId={nodeId}
              row={row}
              predecessors={predecessors}
              {...(errors === undefined ? {} : { errors })}
              disabled={disabled}
              onChange={onChange}
            />
          </>
        )}
      </FieldGroup>
    </li>
  );
}

function advancedMappingLabel(
  source: Extract<
    InputMappingDraftRow,
    { readonly kind: 'advanced' }
  >['source'],
): string {
  return source.kind === 'expression'
    ? `JSONata expression · policy ${String(source.policyVersion)}`
    : `Structured input · ${source.port} ${source.path}`;
}
