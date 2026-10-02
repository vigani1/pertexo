import { describe, expect, it } from 'vitest';
import type { WorkflowCallableGraphV2 } from '../src/callable-graph-contract.js';
import type { WorkflowNode } from '../src/graph-contract.js';
import {
  WorkflowCallClosureError,
  validateWorkflowCallClosureV1,
  validateWorkflowCallableGraphV2,
  workflowCallableContractIdentityV1,
  type PublishedCallableVersionV1,
} from '../src/workflow-call-closure.js';
import type { WorkflowCallPinV1 } from '../src/workflow-call-contract.js';

const uuid = (value: number) =>
  `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const rootId = uuid(100);
const node = (id: string): WorkflowNode => ({
  id,
  definition: { key: 'core.set', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
});

describe('callable graph result-selector semantic validation', () => {
  const selected = (
    resultSelector: unknown,
    nodes: readonly WorkflowNode[] = [node('result')],
  ) => {
    const source = graph(nodes);
    return { ...source, callable: { ...callable(source), resultSelector } };
  };
  it('supports no callable declaration and a bounded literal selector', () => {
    const plain = graph([node('result')], false);
    expect(validateWorkflowCallableGraphV2(plain)).toEqual(plain);
    expect(validateWorkflowCallableGraphV2(graph())).toEqual(graph());
  });
  it('accepts existing root node output and run input paths', () => {
    for (const resultSelector of [
      { kind: 'node_output', nodeId: 'result', path: '$' },
      { kind: 'node_output', nodeId: 'result', path: '$.items[0]' },
      { kind: 'run_input', path: "$['result']" },
    ]) {
      const source = selected(resultSelector);
      expect(validateWorkflowCallableGraphV2(source)).toEqual(source);
    }
  });
  it('rejects a missing selector and a nonexistent output node', () => {
    const source = graph();
    const declaration: Record<string, unknown> = { ...callable(source) };
    Reflect.deleteProperty(declaration, 'resultSelector');
    expectCode(
      () =>
        validateWorkflowCallableGraphV2({ ...source, callable: declaration }),
      'invalid_graph',
    );
    expectCode(
      () =>
        validateWorkflowCallableGraphV2(
          selected({ kind: 'node_output', nodeId: 'absent', path: '$' }),
        ),
      'invalid_graph',
    );
  });
  it('rejects nested body node outputs and structured inputs at the root', () => {
    expectCode(
      () =>
        validateWorkflowCallableGraphV2(
          selected({ kind: 'node_output', nodeId: 'nested', path: '$' }, [
            loop(1, node('nested')),
          ]),
        ),
      'invalid_graph',
    );
    expectCode(
      () =>
        validateWorkflowCallableGraphV2(
          selected({ kind: 'structured_input', port: 'item', path: '$' }),
        ),
      'invalid_graph',
    );
  });
  it.each(['name', '$.items[*]', '$..name', '$[01]'])(
    'rejects invalid selector path %s',
    (path) => {
      for (const resultSelector of [
        { kind: 'run_input', path },
        { kind: 'node_output', nodeId: 'result', path },
      ])
        expectCode(
          () => validateWorkflowCallableGraphV2(selected(resultSelector)),
          'invalid_graph',
        );
    },
  );
  it('accepts the existing restricted expression policy', () => {
    const source = selected({
      kind: 'expression',
      language: 'jsonata',
      expression: 'runInput.name',
      policyVersion: 1,
    });
    expect(validateWorkflowCallableGraphV2(source)).toEqual(source);
  });
  it.each([
    { expression: 'runInput.name', policyVersion: 2 },
    { expression: '(', policyVersion: 1 },
    { expression: '$eval("1")', policyVersion: 1 },
    { expression: 'function($x){$x}', policyVersion: 1 },
  ])(
    'rejects invalid expression policy, syntax or construct %#',
    (expression) => {
      expectCode(
        () =>
          validateWorkflowCallableGraphV2(
            selected({
              kind: 'expression',
              language: 'jsonata',
              ...expression,
            }),
          ),
        'invalid_graph',
      );
    },
  );
});
const graph = (
  nodes: readonly WorkflowNode[] = [node('result')],
  callable = true,
): WorkflowCallableGraphV2 => ({
  schemaVersion: 2,
  nodes,
  edges: [],
  settings: {},
  ...(callable
    ? {
        callable: {
          schemaVersion: 1,
          input: { type: 'object', properties: {}, required: [] },
          result: { type: 'object', properties: {}, required: [] },
          resultSelector: { kind: 'literal', value: {} },
        },
      }
    : {}),
});
function version(
  id: number,
  source = graph(),
  workflowId = uuid(id),
): PublishedCallableVersionV1 {
  return {
    workflowId,
    versionId: uuid(id + 1_000),
    checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
    callableContractIdentity: workflowCallableContractIdentityV1(
      source.callable,
    ),
    graph: source,
  };
}
function pin(version: PublishedCallableVersionV1): WorkflowCallPinV1 {
  return {
    workflowId: version.workflowId,
    versionId: version.versionId,
    checksum: version.checksum,
    callableContractIdentity: version.callableContractIdentity,
  };
}
const call = (
  id: string,
  target: PublishedCallableVersionV1,
): WorkflowNode => ({
  ...node(id),
  definition: { key: 'core.workflow_call', version: 1 },
  config: pin(target),
});
function loop(
  iterations: number,
  bodyNode: WorkflowNode,
  bodyVersion = 2,
): WorkflowNode {
  return {
    ...node('loop'),
    definition: { key: 'core.foreach', version: 1 },
    structured: {
      kind: 'for_each',
      maxIterations: iterations,
      maxConcurrency: 1,
      body: {
        schemaVersion: bodyVersion,
        nodes: [bodyNode],
        edges: [],
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
}
function check(
  source: unknown,
  versions: readonly PublishedCallableVersionV1[] = [],
) {
  return validateWorkflowCallClosureV1({
    workflowId: rootId,
    graph: source,
    resolve: (requested) =>
      versions.find((item) => item.versionId === requested.versionId),
  });
}
function expectCode(
  action: () => unknown,
  code: WorkflowCallClosureError['code'],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowCallClosureError);
    expect((error as WorkflowCallClosureError).code).toBe(code);
    return;
  }
  throw new Error(`Expected closure error ${code}`);
}

function first(
  values: readonly PublishedCallableVersionV1[],
): PublishedCallableVersionV1 {
  const value = values[0];
  if (value === undefined) throw new Error('Missing fixture version');
  return value;
}

function callable(source: WorkflowCallableGraphV2) {
  if (source.callable === undefined)
    throw new Error('Missing fixture declaration');
  return source.callable;
}

describe('bounded immutable workflow call closure', () => {
  it('accepts an acyclic depth-four closure and rejects depth five', () => {
    const versions: PublishedCallableVersionV1[] = [version(4)];
    for (let index = 3; index >= 1; index -= 1)
      versions.unshift(
        version(index, graph([call(`call-${String(index)}`, first(versions))])),
      );
    expect(
      check(graph([call('root-call', first(versions))]), versions),
    ).toMatchObject({ maxDepth: 4, childRuns: 4, expandedInvocations: 5 });
    const extra = version(5);
    const deepest = version(4, graph([call('fifth', extra)]));
    const chain = [deepest, extra];
    for (let index = 3; index >= 1; index -= 1)
      chain.unshift(
        version(index, graph([call(`call-${String(index)}`, first(chain))])),
      );
    expectCode(
      () => check(graph([call('root-call', first(chain))]), chain),
      'depth_limit',
    );
  });
  it('rejects workflow-identity recursion even at another published version', () => {
    const rootVersion = version(1, graph(), rootId);
    expectCode(
      () => check(graph([call('recursive', rootVersion)]), [rootVersion]),
      'recursive_call',
    );
    const otherA = version(3, graph(), uuid(1));
    const b = version(2, graph([call('back-to-a', otherA)]));
    const a = version(1, graph([call('to-b', b)]));
    expectCode(
      () => check(graph([call('to-a', a)]), [a, b, otherA]),
      'recursive_call',
    );
  });
  it('allows sibling reuse, resolves once, but counts each call site', () => {
    const child = version(1);
    let resolutions = 0;
    const result = validateWorkflowCallClosureV1({
      workflowId: rootId,
      graph: graph([call('first', child), call('second', child)]),
      resolve(requested) {
        resolutions += 1;
        expect(Object.isFrozen(requested)).toBe(true);
        return child;
      },
    });
    expect(resolutions).toBe(1);
    expect(result).toEqual({
      childRuns: 2,
      expandedInvocations: 4,
      maxDepth: 1,
      dependencies: [pin(child)],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.dependencies)).toBe(true);
    expect(Object.isFrozen(result.dependencies[0])).toBe(true);
  });
  it('returns sorted transitive pins only, never copied version graphs', () => {
    const leaf = version(1);
    const parent = version(2, graph([call('leaf', leaf)]));
    const result = check(graph([call('parent', parent)]), [parent, leaf]);
    expect(result.dependencies).toEqual([pin(leaf), pin(parent)]);
    expect(
      result.dependencies.every((item) => !Object.hasOwn(item, 'graph')),
    ).toBe(true);
  });
  it('rejects missing, malformed, mismatched and noncallable version rows', () => {
    const child = version(1);
    const source = graph([call('child', child)]);
    expectCode(() => check(source), 'missing_version');
    for (const field of [
      'workflowId',
      'versionId',
      'checksum',
      'callableContractIdentity',
    ] as const) {
      const changed = {
        ...child,
        [field]:
          field === 'workflowId' || field === 'versionId'
            ? uuid(999)
            : 'invalid',
      };
      expectCode(
        () =>
          validateWorkflowCallClosureV1({
            workflowId: rootId,
            graph: source,
            resolve: () => changed,
          }),
        'pin_mismatch',
      );
    }
    expectCode(
      () => check(source, [{ ...child, graph: { malformed: true } }]),
      'invalid_graph',
    );
    expectCode(
      () =>
        check(source, [{ ...child, graph: graph([node('result')], false) }]),
      'not_callable',
    );
    const changed = graph();
    expectCode(
      () =>
        check(source, [
          {
            ...child,
            graph: {
              ...changed,
              callable: {
                ...callable(changed),
                resultSelector: { kind: 'literal', value: { changed: true } },
              },
            },
          },
        ]),
      'pin_mismatch',
    );
  });
  it('rejects conflicting pins to a cached version, malformed configs and unsupported call versions', () => {
    const child = version(1);
    const different = { ...child, checksum: `wf:v3:sha256:${'b'.repeat(64)}` };
    expectCode(
      () =>
        check(graph([call('first', child), call('second', different)]), [
          child,
        ]),
      'pin_mismatch',
    );
    expectCode(
      () =>
        check(
          graph([
            { ...call('child', child), config: { ...pin(child), extra: true } },
          ]),
          [child],
        ),
      'invalid_pin',
    );
    expectCode(
      () =>
        check(
          graph([
            {
              ...call('child', child),
              definition: { key: 'core.workflow_call', version: 2 },
            },
          ]),
          [child],
        ),
      'invalid_pin',
    );
  });
  it('counts loop-multiplied children exactly at 64 and rejects 65', () => {
    const child = version(1);
    expect(
      check(graph([loop(64, call('child', child))]), [child]),
    ).toMatchObject({ childRuns: 64, expandedInvocations: 129, maxDepth: 1 });
    expectCode(
      () => check(graph([loop(65, call('child', child))]), [child]),
      'child_limit',
    );
  });
  it('counts repeated pinned child work at 1000 and rejects 1001', () => {
    const child = version(
      1,
      graph(
        Array.from({ length: 499 }, (_, index) =>
          node(`result-${String(index)}`),
        ),
      ),
    );
    const calls = [call('first', child), call('second', child)];
    expect(check(graph(calls), [child])).toMatchObject({
      expandedInvocations: 1_000,
      childRuns: 2,
    });
    expectCode(
      () => check(graph([...calls, node('extra')]), [child]),
      'expansion_limit',
    );
  });
  it('counts expanded child work multiplied by loop iterations', () => {
    const child = version(
      1,
      graph(
        Array.from({ length: 98 }, (_, index) =>
          node(`result-${String(index)}`),
        ),
      ),
    );
    expect(
      check(
        graph([
          loop(10, call('child', child)),
          ...Array.from({ length: 9 }, (_, index) =>
            node(`extra-${String(index)}`),
          ),
        ]),
        [child],
      ),
    ).toMatchObject({ expandedInvocations: 1_000, childRuns: 10 });
    expectCode(
      () =>
        check(
          graph([
            loop(10, call('child', child)),
            ...Array.from({ length: 10 }, (_, index) =>
              node(`extra-${String(index)}`),
            ),
          ]),
          [child],
        ),
      'expansion_limit',
    );
  });
  it('rejects a call embedded in a retained V1 structured body', () => {
    const child = version(1);
    expectCode(
      () => check(graph([loop(1, call('child', child), 1)]), [child]),
      'invalid_pin',
    );
  });
  it('propagates resolver failures unchanged rather than fabricating invalid graph', () => {
    const child = version(1);
    const operational = new Error('immutable index unavailable');
    expect(() =>
      validateWorkflowCallClosureV1({
        workflowId: rootId,
        graph: graph([call('child', child)]),
        resolve() {
          throw operational;
        },
      }),
    ).toThrow(operational);
  });
  it('binds callable identity to literal own-proto data rather than dropping it', () => {
    const plain = callable(graph());
    const hostileLiteral: unknown = JSON.parse('{"__proto__":{"value":1}}');
    const withLiteral = {
      ...plain,
      resultSelector: { kind: 'literal', value: hostileLiteral },
    };
    expect(workflowCallableContractIdentityV1(withLiteral)).not.toBe(
      workflowCallableContractIdentityV1(plain),
    );
  });
});
