import { WORKFLOW_FAILURE_FIELDS } from '@pertexo/workflow-model';
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
} from '../../../model/inspector/input-mappings/draft';
import type { SchemaValueType } from '../../../model/inspector/input-mappings/schema';
import { ChoiceSelect } from '../fields/choice-select';
import { LiteralEditor } from './literal-editor';
import { ExpressionExamples } from './expression-examples';

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
    case 'workspace_variable':
      return (
        <Field data-invalid={error !== undefined}>
          <FieldLabel htmlFor={controlId}>Workspace variable name</FieldLabel>
          <Input
            id={controlId}
            name={`inputMapping.${row.id}.variable`}
            value={row.name}
            placeholder="CURRENCY"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={error !== undefined}
            aria-describedby={`${controlId}-hint${error === undefined ? '' : ` ${errorId}`}`}
            onChange={(event) => {
              onChange({ ...row, name: event.currentTarget.value });
            }}
          />
          <FieldDescription id={`${controlId}-hint`}>
            Reads $vars.NAME from this run’s captured workspace values. Use
            Insert data to choose a current name.
          </FieldDescription>
          {error === undefined ? null : (
            <FieldError id={errorId}>{error}</FieldError>
          )}
        </Field>
      );
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
        <ExpressionSource
          row={row}
          controlId={controlId}
          loopPorts={loopPorts}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
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
    case 'node_failure':
      return (
        <Field data-invalid={error !== undefined}>
          <FieldLabel htmlFor={controlId}>Safe failure field</FieldLabel>
          <ChoiceSelect
            id={controlId}
            value={row.path}
            choices={[
              { value: '$', label: 'All safe fields' },
              ...WORKFLOW_FAILURE_FIELDS.map((field) => ({
                value: `$.${field}`,
                label: field,
              })),
            ]}
            disabled={disabled}
            invalid={error !== undefined}
            describedBy={`${controlId}-hint${error === undefined ? '' : ` ${errorId}`}`}
            onChange={(path) => {
              if (path !== null) onChange({ ...row, path });
            }}
          />
          <FieldDescription id={`${controlId}-hint`}>
            Only the selected source’s ID, invocation, attempt, failure kind and
            safe code are available. Provider messages and credentials are
            omitted.
          </FieldDescription>
          {error === undefined ? null : (
            <FieldError id={errorId}>{error}</FieldError>
          )}
        </Field>
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
            { value: null, label: 'Choose a linked step' },
            ...predecessors.map((option) => ({
              value: option.nodeId,
              label: option.label,
            })),
            ...(row.nodeId !== '' &&
            !predecessors.some((option) => option.nodeId === row.nodeId)
              ? [
                  {
                    value: row.nodeId,
                    label: 'A step that isn’t linked here',
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
            Link a step into this one to read its output.
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

function ExpressionSource({
  row,
  controlId,
  loopPorts,
  error,
  disabled,
  onChange,
}: Readonly<{
  row: Extract<InputMappingDraftRow, { kind: 'expression' }>;
  controlId: string;
  loopPorts: readonly string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (row: InputMappingDraftRow) => void;
}>) {
  const errorId = `${controlId}-error`;
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={controlId}>Expression</FieldLabel>
      <Textarea
        id={controlId}
        name={`inputMapping.${row.id}.expression`}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          loopPorts.length > 0
            ? 'loop.item.amount > 5000'
            : 'runInput.amount > 5000'
        }
        className="min-h-16 border-primary/30 font-mono text-base md:text-[0.8rem]"
        value={row.expression}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={`${controlId}-hint${error === undefined ? '' : ` ${errorId}`}`}
        onChange={(event) => {
          onChange({ ...row, expression: event.currentTarget.value });
        }}
      />
      <FieldDescription id={`${controlId}-hint`}>
        {loopPorts.length > 0
          ? 'JSONata reads loop.item (the item this pass runs for), loop.ordinal, runInput, available nodeOutputs and captured $vars, not this step’s mapped input.'
          : 'JSONata reads runInput, available nodeOutputs and captured $vars, not this step’s mapped input.'}{' '}
        The server validates and evaluates it when the step runs.
      </FieldDescription>
      {error === undefined ? null : (
        <FieldError id={errorId}>{error}</FieldError>
      )}
      <ExpressionExamples
        disabled={disabled}
        onChoose={(expression) => {
          onChange({ ...row, expression });
        }}
      />
    </Field>
  );
}
