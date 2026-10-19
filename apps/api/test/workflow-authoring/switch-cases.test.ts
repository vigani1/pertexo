import { describe, expect, it } from 'vitest';
import type { JsonValue, WorkflowGraph } from '@pertexo/workflow-model';
import { switchCaseIssues } from '../../src/platform/workflow/switch-validation.js';

type Node = WorkflowGraph['nodes'][number];
const switchNode = (
  cases: readonly { id: string; equals: JsonValue }[],
  extra: Partial<Node> = {},
): Node => ({
  id: 'route',
  definition: { key: 'core.switch', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: { cases },
  inputMappings: {},
  connectionRefs: {},
  ...extra,
});
const graph = (...nodes: Node[]): WorkflowGraph => ({
  nodes,
  edges: [],
  settings: {},
});

describe('Switch case publication check', () => {
  it('names a case an earlier case already matches', () => {
    expect(
      switchCaseIssues(
        graph(
          switchNode([
            { id: 'case-01', equals: 'a' },
            { id: 'case-02', equals: 1 },
            { id: 'case-03', equals: 'a' },
          ]),
        ),
      ),
    ).toEqual([
      {
        code: 'invalid_graph',
        path: '$.nodes.route.config.cases[2].equals',
        message:
          'An earlier case already matches this value, so this case can never run.',
      },
    ]);
  });

  it('keeps values of different types apart and skips disabled steps', () => {
    expect(
      switchCaseIssues(
        graph(
          switchNode([
            { id: 'case-01', equals: 1 },
            { id: 'case-02', equals: '1' },
            { id: 'case-03', equals: null },
          ]),
        ),
      ),
    ).toEqual([]);
    expect(
      switchCaseIssues(
        graph(
          switchNode(
            [
              { id: 'case-01', equals: 'a' },
              { id: 'case-02', equals: 'a' },
            ],
            { disabled: true },
          ),
        ),
      ),
    ).toEqual([]);
  });
});
