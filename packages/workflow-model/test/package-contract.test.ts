import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  WorkflowGraphContractError,
  safeParseWorkflowGraphDraft,
} from '../src/index.js';
import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  workflowGraphSchema,
} from '../src/graph-contract.js';

describe('workflow-model package contract', () => {
  it('keeps the server root facade explicit and stable', async () => {
    const publicEntry = await import('../src/index.js');
    expect(Object.keys(publicEntry).sort()).toEqual([
      'CANONICAL_JSON_MAX_DEPTH',
      'EMPTY_DEFINITION_CATALOG_FINGERPRINT_V1',
      'EMPTY_DEFINITION_CATALOG_V1',
      'EMPTY_WORKFLOW_GRAPH_V1',
      'EXPRESSION_POLICY_V1',
      'InvalidInvocationScopeError',
      'InvalidJsonValueError',
      'InvalidWorkflowGraphError',
      'JSONATA_EVALUATOR_DIAGNOSTICS',
      'JsonataEvaluator',
      'WORKFLOW_EXECUTION_LIMITS_V1',
      'WORKFLOW_GRAPH_LIMITS',
      'WorkflowGraphContractError',
      'WorkflowSettingsSchemaV1',
      'canonicalJson',
      'canonicalizeJson',
      'inspectJsonValue',
      'invocationIdentity',
      'parseRetainedWorkflowVersionV1',
      'parseWorkflowGraphDraft',
      'parseWorkflowGraphForPublish',
      'resolveJsonPath',
      'resolveValueSource',
      'safeParseWorkflowGraphDraft',
      'validateExpression',
      'validateWorkflowGraph',
      'workflowCompatibilityReport',
      'workflowDraftRepresentationTag',
      'workflowExecutableChecksum',
      'workflowExecutableProjection',
      'workflowIntegrationUsage',
      'workflowRetainedExecutableChecksum',
    ]);
  });

  it('keeps canonical graph ownership browser-safe while server implementation exports remain protected', async () => {
    const json = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      exports: Record<
        string,
        { types: string; node?: string; default: string }
      >;
      browser: Record<string, false>;
    };
    expect(json.dependencies).not.toHaveProperty('@pertexo/contracts');
    const graphContract = json.exports['./graph-contract'];
    if (graphContract === undefined)
      throw new Error('missing browser-safe graph contract export');
    expect(graphContract).toEqual({
      types: './dist/graph-contract.d.ts',
      default: './dist/graph-contract.js',
    });
    expect(json.browser[graphContract.default]).toBeUndefined();
    expect(
      await readFile(
        new URL('../src/graph-contract.ts', import.meta.url),
        'utf8',
      ),
    ).not.toMatch(/(?:from|import) ['"](?:node:|@pertexo\/contracts)/u);

    for (const [name, value] of Object.entries(json.exports)) {
      if (
        name === './assert-never' ||
        name === './failure-notification' ||
        name === './graph-contract' ||
        name === './json-path' ||
        name === './lifecycle' ||
        name === './observation-window'
      )
        continue;
      if (value.node === undefined)
        throw new Error(`server export ${name} is missing its node target`);
      expect(value.default).toBe(value.node);
      expect(json.browser[value.node]).toBe(false);
      const source = new URL(
        value.node.replace('./dist/', '../src/').replace(/\.js$/u, '.ts'),
        import.meta.url,
      );
      expect(await readFile(source, 'utf8')).toContain(
        "import './server-only.js';",
      );
    }
  });

  it('exposes only guarded graph parsing and safely rejects deeply nested input', async () => {
    let graph: Record<string, unknown> = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    for (let index = 0; index < 500; index += 1)
      graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: `loop-${String(index)}`,
            definition: { key: 'core.loop', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            structured: {
              kind: 'for_each',
              maxIterations: 1,
              maxConcurrency: 1,
              body: { ...graph, inputPorts: [], outputPorts: [] },
            },
          },
        ],
        edges: [],
        settings: {},
      };

    const result = safeParseWorkflowGraphDraft(graph);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected typed parse failure');
    expect(result.error).toBeInstanceOf(WorkflowGraphContractError);
    expect(result.error).not.toBeInstanceOf(RangeError);

    expect(() => workflowGraphSchema.safeParse(graph)).not.toThrow(RangeError);
    expect(workflowGraphSchema.safeParse(graph).success).toBe(false);

    const publicEntry = await import('../src/index.js');
    expect(publicEntry).not.toHaveProperty('WorkflowGraphInputSchemaV1');
  });

  it('applies aggregate nested node limits identically in browser and server entrypoints', () => {
    const innerNode = (index: number) => ({
      id: `inner-${String(index)}`,
      definition: { key: 'core.set', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    });
    const candidate = (innerCount: number) => ({
      schemaVersion: 1,
      nodes: [
        {
          ...innerNode(-1),
          structured: {
            kind: 'for_each',
            maxIterations: 1,
            maxConcurrency: 1,
            body: {
              schemaVersion: 1,
              nodes: Array.from({ length: innerCount }, (_, index) =>
                innerNode(index),
              ),
              edges: [],
              settings: {},
              inputPorts: [],
              outputPorts: [],
            },
          },
        },
      ],
      edges: [],
      settings: {},
    });
    const exact = candidate(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes - 1);
    const over = candidate(WORKFLOW_GRAPH_CONTRACT_LIMITS.nodes);

    expect(workflowGraphSchema.safeParse(exact).success).toBe(true);
    expect(safeParseWorkflowGraphDraft(exact).success).toBe(true);
    const browserResult = workflowGraphSchema.safeParse(over);
    expect(browserResult.success).toBe(false);
    if (browserResult.success) throw new Error('expected browser rejection');
    expect(browserResult.error.issues).toEqual([
      {
        code: 'custom',
        path: [],
        message: 'workflow graph exceeds the bounded JSON contract',
      },
    ]);
    const serverResult = safeParseWorkflowGraphDraft(over);
    expect(serverResult.success).toBe(false);
    if (serverResult.success) throw new Error('expected server rejection');
    expect(serverResult.error).toBeInstanceOf(z.ZodError);
    expect(serverResult.error).toEqual(browserResult.error);
  });

  it('preserves distinct browser and server diagnostics for non-finite numbers', () => {
    const graph = {
      schemaVersion: 1,
      nodes: [
        {
          id: 'non-finite',
          definition: { key: 'core.set', version: 1 },
          position: { x: Number.NaN, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    };
    const browserResult = workflowGraphSchema.safeParse(graph);
    expect(browserResult.success).toBe(false);
    if (browserResult.success) throw new Error('expected browser rejection');
    expect(browserResult.error.issues[0]).toMatchObject({
      code: 'invalid_type',
      path: ['nodes', 0, 'position', 'x'],
    });

    const serverResult = safeParseWorkflowGraphDraft(graph);
    expect(serverResult.success).toBe(false);
    if (serverResult.success) throw new Error('expected server rejection');
    expect(serverResult.error).toBeInstanceOf(WorkflowGraphContractError);
    expect(serverResult.error).toMatchObject({
      code: 'invalid_json',
      path: '$.nodes[0].position.x',
    });
  });

  it('converts aggregate descriptor traps into the browser contract issue', () => {
    const graph = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    let nodeDescriptorReads = 0;
    const hostile = new Proxy(graph, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'nodes' && ++nodeDescriptorReads > 2)
          throw new Error('aggregate descriptor trap');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = workflowGraphSchema.safeParse(hostile);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected browser rejection');
    expect(result.error.issues).toEqual([
      {
        code: 'custom',
        path: [],
        message: 'workflow graph exceeds the bounded JSON contract',
      },
    ]);

    let serverNodeDescriptorReads = 0;
    const serverHostile = new Proxy(graph, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'nodes' && ++serverNodeDescriptorReads > 3)
          throw new Error('aggregate descriptor trap');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const serverResult = safeParseWorkflowGraphDraft(serverHostile);
    expect(serverResult.success).toBe(false);
    if (serverResult.success) throw new Error('expected server rejection');
    if (!(serverResult.error instanceof z.ZodError))
      throw new Error('expected aggregate Zod rejection');
    expect(serverResult.error.issues).toEqual(result.error.issues);
  });
});
