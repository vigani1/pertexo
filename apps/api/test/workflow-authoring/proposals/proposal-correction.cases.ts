import type { DraftProposalResult } from '@pertexo/contracts';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

export function proposalCorrectionCases({
  workflow,
  propose,
  requests,
  httpWorkflow,
  usageRows,
}: Readonly<{
  workflow: () => Promise<string>;
  propose: (
    path: string,
    script: {
      graph: unknown;
      text?: string;
      outputTokens?: number;
      waitMillis?: number;
      hold?: boolean;
    }[],
  ) => Promise<DraftProposalResult>;
  requests: readonly string[];
  httpWorkflow: WorkflowGraph;
  usageRows: (path: string) => Promise<unknown[]>;
}>) {
  const valid = withHttpConfig({ url: 'https://orders.example.test' });
  const invalid = withHttpConfig({
    url: 'https://orders.example.test',
    method: 'INVALID',
  });
  const invalidUrl = withHttpConfig({ url: 42 });
  const candidate = (graph: unknown) => ({ graph });

  it('sends the setting issue to the model and returns a corrected draft with one usage record', async () => {
    const path = await workflow();
    const start = requests.length;
    const result = await propose(path, [candidate(invalid), candidate(valid)]);
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 1,
      validation: { valid: true },
      usage: { kind: 'complete', inputTokens: 80, outputTokens: 20 },
    });
    const bodies = requests.slice(start);
    expect(bodies).toHaveLength(2);
    const { messages } = JSON.parse(bodies[1] ?? 'null') as {
      messages: { role: string; content?: string }[];
    };
    const { task } = JSON.parse(
      messages[0]?.content?.split('\n').at(-1) ?? 'null',
    ) as { task: string };
    const { issues } = JSON.parse(task.split('\n').at(-1) ?? 'null') as {
      issues: { path: string; code: string; message: string }[];
    };
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: '$.nodes.request.config.method',
      code: 'invalid_graph',
    });
    expect(issues[0]?.message).toMatch(/method/i);
    expect(await usageRows(path)).toEqual([
      expect.objectContaining({
        purpose: 'propose_draft',
        inputTokens: 80,
        outputTokens: 20,
      }),
    ]);
  });

  it('sends the issues of a step the model adds back with the values it wrote', async () => {
    const path = await workflow();
    const start = requests.length;
    const headers = { 'X-Trace': 'value-from-model' };
    const result = await propose(path, [
      candidate(
        withHttpConfig({
          url: 'https://orders.example.test',
          headers: { ...headers, 'X-Upstream-Token': 'model-typed' },
        }),
      ),
      candidate(
        withHttpConfig({ url: 'https://orders.example.test', headers }),
      ),
    ]);
    expect(result).toMatchObject({ kind: 'inspected', rounds: 1 });
    if (result.kind !== 'inspected') throw new Error('Expected a proposal');
    expect(
      result.draft.graph.nodes.find(({ id }) => id === 'request')?.config,
    ).toMatchObject({ headers });
    const { issues, previousGraph } = correction(requests[start + 1]);
    expect(
      issues.some(({ path }) =>
        path.startsWith('$.nodes.request.config.headers'),
      ),
    ).toBe(true);
    expect(JSON.stringify(previousGraph)).toContain('value-from-model');
    expect(JSON.stringify(previousGraph)).not.toContain('existing_setting');
  });

  it('refuses a placeholder copied onto a step the model adds and asks it to correct that', async () => {
    const path = await workflow();
    const start = requests.length;
    const copied = withHttpConfig({
      url: 'https://orders.example.test',
      headers: { kind: 'existing_setting' },
    });
    const result = await propose(path, [candidate(copied), candidate(valid)]);
    expect(result).toMatchObject({ kind: 'inspected', rounds: 1 });
    if (result.kind !== 'inspected') throw new Error('Expected a proposal');
    expect(JSON.stringify(result.draft.graph)).not.toContain(
      'existing_setting',
    );
    expect(correction(requests[start + 1]).issues).toEqual([
      expect.objectContaining({
        path: '$.nodes.request.config.headers',
        code: 'masked_placeholder_copied',
      }),
    ]);
  });

  it('corrects an invalid link port reported by publication', async () => {
    const path = await workflow();
    const start = requests.length;
    const invalidPort = {
      ...valid,
      edges: valid.edges.map((edge) => ({
        ...edge,
        target: { ...edge.target, port: 'missing' },
      })),
    };
    expect(
      await propose(path, [candidate(invalidPort), candidate(valid)]),
    ).toMatchObject({
      kind: 'inspected',
      rounds: 1,
      validation: { valid: true },
    });
    expect(requests.slice(start)).toHaveLength(2);
    expect(requests[start + 1]).toContain(
      'workflow edge target port is unavailable',
    );
  });

  it('repairs an omitted match condition instead of wiring a starter case', async () => {
    const path = await workflow();
    const start = requests.length;
    const [trigger] = valid.nodes;
    if (trigger === undefined) throw new Error('Expected a trigger fixture');
    const route = {
      ...trigger,
      id: 'route',
      definition: { key: 'core.switch', version: 2 },
      inputMappings: {
        value: { kind: 'run_input' as const, path: '$.category' },
      },
    };
    const graph = {
      ...valid,
      nodes: [...valid.nodes, route],
      edges: [
        {
          id: 'start-route',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: 'route', port: 'in' },
        },
        {
          id: 'route-request',
          source: { nodeId: 'route', port: 'case-01' },
          target: { nodeId: 'request', port: 'in' },
        },
      ],
    };
    const config = { cases: [{ id: 'case-01', equals: 'billing' }] };
    const result = await propose(path, [
      candidate(graph),
      candidate({ ...graph, nodes: [...valid.nodes, { ...route, config }] }),
    ]);
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 1,
      validation: { valid: true },
    });
    if (result.kind !== 'inspected') throw new Error('Expected a proposal');
    expect(result.draft.graph.nodes.find(({ id }) => id === route.id)).toEqual({
      ...route,
      config,
    });
    expect(requests.slice(start)).toHaveLength(2);
    expect(requests[start + 1]).toMatch(/config.*(case|invalid)/i);
  });

  it('returns the last candidate issues after two corrections', async () => {
    const path = await workflow();
    const start = requests.length;
    const result = await propose(path, [
      candidate(invalid),
      candidate(invalid),
      candidate(invalidUrl),
      candidate(valid),
    ]);
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 2,
      validation: {
        valid: false,
        issues: [{ path: '$.nodes.request.config.url' }],
      },
    });
    expect(requests.slice(start)).toHaveLength(3);
  });

  it('caps each call at the model limit and stops when the proposal budget is spent', async () => {
    const path = await workflow();
    const start = requests.length;
    const result = await propose(path, [
      { ...lookup('HTTP request'), outputTokens: 4_096 },
      { ...candidate(invalid), outputTokens: 4_096 },
      { ...candidate(invalidUrl), outputTokens: 4_096 },
      candidate(valid),
    ]);
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 1,
      validation: {
        valid: false,
        issues: [{ path: '$.nodes.request.config.url' }],
      },
      usage: { outputTokens: 12_288 },
    });
    const bodies = requests.slice(start);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toContain('"max_tokens":4096');
  });

  it('gives the last call only the output tokens that remain', async () => {
    const path = await workflow();
    const start = requests.length;
    const result = await propose(path, [
      { ...lookup('HTTP request'), outputTokens: 4_096 },
      { ...candidate(invalid), outputTokens: 4_095 },
      { ...candidate(invalidUrl), outputTokens: 4_096 },
      { ...candidate(valid), outputTokens: 1 },
    ]);
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 2,
      validation: { valid: true },
    });
    const bodies = requests.slice(start);
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).toContain('"max_tokens":1');
  });

  function lookup(query: string) {
    return { graph: null, text: JSON.stringify({ catalogLookup: query }) };
  }

  function correction(body: string | undefined) {
    const { messages } = JSON.parse(body ?? 'null') as {
      messages: { content?: string }[];
    };
    const { task } = JSON.parse(
      messages[0]?.content?.split('\n').at(-1) ?? 'null',
    ) as { task: string };
    return JSON.parse(task.split('\n').at(-1) ?? 'null') as {
      previousGraph?: unknown;
      issues: { path: string; code: string; message: string }[];
    };
  }

  function withHttpConfig(
    config: WorkflowGraph['nodes'][number]['config'],
  ): WorkflowGraph {
    return {
      ...httpWorkflow,
      nodes: httpWorkflow.nodes.map((node) =>
        node.id === 'request' ? { ...node, config } : node,
      ),
    };
  }
}
