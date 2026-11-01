import { useEffect, useState } from 'react';
import type { WorkflowNode } from '../../../model/graph/scopes';
import {
  blankConditionRule,
  isBlankCondition,
  readCondition,
  writeCondition,
  type ConditionDraft,
  type ConditionRule,
} from '../../../model/inspector/condition/rules';
import { sourceReference } from '../../../model/inspector/input-mappings/reference';
import type { NodeFormApi } from '../../../model/inspector/node-form';

export const CONDITION_INPUT = 'condition';

export type ConditionView = 'rules' | 'expression';

type StoredCondition = WorkflowNode['inputMappings'][string] | undefined;

type DraftState = Readonly<{
  /** JSON of the stored input these rules came from or last wrote. */
  applied: string;
  draft: ConditionDraft;
  view: ConditionView;
  /** The expression view's text, which may be empty while it's rewritten. */
  expression: string;
  /** Rules people have left: their problems show and then follow typing. */
  touched: ReadonlySet<string>;
  sequence: number;
}>;

function stateFor(stored: StoredCondition, sequence: number): DraftState {
  const reading = readCondition(stored);
  const expression =
    stored === undefined || stored.kind === 'literal'
      ? ''
      : (sourceReference(stored) ?? '');
  return {
    applied: JSON.stringify(stored ?? null),
    draft:
      reading.kind === 'rules'
        ? reading.draft
        : { combinator: 'and', rules: [blankConditionRule('rule-0')] },
    view: reading.kind === 'rules' ? 'rules' : 'expression',
    expression,
    touched: new Set(),
    sequence,
  };
}

/**
 * The rules or expression behind a Condition under live apply. A change is
 * stored as soon as it makes a whole condition; an unfinished rule waits here
 * as scratch. Undo, a reload or Inputs replaces what's here with what's stored.
 * Opening a stored condition writes nothing: only an edit does.
 */
export function useConditionDraft(node: WorkflowNode, form: NodeFormApi) {
  const stored: StoredCondition = node.inputMappings[CONDITION_INPUT];
  const applied = JSON.stringify(stored ?? null);
  const [state, setState] = useState(() => stateFor(stored, 1));
  let current = state;
  if (state.applied !== applied) {
    current = stateFor(stored, state.sequence);
    setState(current);
  }
  const reading = readCondition(stored);
  const writing = writeCondition(current.draft);
  const hasScratch =
    current.view === 'rules' &&
    writing.kind !== 'written' &&
    !isBlankCondition(current.draft);
  const { reportScratch } = form;
  useEffect(() => {
    reportScratch(CONDITION_INPUT, hasScratch);
  }, [hasScratch, reportScratch]);

  function store(next: StoredCondition) {
    form.commit(({ inputMappings }) => {
      const { [CONDITION_INPUT]: _replaced, ...others } = inputMappings;
      return {
        inputMappings:
          next === undefined ? others : { ...others, [CONDITION_INPUT]: next },
      };
    }, `${form.nodeId}:inputs`);
  }

  function changeDraft(draft: ConditionDraft, sequence = current.sequence) {
    const written = writeCondition(draft);
    const blank = isBlankCondition(draft);
    const next: StoredCondition =
      written.kind === 'written'
        ? {
            kind: 'expression',
            language: 'jsonata',
            expression: written.expression,
          }
        : undefined;
    const settled = blank || next !== undefined;
    const nextApplied = settled
      ? JSON.stringify(next ?? null)
      : current.applied;
    setState({
      ...current,
      draft,
      sequence,
      applied: nextApplied,
      expression:
        written.kind === 'written' ? written.expression : current.expression,
    });
    if (settled && nextApplied !== current.applied) store(next);
  }

  return {
    ...current,
    stored,
    reading,
    writing,
    changeRule: (rule: ConditionRule) => {
      changeDraft({
        ...current.draft,
        rules: current.draft.rules.map((candidate) =>
          candidate.id === rule.id ? rule : candidate,
        ),
      });
    },
    addRule: () => {
      const id = `new-${String(current.sequence)}`;
      changeDraft(
        {
          ...current.draft,
          rules: [...current.draft.rules, blankConditionRule(id)],
        },
        current.sequence + 1,
      );
      return id;
    },
    removeRule: (id: string) => {
      const rules = current.draft.rules.filter((rule) => rule.id !== id);
      changeDraft({
        ...current.draft,
        rules: rules.length === 0 ? [blankConditionRule(id)] : rules,
      });
    },
    changeCombinator: (combinator: ConditionDraft['combinator']) => {
      changeDraft({ ...current.draft, combinator });
    },
    leaveRule: (id: string) => {
      if (current.touched.has(id)) return;
      setState({ ...current, touched: new Set(current.touched).add(id) });
    },
    /** Empty clears the condition, which is how the rules become usable again. */
    changeExpression: (expression: string) => {
      const next: StoredCondition =
        expression.trim() === ''
          ? undefined
          : { kind: 'expression', language: 'jsonata', expression };
      const nextApplied = JSON.stringify(next ?? null);
      const opened = readCondition(next);
      setState({
        ...current,
        expression,
        applied: nextApplied,
        draft: opened.kind === 'rules' ? opened.draft : current.draft,
        touched: new Set(),
      });
      if (nextApplied !== current.applied) store(next);
    },
    changeView: (view: ConditionView) => {
      setState({
        ...current,
        view,
        expression:
          view === 'expression' && stored?.kind === 'expression'
            ? stored.expression
            : current.expression,
      });
    },
  } as const;
}
