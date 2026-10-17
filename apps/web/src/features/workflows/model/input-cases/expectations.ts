import type { WorkflowTestExpectations } from '@pertexo/workflow-model';
export interface CaseExpectationDraft {
  outcome: 'succeeds' | 'fails';
  assertions: {
    id: string;
    source: string;
    path: string;
    operator: 'equals' | 'contains';
    expected: string;
  }[];
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
