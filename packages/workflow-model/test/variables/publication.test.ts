import { afterAll, expect, it } from 'vitest';
import type { WorkflowGraph, ValueSource } from '../../src/graph/contract.js';
import { WorkflowAuthoringValidator } from '../../src/authoring-validation/validator.js';

const owner = new WorkflowAuthoringValidator();
afterAll(() => owner.shutdown());
const policies = {
  definitions: [
    {
      definition: { key: 'core.set', version: 1 },
      policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
    },
  ],
};
function node(source: ValueSource) {
  return {
    id: 'step',
    definition: { key: 'core.set', version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: { result: source },
    connectionRefs: {},
  };
}
function graph(source: ValueSource): WorkflowGraph {
  return { nodes: [node(source)], edges: [], settings: {} };
}
const expression = (source: string): ValueSource => ({
  kind: 'expression',
  language: 'jsonata',
  expression: source,
});
it.each([
  { kind: 'workspace_variable' as const, name: 'MISSING' },
  expression('$vars.MISSING'),
  expression('$vars.PRESENT & $vars.MISSING'),
])(
  'checks required names through the real bounded authoring worker: %j',
  async (source) => {
    const value = graph(source);
    expect(await owner.validate(value, policies)).toMatchObject({ ok: true });
    expect(
      await owner.validate(value, policies, {
        workspaceVariableNames: ['PRESENT'],
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'invalid_mapping',
          path: '$.nodes.step.inputMappings.result',
          message:
            'Workspace variable MISSING does not exist. Add it in Settings → Variables.',
        },
      ],
    });
    expect(
      await owner.validate(value, policies, {
        workspaceVariableNames: ['PRESENT', 'MISSING'],
      }),
    ).toMatchObject({ ok: true });
    expect(
      await owner.validate(value, policies, { workspaceVariableNames: [] }),
    ).toMatchObject({ ok: false });
  },
);
it.each([
  expression('"$vars.LITERAL"'),
  expression('$lookup($vars,"OPTIONAL") ?? "fallback"'),
  expression('$lookup($vars,runInput.name) ?? "fallback"'),
  expression('$vars'),
  { kind: 'literal' as const, value: '$vars.LITERAL' },
])(
  'preserves literal and optional/dynamic lookup semantics: %j',
  async (source) => {
    expect(
      await owner.validate(graph(source), policies, {
        workspaceVariableNames: [],
      }),
    ).toMatchObject({ ok: true });
  },
);
it('checks nested body mappings and the callable result without exposing private expression text', async () => {
  const nested = graph(expression('$vars.IN_BODY'));
  const workflow: WorkflowGraph = {
    nodes: [
      {
        ...node({ kind: 'literal', value: {} }),
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        inputMappings: {},
        structured: {
          kind: 'for_each',
          maxIterations: 1,
          maxConcurrency: 1,
          body: {
            ...nested,
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
          },
        },
      },
    ],
    edges: [],
    settings: {},
  };
  expect(
    await owner.validate(workflow, policies, { workspaceVariableNames: [] }),
  ).toMatchObject({
    ok: false,
    issues: [
      {
        code: 'invalid_mapping',
        path: '$.nodes.loop.structured.body.nodes.step.inputMappings.result',
      },
    ],
  });
  for (const result of [
    expression('$vars.RESULT'),
    { kind: 'workspace_variable' as const, name: 'RESULT' },
  ]) {
    const callable: WorkflowGraph = {
      ...graph({ kind: 'literal', value: {} }),
      nodes: [
        {
          ...node({ kind: 'literal', value: {} }),
          definition: { key: 'core.manual', version: 1 },
        },
      ],
      callable: {
        input: { type: 'object', properties: [] },
        resultType: { type: 'string' },
        result,
      },
    };
    expect(
      await owner.validate(callable, policies, { workspaceVariableNames: [] }),
    ).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid_mapping', path: '$.callable.result' }],
    });
    expect(
      await owner.validate(callable, policies, {
        workspaceVariableNames: ['RESULT'],
      }),
    ).toMatchObject({ ok: true });
  }
  const secret = 'private-password-must-not-appear';
  const report = await owner.validate(
    graph(expression(`$vars."${secret}"`)),
    policies,
    { workspaceVariableNames: [] },
  );
  expect(report.ok).toBe(false);
  expect(JSON.stringify(report)).not.toContain(secret);
});
