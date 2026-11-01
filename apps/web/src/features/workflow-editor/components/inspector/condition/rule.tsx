import { ChevronsUpDownIcon } from 'lucide-react';
import type { FocusEvent } from 'react';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button-variants';
import { Input } from '@/components/ui/input';
import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { stepTitle } from '../../../model/graph/adapter';
import type { GraphLevel } from '../../../model/graph/scopes';
import {
  CONDITION_OPERATOR_CHOICES,
  isConditionOperator,
  operatorForType,
  operatorTakes,
  type ConditionCombinator,
  type ConditionRule as Rule,
  type ConditionRuleProblems,
} from '../../../model/inspector/condition/rules';
import {
  readReference,
  sourceReference,
} from '../../../model/inspector/input-mappings/reference';
import { BuilderCard, EntryActions } from '../builders/parts';
import { ChoiceSelect } from '../fields/choice-select';
import {
  InsertDataPicker,
  type InsertDataProps,
} from '../input-mappings/insert-data/picker';

type RulePicker = Omit<InsertDataProps, 'disabled' | 'onInsert' | 'trigger'>;

type RuleControls = Readonly<{
  rule: Rule;
  baseId: string;
  messageId: string;
  editable: boolean;
  onChange: (rule: Rule) => void;
}>;

/**
 * Focuses a just-added rule's Field as it appears. It's one stable function
 * because a new one each render would run again and pull focus from the Value.
 */
function focusOnMount(element: HTMLButtonElement | null) {
  element?.focus();
}

const RULE_TITLES: Readonly<Record<ConditionCombinator, string>> = {
  and: 'And',
  or: 'Or',
};

/** One rule: a field, how to compare it and, when that needs one, a value. */
export function ConditionRuleCard({
  rule,
  index,
  combinator,
  total,
  problems,
  picker,
  upstream,
  editable,
  focusField,
  onChange,
  onRemove,
  onLeave,
}: Readonly<{
  rule: Rule;
  index: number;
  combinator: ConditionCombinator;
  total: number;
  /** Problems that have earned showing: the rule has been left. */
  problems: ConditionRuleProblems | undefined;
  picker: RulePicker;
  /** The steps that run before this one. */
  upstream: GraphLevel['nodes'];
  editable: boolean;
  focusField: boolean;
  onChange: (rule: Rule) => void;
  onRemove: () => void;
  onLeave: () => void;
}>) {
  const baseId = `condition-${picker.nodeId}-${rule.id}`;
  const messageId = `${baseId}-message`;
  const field = rule.field === '' ? undefined : nameField(rule.field, upstream);
  const controls = { rule, baseId, messageId, editable, onChange };
  const message =
    problems?.field ??
    problems?.value ??
    (field?.gone === true
      ? 'This step no longer runs before this one, so the rule can’t read it.'
      : undefined);
  return (
    <BuilderCard
      title={index === 0 ? 'When' : RULE_TITLES[combinator]}
      actions={
        <EntryActions
          label={`rule ${String(index + 1)}`}
          first={index === 0}
          last={index === total - 1}
          canRemove={total > 1 || rule.field !== '' || rule.value !== ''}
          editable={editable}
          onRemove={onRemove}
        />
      }
    >
      <div
        className="flex flex-col gap-3"
        onBlur={(event) => {
          if (leftTheRule(event)) onLeave();
        }}
      >
        <RuleField
          {...controls}
          name={field?.text}
          invalid={problems?.field !== undefined}
          picker={picker}
          focusField={focusField}
        />
        <Field>
          <FieldLabel htmlFor={`${baseId}-operator`}>Comparison</FieldLabel>
          <ChoiceSelect
            value={rule.operator}
            choices={CONDITION_OPERATOR_CHOICES}
            disabled={!editable}
            control={{ id: `${baseId}-operator` }}
            onChange={(operator) => {
              if (isConditionOperator(operator))
                onChange({ ...rule, operator });
            }}
          />
        </Field>
        <RuleValue {...controls} invalid={problems?.value !== undefined} />
        <p
          id={messageId}
          aria-live="polite"
          className="flex min-h-4 items-start gap-1.5 text-xs text-destructive"
        >
          {message === undefined ? null : (
            <>
              <StatusGlyph tone="failure" className="mt-px shrink-0" />
              {message}
            </>
          )}
        </p>
      </div>
    </BuilderCard>
  );
}

