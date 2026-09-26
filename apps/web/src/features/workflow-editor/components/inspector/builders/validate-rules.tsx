import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import type { FieldParseResult } from '../../../model/inspector-draft';
import {
  addValidateRule,
  parseRuleEnum,
  readValidateRules,
  VALIDATE_BOUNDS,
  VALIDATE_MAX_RULES,
  VALIDATE_TYPES,
  validatePathProblem,
  withRuleType,
  withValidateRules,
  type ValidateRule,
  type ValidateType,
  moved,
} from '../../../model/setup-builders';
import { fieldControlId, type NodeFormApi } from '../../../model/node-form';
import { ChoiceSelect } from '../choice-select';
import { BuilderCard, EntryActions, LiveTextField } from './builder-parts';

const TYPE_LABELS: Readonly<Record<ValidateType, string>> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Yes or no',
  object: 'Object',
  array: 'List',
  null: 'Nothing (null)',
};

/** What each type's two bounds are called. */
const BOUND_LABELS: Readonly<
  Partial<Record<ValidateType, readonly [string, string]>>
> = {
  string: ['Shortest (characters)', 'Longest (characters)'],
  number: ['At least', 'At most'],
  array: ['Fewest items', 'Most items'],
};

function isType(value: string | null): value is ValidateType {
  return VALIDATE_TYPES.some((type) => type === value);
}

function ruleType(rule: ValidateRule): ValidateType | undefined {
  const type = rule.type;
  return typeof type === 'string' && isType(type) ? type : undefined;
}

/**
 * Validate's rules, checked in order against the step's input. A failed
 * rule doesn't stop the run: the step's result says whether the input was
 * valid and which rules failed, for a Condition or Switch to route on.
 */
export function ValidateRules({
  rules,
  form,
}: Readonly<{ rules: readonly ValidateRule[]; form: NodeFormApi }>) {
  function change(
    update: (current: readonly ValidateRule[]) => readonly ValidateRule[],
    key: string,
  ) {
    form.commit(
      (node) => ({
        config: withValidateRules(
          node.config,
          update(readValidateRules(node.config) ?? rules),
        ),
      }),
      `${form.nodeId}:config:rules:${key}`,
    );
  }
  const full = rules.length >= VALIDATE_MAX_RULES;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">Rules</legend>
      <p className="-mt-1 text-xs leading-relaxed text-muted-foreground">
        Each rule checks one value in the step’s input. A failed rule doesn’t
        stop the run: the result says whether the input is valid and which rules
        failed, for a Condition to route on.
      </p>
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rules yet. Add the first to say what the input needs.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rules.map((rule, index) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              index={index}
              count={rules.length}
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
          change(addValidateRule, 'add');
        }}
      >
        <PlusIcon data-icon="inline-start" />
        {full ? 'All 64 rules are in use' : 'Add rule'}
      </Button>
    </fieldset>
  );
}

