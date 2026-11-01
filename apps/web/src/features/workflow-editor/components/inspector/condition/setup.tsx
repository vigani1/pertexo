import { PlusIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { upstreamStepIds } from '../../../model/graph/order';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import { inputMappingSourceControlId } from '../../../model/inspector/input-mappings/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { useInspectorSession } from '../use-session';
import { ExpressionSource } from '../input-mappings/source-editor';
import { ConditionRuleCard } from './rule';
import { CONDITION_INPUT, useConditionDraft } from './use-draft';

const MAX_RULES = 20;

type ConditionDraftApi = ReturnType<typeof useConditionDraft>;

type ConditionSetupProps = Readonly<{
  node: WorkflowNode;
  /** The level the step is on: the workflow, or the body it's in. */
  graph: GraphLevel;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  form: NodeFormApi;
  onOpenInputs: () => void;
}>;

/**
 * What a Condition checks, as rows of field, comparison and value, or as an
 * expression. Both are the same stored input; rules open only what they can
 * write back exactly, and everything else opens as the expression it is.
 */
export function ConditionSetup(props: ConditionSetupProps) {
  const { node, loopPorts, form, onOpenInputs } = props;
  const condition = useConditionDraft(node, form);
  if (condition.reading.kind === 'other')
    return (
      <div className="flex flex-col items-start gap-1.5 text-sm text-muted-foreground">
        <p>
          This condition uses a value only Inputs can show. It’s kept as is.
        </p>
        <Button type="button" variant="link" onClick={onOpenInputs}>
          Go to Inputs
        </Button>
      </div>
    );
  const rulesOpenable = condition.reading.kind === 'rules';
  return (
    <section aria-label="Condition" className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The run goes out True when this matches, and False when it doesn’t.
      </p>
      <ToggleGroup
        aria-label="Write the condition as"
        value={[condition.view]}
        disabled={!form.editable}
        className="w-full [&>*]:flex-1"
        onValueChange={(values) => {
          const next: unknown = values[0];
          if (next === 'rules' || next === 'expression')
            condition.changeView(next);
        }}
      >
        <ToggleGroupItem value="rules" disabled={!rulesOpenable}>
          Rules
        </ToggleGroupItem>
        <ToggleGroupItem value="expression">Expression</ToggleGroupItem>
      </ToggleGroup>
      {condition.view === 'expression' ? (
        <>
          {rulesOpenable ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              This expression does more than rules can show, so it stays exactly
              as written. To use rules instead, clear it.
            </p>
          )}
          <ExpressionSource
            row={{
              id: CONDITION_INPUT,
              destinationKey: CONDITION_INPUT,
              kind: 'expression',
              expression: condition.expression,
            }}
            controlId={inputMappingSourceControlId(node.id, CONDITION_INPUT)}
            loopPorts={loopPorts}
            error={undefined}
            disabled={!form.editable}
            onChange={(row) => {
              if (row.kind === 'expression')
                condition.changeExpression(row.expression);
            }}
          />
        </>
      ) : (
        <ConditionRules {...props} condition={condition} />
      )}
    </section>
  );
}

function ConditionRules({
  node,
  graph,
  loopPorts,
  form,
  condition,
}: ConditionSetupProps & Readonly<{ condition: ConditionDraftApi }>) {
  const { definitions, callScope } = useInspectorSession();
  const [focusRule, setFocusRule] = useState<string>();
  const addRef = useRef<HTMLButtonElement>(null);
  const { draft, writing, touched } = condition;
  const editable = form.editable;
  const upstreamIds = new Set(upstreamStepIds(graph, node.id));
  const upstream = graph.nodes.filter((step) => upstreamIds.has(step.id));
  return (
    <>
      {/* Stays in place with one rule, so adding a second moves nothing. */}
      <ToggleGroup
        aria-label="How the rules combine"
        value={[draft.combinator]}
        disabled={!editable || draft.rules.length < 2}
        className="w-full [&>*]:flex-1"
        onValueChange={(values) => {
          const next: unknown = values[0];
          if (next === 'and' || next === 'or') condition.changeCombinator(next);
        }}
      >
        <ToggleGroupItem value="and">All must match</ToggleGroupItem>
        <ToggleGroupItem value="or">Any can match</ToggleGroupItem>
      </ToggleGroup>
      <ol className="flex flex-col gap-2">
        {draft.rules.map((rule, index) => (
          <ConditionRuleCard
            key={rule.id}
            rule={rule}
            index={index}
            combinator={draft.combinator}
            total={draft.rules.length}
            problems={
              writing.kind === 'unfinished' && touched.has(rule.id)
                ? writing.problems[rule.id]
                : undefined
            }
            picker={{
              graph,
              variableScope: callScope,
              nodeId: node.id,
              loopPorts,
              definitions,
            }}
            upstream={upstream}
            editable={editable}
            focusField={focusRule === rule.id}
            onChange={condition.changeRule}
            onRemove={() => {
              condition.removeRule(rule.id);
              addRef.current?.focus();
            }}
            onLeave={() => {
              condition.leaveRule(rule.id);
            }}
          />
        ))}
      </ol>
      {writing.kind === 'too_long' ? (
        <p className="text-xs text-destructive" role="alert">
          These rules make too long a condition, so the last change isn’t saved.
          Remove a rule or shorten a value.
        </p>
      ) : null}
      <Button
        ref={addRef}
        type="button"
        size="sm"
        variant="outline"
        className="w-fit"
        disabled={!editable || draft.rules.length >= MAX_RULES}
        onClick={() => {
          setFocusRule(condition.addRule());
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add rule
      </Button>
    </>
  );
}
