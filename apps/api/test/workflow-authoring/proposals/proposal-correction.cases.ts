import type { DraftProposalResult } from '@pertexo/contracts';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

export function proposalCorrectionCases({
  workflow,
  propose,
  requests,
  httpWorkflow,
  deadlineMillis,
  usageRows,
}: Readonly<{
  workflow: () => Promise<string>;
  propose: (
    path: string,
    script: {
      name: string;
      args: object;
      outputTokens?: number;
      waitMillis?: number;
      hold?: boolean;
    }[],
  ) => Promise<DraftProposalResult>;
  requests: readonly string[];
  httpWorkflow: WorkflowGraph;
  deadlineMillis: number;
  usageRows: (path: string) => Promise<unknown[]>;
}>) {
  const valid = withHttpConfig({ url: 'https://orders.example.test' });
  const invalid = withHttpConfig({
    url: 'https://orders.example.test',
    method: 'INVALID',
  });
  const invalidUrl = withHttpConfig({ url: 42 });
  const candidate = (graph: unknown) => ({
    name: 'propose_draft',
    args: { graph },
  });

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
    const toolResult = messages.findLast(({ role }) => role === 'tool');
    expect(JSON.parse(toolResult?.content ?? 'null')).toMatchObject({
      issues: [
        {
          path: '$.nodes.request.config.method',
          code: 'invalid_graph',
          message: expect.stringMatching(/method/i),
        },
      ],
    });
    expect(await usageRows(path)).toEqual([
      expect.objectContaining({
        purpose: 'propose_draft',
        inputTokens: 80,
        outputTokens: 20,
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

  it('uses only the remaining output tokens and stops when the budget is consumed', async () => {
    const path = await workflow();
    const start = requests.length;
    const result = await propose(path, [
      { ...candidate(invalid), outputTokens: 4_095 },
      { ...candidate(invalidUrl), outputTokens: 1 },
      candidate(valid),
    ]);
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 1,
      validation: {
        valid: false,
        issues: [{ path: '$.nodes.request.config.url' }],
      },
      usage: { outputTokens: 4_096 },
    });
    const bodies = requests.slice(start);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('"max_tokens":4096');
    expect(bodies[1]).toContain('"max_tokens":1');
  });

  it('times out a correction on the original request deadline', async () => {
    const path = await workflow();
    const firstReplyMillis = 4_000;
    const start = requests.length;
    const startedAt = performance.now();
    const result = await propose(path, [
      { ...candidate(invalid), waitMillis: firstReplyMillis },
      { ...candidate(valid), hold: true },
    ]);
    expect(result).toMatchObject({ kind: 'timeout', rounds: 1 });
    expect(requests.slice(start)).toHaveLength(2);
    expect(performance.now() - startedAt).toBeLessThan(
      deadlineMillis + firstReplyMillis / 2,
    );
  });

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