/**
 * Leaving the whole rule, not one control, is when its problems show. Its
 * field picker and comparison list open outside it, which isn't leaving.
 */
function leftTheRule(event: FocusEvent<HTMLDivElement>): boolean {
  const next = event.relatedTarget;
  if (event.currentTarget.contains(next)) return false;
  return (
    !(next instanceof Element) ||
    next.closest('[role="dialog"], [role="listbox"]') === null
  );
}

function RuleField({
  rule,
  baseId,
  messageId,
  editable,
  onChange,
  name,
  invalid,
  picker,
  focusField,
}: RuleControls &
  Readonly<{
    name: string | undefined;
    invalid: boolean;
    picker: RulePicker;
    focusField: boolean;
  }>) {
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={`${baseId}-field`}>Field</FieldLabel>
      <InsertDataPicker
        {...picker}
        allowFailure={false}
        disabled={!editable}
        trigger={{
          id: `${baseId}-field`,
          describedBy: messageId,
          className: cn(
            buttonVariants({ variant: 'outline' }),
            'w-full justify-between font-normal',
          ),
          ...(focusField ? { ref: focusOnMount } : {}),
          content: (
            <>
              <span
                className={cn(
                  'min-w-0 truncate',
                  name === undefined && 'text-muted-foreground',
                )}
              >
                {name ?? 'Choose a field'}
              </span>
              <ChevronsUpDownIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-subtle-foreground"
              />
            </>
          ),
        }}
        onInsert={(source, _name, type) => {
          const reference = sourceReference(source);
          if (reference === undefined) return;
          onChange({
            ...rule,
            field: reference,
            // A rule nobody has shaped yet starts where its field's type does.
            operator:
              rule.field === '' && rule.value === ''
                ? operatorForType(type)
                : rule.operator,
          });
        }}
      />
    </Field>
  );
}

/** It stays in place when a comparison needs no value, so nothing jumps. */
function RuleValue({
  rule,
  baseId,
  messageId,
  editable,
  onChange,
  invalid,
}: RuleControls & Readonly<{ invalid: boolean }>) {
  const takes = operatorTakes(rule.operator);
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={`${baseId}-value`}>Value</FieldLabel>
      <Input
        id={`${baseId}-value`}
        name={`condition.${rule.id}.value`}
        autoComplete="off"
        spellCheck={false}
        inputMode={takes === 'number' ? 'decimal' : 'text'}
        placeholder={takes === 'nothing' ? 'No value needed' : undefined}
        value={takes === 'nothing' ? '' : rule.value}
        disabled={!editable || takes === 'nothing'}
        aria-invalid={invalid}
        aria-describedby={messageId}
        onChange={(event) => {
          onChange({ ...rule, value: event.currentTarget.value });
        }}
      />
    </Field>
  );
}

/** A reference in words: `Fetch order · items[0].id`. */
function nameField(
  reference: string,
  upstream: GraphLevel['nodes'],
): Readonly<{ text: string; gone: boolean }> {
  const read = readReference(reference);
  if (read === undefined) return { text: reference, gone: false };
  const { origin, field } = read;
  const at = (source: string) =>
    field === '' ? source : `${source} · ${field}`;
  switch (origin.kind) {
    case 'run_input':
      return { text: at('Run input'), gone: false };
    case 'loop':
      return {
        text: at(origin.port === 'item' ? 'This item' : origin.port),
        gone: false,
      };
    case 'workspace_variable':
      return { text: `$vars.${origin.name}`, gone: false };
    case 'node_output': {
      const step = upstream.find((node) => node.id === origin.nodeId);
      return step === undefined
        ? { text: at('A step not linked before this one'), gone: true }
        : { text: at(stepTitle(step)), gone: false };
    }
  }
}
