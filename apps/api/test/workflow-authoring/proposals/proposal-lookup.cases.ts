import type { DraftProposalResult } from '@pertexo/contracts';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

export function proposalLookupCases({
  workflow,
  propose,
  requests,
  httpWorkflow,
  draft,
}: Readonly<{
  workflow: () => Promise<string>;
  propose: (
    path: string,
    script: { graph: unknown; text?: string; outputTokens?: number }[],
    request: string,
  ) => Promise<DraftProposalResult>;
  requests: readonly string[];
  httpWorkflow: WorkflowGraph;
  draft: (path: string) => Promise<{ payload: string }>;
}>) {
  it('retrieves a missing step definition when the model asks and previews the resulting graph', async () => {
    const path = await workflow();
    const before = await draft(path);
    const start = requests.length;
    const graph = {
      ...httpWorkflow,
      nodes: httpWorkflow.nodes.map((node) =>
        node.id === 'request'
          ? { ...node, config: { url: 'https://orders.example.test' } }
          : node,
      ),
    };
    const result = await propose(
      path,
      [lookup('HTTP request'), { graph }],
      'When started by hand, get the latest order from the service.',
    );
    expect(result).toMatchObject({
      kind: 'inspected',
      rounds: 0,
      validation: { valid: true },
      usage: { kind: 'complete', inputTokens: 80, outputTokens: 20 },
    });
    const bodies = requests.slice(start);
    expect(bodies).toHaveLength(2);
    const initial = sentContext(bodies[0]);
    expect(
      initial.catalog.map(({ definition }) => definition.key),
    ).not.toContain('http.request');
    const recovered = sentContext(bodies[1]);
    expect(recovered.catalogLookupResult).toBe('found');
    expect(
      recovered.catalog.find(
        ({ definition }) => definition.key === 'http.request',
      ),
    ).toMatchObject({
      definition: { key: 'http.request', version: 1 },
      configSchema: { properties: { url: { type: 'string' } } },
      ports: { inputs: ['in'], outputs: ['out'] },
    });
    expect(recovered.catalog.length).toBeLessThanOrEqual(8);
    expect(
      Buffer.byteLength(JSON.stringify(recovered.catalog)),
    ).toBeLessThanOrEqual(16_384);
    expect(bodies[1]).toContain('"max_tokens":16384');
    expect((await draft(path)).payload).toBe(before.payload);
  });

  it('keeps disabled steps out of discovery and ends repeated lookup requests', async () => {
    const path = await workflow();
    const start = requests.length;
    expect(
      await propose(
        path,
        [lookup('Code'), lookup('Code'), { graph: httpWorkflow }],
        'Start it by hand.',
      ),
    ).toMatchObject({
      kind: 'invalid_response',
      rounds: 0,
      usage: { inputTokens: 80, outputTokens: 20 },
    });
    const bodies = requests.slice(start);
    expect(bodies).toHaveLength(2);
    expect(sentContext(bodies[1]).catalogLookupResult).toBe('no_matches');
    expect(
      sentContext(bodies[1]).catalog.map(({ definition }) => definition.key),
    ).not.toContain('core.code');
  });

  it('rejects a reply that tries to submit a draft and request a lookup together', async () => {
    const path = await workflow();
    const start = requests.length;
    const text = JSON.stringify({
      draft: httpWorkflow,
      catalogLookup: 'HTTP request',
    });
    expect(
      await propose(path, [{ graph: null, text }], 'Get the latest order.'),
    ).toMatchObject({ kind: 'invalid_response' });
    expect(requests.slice(start)).toHaveLength(1);
  });
}

function lookup(query: string) {
  return { graph: null, text: JSON.stringify({ catalogLookup: query }) };
}

function sentContext(body: string | undefined) {
  const { messages } = JSON.parse(body ?? 'null') as {
    messages: readonly { content: string }[];
  };
  const { task } = JSON.parse(
    messages[0]?.content.split('\n').at(-1) ?? 'null',
  ) as { task: string };
  return JSON.parse(task.split('\n').at(-1) ?? 'null') as {
    catalog: readonly { definition: { key: string } }[];
    catalogLookupResult?: string;
  };
}
