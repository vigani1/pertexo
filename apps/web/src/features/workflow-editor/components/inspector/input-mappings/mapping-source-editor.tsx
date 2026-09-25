import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  inputMappingSourceControlId,
  type InputMappingDraftRow,
  type PredecessorOption,
  type SchemaValueType,
} from '../../../model/input-mappings';
import { ChoiceSelect } from '../choice-select';
import { LiteralEditor } from './literal-editor';

/**
 * The editor for a row's source: a value, a path, a step's output, code, or
 * inside a For each body the item (or its position) being worked on.
 */
export function MappingSourceEditor({
  nodeId,
  row,
  type,
  predecessors,
  loopPorts,
  error,
  disabled,
  onChange,
}: Readonly<{
  nodeId: string;
  row: InputMappingDraftRow;
  type: SchemaValueType | undefined;
  predecessors: readonly PredecessorOption[];
  loopPorts: readonly string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
}>) {
  const controlId = inputMappingSourceControlId(nodeId, row.id);
  const errorId = `${controlId}-error`;
  switch (row.kind) {
    case 'literal':
      return (
        <LiteralEditor
          row={row}
          type={type}
          controlId={controlId}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'run_input':
      return (
        <PathField
          id={controlId}
          label="Run input path"
          value={row.path}
          error={error}
          disabled={disabled}
          onChange={(path) => {
            onChange({ ...row, path });
          }}
        />
      );
    case 'expression':
      return (
        <Field data-invalid={error !== undefined}>
          <FieldLabel htmlFor={controlId}>Expression</FieldLabel>
          <Textarea
            id={controlId}
            name={`inputMapping.${row.id}.expression`}
            autoComplete="off"
            spellCheck={false}
            placeholder="body.amount > 5000"
            className="min-h-16 border-primary/30 font-mono text-[0.8rem]"
            value={row.expression}
            disabled={disabled}
            aria-invalid={error !== undefined}
            aria-describedby={`${controlId}-hint${error === undefined ? '' : ` ${errorId}`}`}
            onChange={(event) => {
              onChange({ ...row, expression: event.currentTarget.value });
            }}
          />
          <FieldDescription id={`${controlId}-hint`}>
            A JSONata expression over this step’s input, worked out when the
            step runs.
          </FieldDescription>
          {error === undefined ? null : (
            <FieldError id={errorId}>{error}</FieldError>
          )}
        </Field>
      );
    case 'structured_input':
      return (
        <LoopItemSource
          row={row}
          controlId={controlId}
          loopPorts={loopPorts}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'node_output':
      return (
        <StepOutputSource
          row={row}
          controlId={controlId}
          predecessors={predecessors}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}

function StepOutputSource({
  row,
  controlId,
  predecessors,
  error,
  disabled,
  onChange,
}: Readonly<{
  row: Extract<InputMappingDraftRow, { kind: 'node_output' }>;
  controlId: string;
  predecessors: readonly PredecessorOption[];
  error: string | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
}>) {
  const errorId = `${controlId}-error`;
  const stepInvalid =
    error !== undefined &&
    !predecessors.some((option) => option.nodeId === row.nodeId);
  return (
    <>
      <Field data-invalid={stepInvalid}>
        <FieldLabel htmlFor={`${controlId}-node`}>Source step</FieldLabel>
        <ChoiceSelect
          id={`${controlId}-node`}
          value={row.nodeId === '' ? null : row.nodeId}
          disabled={disabled}
          invalid={stepInvalid}
          {...(stepInvalid ? { describedBy: errorId } : {})}
          choices={[
            { value: null, label: 'Choose a connected step' },
            ...predecessors.map((option) => ({
              value: option.nodeId,
              label: option.label,
            })),
            ...(row.nodeId !== '' &&
            !predecessors.some((option) => option.nodeId === row.nodeId)
              ? [
                  {
                    value: row.nodeId,
                    label: 'A step that isn’t connected here',
                  },
                ]
              : []),
          ]}
          onChange={(nodeId) => {
            onChange({ ...row, nodeId: nodeId ?? '' });
          }}
        />
        {predecessors.length === 0 ? (
          <FieldDescription>
            Connect a step into this one to read its output.
          </FieldDescription>
        ) : null}
        {stepInvalid ? <FieldError id={errorId}>{error}</FieldError> : null}
      </Field>
      <PathField
        id={controlId}
        label="Output path"
        value={row.path}
        error={stepInvalid ? undefined : error}
        disabled={disabled}
        onChange={(path) => {
          onChange({ ...row, path });
        }}
      />
    </>
  );
}

const loopPortLabels: Readonly<Record<string, string>> = {
  item: 'The item',
  ordinal: 'Its position (0, 1, 2…)',
};

/** A body step reading the item it runs for, or that item's position. */
function LoopItemSource({
  row,
  controlId,
  loopPorts,
  error,
  disabled,
  onChange,
}: Readonly<{
  row: Extract<InputMappingDraftRow, { kind: 'structured_input' }>;
  controlId: string;
  loopPorts: readonly string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
}>) {
  const errorId = `${controlId}-error`;
  const portInvalid = error !== undefined && !loopPorts.includes(row.port);
  const ports = loopPorts.includes(row.port)
    ? loopPorts
    : [...loopPorts, row.port];
  return (
    <>
      <Field data-invalid={portInvalid}>
        <FieldLabel htmlFor={`${controlId}-port`}>Read</FieldLabel>
        <ChoiceSelect
          id={`${controlId}-port`}
          value={row.port}
          disabled={disabled}
          invalid={portInvalid}
          {...(portInvalid ? { describedBy: errorId } : {})}
          choices={ports.map((port) => ({
            value: port,
            label: loopPortLabels[port] ?? port,
          }))}
          onChange={(port) => {
            if (port !== null) onChange({ ...row, port });
          }}
        />
        {portInvalid ? <FieldError id={errorId}>{error}</FieldError> : null}
      </Field>
      <PathField
        id={controlId}
        label="Path in it"
        value={row.path}
        error={portInvalid ? undefined : error}
        disabled={disabled}
        onChange={(path) => {
          onChange({ ...row, path });
        }}
      />
    </>
  );
}

function PathField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}>) {
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={`${id}-hint${error === undefined ? '' : ` ${errorId}`}`}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      <FieldDescription id={`${id}-hint`}>
        $ is the whole value; $.customer or $['customer-name'] picks a part.
      </FieldDescription>
      {error === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </Field>
  );
}
