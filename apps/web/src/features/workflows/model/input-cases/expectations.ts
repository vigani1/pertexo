import type { WorkflowTestExpectations } from '@pertexo/workflow-model';
export interface CaseExpectationDraft {
  outcome: 'succeeds' | 'fails';
  assertions: {
    id: string;
    source: string;
    path: string;
    operator: 'equals' | 'contains';
    expected: string;
    expectedColumn?: string | undefined;
  }[];
}
export function expectationRequest(draft: CaseExpectationDraft) {
  return mapExpectations(draft, (item) => JSON.parse(item.expected) as unknown);
}

export function evaluationExpectationRequest(draft: CaseExpectationDraft) {
  return mapExpectations(draft, (item) =>
    item.expectedColumn === undefined
      ? { kind: 'literal', value: JSON.parse(item.expected) as unknown }
      : { kind: 'column', columnId: item.expectedColumn },
  );
}

function mapExpectations<T>(
  draft: CaseExpectationDraft,
  expected: (item: CaseExpectationDraft['assertions'][number]) => T,
) {
  return {
    outcome: draft.outcome,
    assertions: draft.assertions.map((item) => ({
      source:
        item.source === ''
          ? { kind: 'final' as const }
          : { kind: 'step' as const, nodeId: item.source },
      path: item.path,
      operator: item.operator,
      expected: expected(item),
    })),
  };
}

export function expectationDraft(
  value: WorkflowTestExpectations | undefined,
): CaseExpectationDraft {
  return {
    outcome: value?.outcome ?? 'succeeds',
    assertions: (value?.assertions ?? []).map((item) => ({
      id: crypto.randomUUID(),
      source: item.source.kind === 'final' ? '' : item.source.nodeId,
      path: item.path,
      operator: item.operator,
      expected: JSON.stringify(item.expected, null, 2),
    })),
  };
}
