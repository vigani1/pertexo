import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type {
  InputMappingDraftRow,
  InputMappingRowErrors,
  PredecessorOption,
} from '../../../model/input-mappings';
import { inputMappingSourceControlId } from '../../../model/input-mappings';

export function InputMappingSourceControls({
  nodeId,
  row,
  predecessors,
  errors,
  disabled,
  onChange,
}: Readonly<{
  nodeId: string;
  row: Exclude<InputMappingDraftRow, { readonly kind: 'advanced' }>;
  predecessors: readonly PredecessorOption[];
  errors?: InputMappingRowErrors;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
}>) {
  const controlId = inputMappingSourceControlId(nodeId, row.id);
  const errorId = `${controlId}-error`;
  if (row.kind === 'literal')
    return (
      <Field data-invalid={errors?.source !== undefined}>
        <FieldLabel htmlFor={controlId}>JSON value</FieldLabel>
        <Textarea
          id={controlId}
          name={`inputMapping.${row.id}.literal`}
          autoComplete="off"
          className="min-h-24 font-mono text-sm"
          value={row.literalJson}
          disabled={disabled}
          aria-invalid={errors?.source !== undefined}
          aria-describedby={errors?.source === undefined ? undefined : errorId}
          onChange={(event) => {
            onChange({ ...row, literalJson: event.currentTarget.value });
          }}
        />
        <FieldDescription>
          Enter any JSON value, including strings, numbers, objects, arrays or
          null.
        </FieldDescription>
        {errors?.source === undefined ? null : (
          <FieldError id={errorId}>{errors.source}</FieldError>
        )}
      </Field>
    );

  if (row.kind === 'run_input')
    return (
      <JsonPathField
        id={controlId}
        label="Run input path"
        name={`inputMapping.${row.id}.runInputPath`}
        value={row.path}
        disabled={disabled}
        {...(errors?.source === undefined ? {} : { error: errors.source })}
        onChange={(path) => {
          onChange({ ...row, path });
        }}
      />
    );

  const sourceNodeInvalid =
    errors?.source !== undefined &&
    !predecessors.some(
      ({ nodeId: predecessorId }) => predecessorId === row.nodeId,
    );
  return (
    <>
      <Field data-invalid={sourceNodeInvalid}>
        <FieldLabel htmlFor={`${controlId}-node`}>Source node</FieldLabel>
        <select
          id={`${controlId}-node`}
          name={`inputMapping.${row.id}.sourceNode`}
          autoComplete="off"
          className="recessed-control h-10 rounded-lg border px-3 text-base"
          value={row.nodeId}
          disabled={disabled}
          aria-invalid={sourceNodeInvalid}
          aria-describedby={sourceNodeInvalid ? errorId : undefined}
          onChange={(event) => {
            onChange({ ...row, nodeId: event.currentTarget.value });
          }}
        >
          <option value="">Choose a connected predecessor</option>
          {predecessors.map((predecessor) => (
            <option key={predecessor.nodeId} value={predecessor.nodeId}>
              {predecessor.label} ({predecessor.nodeId})
            </option>
          ))}
        </select>
        {predecessors.length === 0 ? (
          <FieldDescription>
            Connect a predecessor to this node before mapping its output.
          </FieldDescription>
        ) : null}
        {sourceNodeInvalid ? (
          <FieldError id={errorId}>{errors.source}</FieldError>
        ) : null}
      </Field>
      <JsonPathField
        id={controlId}
        label="Output path"
        name={`inputMapping.${row.id}.nodeOutputPath`}
        value={row.path}
        disabled={disabled}
        {...(errors?.source === undefined || sourceNodeInvalid
          ? {}
          : { error: errors.source })}
        onChange={(path) => {
          onChange({ ...row, path });
        }}
      />
    </>
  );
}

function JsonPathField({
  id,
  label,
  name,
  value,
  disabled,
  error,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  name: string;
  value: string;
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
}>) {
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={name}
        autoComplete="off"
        className="font-mono"
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      <FieldDescription>
        Use $ for the whole value, or a path such as $.customer or
        $['customer-name'].
      </FieldDescription>
      {error === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}
