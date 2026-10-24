import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  addSwitchCase,
  parseSwitchNumber,
  readSwitchCases,
  scalarKind,
  scalarOfKind,
  SWITCH_CASE_IDS,
  SWITCH_TEXT_MAX,
  withSwitchCases,
  type ScalarKind,
  type SwitchCase,
  moved,
} from '../../../model/inspector/setup-builders';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { BuilderCard, EntryActions, LiveTextField } from './parts';

const KIND_CHOICES: readonly Readonly<{ value: ScalarKind; label: string }>[] =
  [
    { value: 'text', label: 'Text' },
    { value: 'number', label: 'Number' },
    { value: 'boolean', label: 'Yes or no' },
    { value: 'null', label: 'Nothing (null)' },
  ];

function isKind(value: string | null): value is ScalarKind {
  return KIND_CHOICES.some((choice) => choice.value === value);
}

/**
 * Switch's cases in order: the first whose value equals the step's input
 * takes the run down its output, and anything else goes out Default. A case
 * with a step linked to its output can't be removed until it's
 * unlinked, since publishing refuses a link from a case that
 * isn't there.
 */
export function SwitchCases({
  cases,
  linkedPorts,
  form,
}: Readonly<{
  cases: readonly SwitchCase[];
  linkedPorts: ReadonlySet<string>;
  form: NodeFormApi;
}>) {
  function change(
    update: (current: readonly SwitchCase[]) => readonly SwitchCase[],
    key: string,
  ) {
    form.commit(
      (node) => ({
        config: withSwitchCases(
          node.config,
          update(readSwitchCases(node.config) ?? cases),
        ),
      }),
      `${form.nodeId}:config:cases:${key}`,
    );
  }
  const full = cases.length >= SWITCH_CASE_IDS.length;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">Cases</legend>
      <p className="-mt-1 text-xs leading-relaxed text-muted-foreground">
        In order, the first case equal to the step’s value sends the run down
        its output; anything else goes out Default. The value comes from Inputs.
      </p>
      {cases.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cases yet. Add one to start routing.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {cases.map((entry, index) => (
            <CaseRow
              key={entry.id}
              entry={entry}
              index={index}
              count={cases.length}
              linked={linkedPorts.has(entry.id)}
              form={form}
              onChange={change}
            />
          ))}
        </ol>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        disabled={!form.editable || full}
        onClick={() => {
          change(addSwitchCase, 'add');
        }}
      >
        <PlusIcon data-icon="inline-start" />
        {full ? 'All 16 cases are in use' : 'Add case'}
      </Button>
    </fieldset>
  );
}

function CaseRow({
  entry,
  index,
  count,
  linked,
  form,
  onChange,
}: Readonly<{
  entry: SwitchCase;
  index: number;
  count: number;
  linked: boolean;
  form: NodeFormApi;
  onChange: (
    update: (current: readonly SwitchCase[]) => readonly SwitchCase[],
    key: string,
  ) => void;
}>) {
  const label = `case ${String(index + 1)}`;
  const kind = scalarKind(entry.equals);
  const baseId = `${fieldControlId(form.nodeId, 'cases')}-${entry.id}`;
  function setEquals(equals: SwitchCase['equals']) {
    onChange(
      (current) =>
        current.map((candidate) =>
          candidate.id === entry.id ? { ...candidate, equals } : candidate,
        ),
      entry.id,
    );
  }
  return (
    <BuilderCard
      title={`Case ${String(index + 1)}`}
      port={entry.id}
      actions={
        <EntryActions
          label={label}
          first={index === 0}
          last={index === count - 1}
          canRemove={count > 1 && !linked}
          removeHint={
            linked
              ? 'A step is linked to this case. Remove the link on the canvas first.'
              : 'A Switch needs at least one case.'
          }
          editable={form.editable}
          onMove={(by) => {
            onChange((current) => moved(current, index, by), 'order');
          }}
          onRemove={() => {
            onChange(
              (current) =>
                current.filter((candidate) => candidate.id !== entry.id),
              'remove',
            );
          }}
        />
      }
    >
      <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-2">
        <Field>
          <FieldLabel htmlFor={`${baseId}-kind`} className="text-xs">
            Kind
          </FieldLabel>
          <ChoiceSelect
            value={kind}
            choices={KIND_CHOICES}
            disabled={!form.editable}
            onChange={(next) => {
              if (isKind(next) && next !== kind) setEquals(scalarOfKind(next));
            }}
            control={{ id: `${baseId}-kind` }}
          />
        </Field>
        <CaseValue
          // A new kind is a new box: its text starts from the new value.
          key={kind}
          id={`${baseId}-value`}
          kind={kind}
          equals={entry.equals}
          form={form}
          scratchKey={`cases.${entry.id}`}
          onCommit={setEquals}
        />
      </div>
    </BuilderCard>
  );
}

function CaseValue({
  id,
  kind,
  equals,
  form,
  scratchKey,
  onCommit,
}: Readonly<{
  id: string;
  kind: ScalarKind;
  equals: SwitchCase['equals'];
  form: NodeFormApi;
  scratchKey: string;
  onCommit: (equals: SwitchCase['equals']) => void;
}>) {
  if (kind === 'boolean')
    return (
      <Field>
        <FieldLabel htmlFor={id} className="text-xs">
          Equals
        </FieldLabel>
        <ChoiceSelect
          value={equals === false ? 'false' : 'true'}
          choices={[
            { value: 'true', label: 'Yes (true)' },
            { value: 'false', label: 'No (false)' },
          ]}
          disabled={!form.editable}
          onChange={(next) => {
            onCommit(next === 'true');
          }}
          control={{ id: id }}
        />
      </Field>
    );
  if (kind === 'null')
    return (
      <p className="pt-7 text-xs text-muted-foreground">
        Matches a value that is null.
      </p>
    );
  if (kind === 'number')
    return (
      <LiveTextField<number>
        form={form}
        scratchKey={scratchKey}

        binding={{
          value: typeof equals === 'number' ? equals : 0,
          format: String,
          parse: parseSwitchNumber,
          onCommit: onCommit,
        }}
        input={{ id: id, label: 'Equals', mono: true }}
      />
    );
  return (
    <LiveTextField<string>
      form={form}
      scratchKey={scratchKey}

      binding={{
        value: typeof equals === 'string' ? equals : '',
        format: (value) => value,
        parse: (text) =>
          text.length > SWITCH_TEXT_MAX
            ? { ok: false, error: 'Keep it under 1,024 characters.' }
            : { ok: true, value: text },
        onCommit: onCommit,
      }}
      input={{
        id: id,
        label: 'Equals',
        placeholder: 'Exact text, e.g. approved',
      }}
    />
  );
}