function RuleCard({
  rule,
  index,
  count,
  form,
  onChange,
}: Readonly<{
  rule: ValidateRule;
  index: number;
  count: number;
  form: NodeFormApi;
  onChange: (
    update: (current: readonly ValidateRule[]) => readonly ValidateRule[],
    key: string,
  ) => void;
}>) {
  const baseId = `${fieldControlId(form.nodeId, 'rules')}-${rule.id}`;
  const type = ruleType(rule);
  const bounds = type === undefined ? undefined : VALIDATE_BOUNDS[type];
  const boundLabels = type === undefined ? undefined : BOUND_LABELS[type];
  function update(next: (current: ValidateRule) => ValidateRule) {
    onChange(
      (current) =>
        current.map((candidate) =>
          candidate.id === rule.id ? next(candidate) : candidate,
        ),
      rule.id,
    );
  }
  function setOptional(key: string, value: ValidateRule[string] | undefined) {
    update((current) => {
      const rest = Object.fromEntries(
        Object.entries(current).filter(([entryKey]) => entryKey !== key),
      ) as ValidateRule;
      return value === undefined ? rest : { ...rest, [key]: value };
    });
  }
  const enumValues = Array.isArray(rule.enum) ? rule.enum : undefined;
  return (
    <BuilderCard
      title={`Rule ${String(index + 1)}`}
      port={rule.id}
      actions={
        <EntryActions
          label={`rule ${String(index + 1)}`}
          first={index === 0}
          last={index === count - 1}
          canRemove={count > 1}
          removeHint="A Validate step needs at least one rule."
          editable={form.editable}
          onMove={(by) => {
            onChange((current) => moved(current, index, by), 'order');
          }}
          onRemove={() => {
            onChange(
              (current) => current.filter(({ id }) => id !== rule.id),
              'remove',
            );
          }}
        />
      }
    >
      <LiveTextField<string>
        id={`${baseId}-path`}
        label="Path"
        hint="Where the value sits in the input, like $.email or $.items[0].id."
        value={rule.path}
        format={(value) => value}
        parse={(text) => {
          const problem = validatePathProblem(text);
          return problem === undefined
            ? { ok: true, value: text }
            : { ok: false, error: problem };
        }}
        form={form}
        scratchKey={`rules.${rule.id}.path`}
        mono
        onCommit={(path) => {
          update((current) => ({ ...current, path }));
        }}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-3">
        <Field>
          <FieldLabel htmlFor={`${baseId}-type`} className="text-xs">
            Type
          </FieldLabel>
          <ChoiceSelect
            id={`${baseId}-type`}
            value={type ?? null}
            choices={[
              { value: null, label: 'Any' },
              ...VALIDATE_TYPES.map((value) => ({
                value,
                label: TYPE_LABELS[value],
              })),
            ]}
            disabled={!form.editable}
            onChange={(next) => {
              const nextType = isType(next) ? next : undefined;
              if (nextType !== type)
                update((current) => withRuleType(current, nextType));
            }}
          />
        </Field>
        <Field className="h-9 flex-row items-center gap-2">
          <Switch
            id={`${baseId}-required`}
            checked={rule.required}
            disabled={!form.editable}
            onCheckedChange={(required) => {
              update((current) => ({ ...current, required }));
            }}
          />
          <FieldLabel htmlFor={`${baseId}-required`} className="text-xs">
            Must be there
          </FieldLabel>
        </Field>
      </div>
      {bounds === undefined || boundLabels === undefined ? null : (
        <div className="grid grid-cols-2 gap-3">
          {bounds.map((key, boundIndex) => (
            <LiveTextField<number | undefined>
              // A new type brings new bounds.
              key={`${type ?? ''}-${key}`}
              id={`${baseId}-${key}`}
              label={boundLabels[boundIndex] ?? key}
              value={typeof rule[key] === 'number' ? rule[key] : undefined}
              format={(value) => (value === undefined ? '' : String(value))}
              parse={(text) =>
                parseBound(text, type === 'number' ? 'any' : 'count')
              }
              form={form}
              scratchKey={`rules.${rule.id}.${key}`}
              mono
              inputMode="decimal"
              placeholder="No limit"
              onCommit={(value) => {
                setOptional(key, value);
              }}
            />
          ))}
        </div>
      )}
      {type === undefined || type === 'string' || type === 'number' ? (
        <LiveTextField<readonly (string | number)[] | undefined>
          key={`${type ?? 'any'}-enum`}
          id={`${baseId}-enum`}
          label="One of (optional)"
          hint="Separate the allowed values with commas."
          value={enumValues as readonly (string | number)[] | undefined}
          format={(value) => (value === undefined ? '' : value.join(', '))}
          parse={(text) => parseRuleEnum(text, type)}
          form={form}
          scratchKey={`rules.${rule.id}.enum`}
          equals={(left, right) =>
            JSON.stringify(left) === JSON.stringify(right)
          }
          placeholder={type === 'number' ? '1, 2, 3' : 'draft, sent, paid'}
          onCommit={(value) => {
            setOptional('enum', value === undefined ? undefined : [...value]);
          }}
        />
      ) : null}
    </BuilderCard>
  );
}

/** A bound as typed: blank for none, a count or any finite number. */
function parseBound(
  text: string,
  kind: 'count' | 'any',
): FieldParseResult<number | undefined> {
  if (text.trim() === '') return { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value))
    return { ok: false, error: 'Enter a number, or leave it empty.' };
  if (kind === 'count' && (!Number.isInteger(value) || value < 0))
    return { ok: false, error: 'Enter a whole number, 0 or more.' };
  return { ok: true, value };
}
