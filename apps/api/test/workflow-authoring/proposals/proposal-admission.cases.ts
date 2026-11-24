import { randomUUID } from 'node:crypto';
import type { DraftProposalResult } from '@pertexo/contracts';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

export function proposalAdmissionCases({
  workflow,
  propose,
  draft,
  save,
  requests,
  manual,
  httpRequest,
  httpWorkflow,
}: Readonly<{
  workflow: () => Promise<string>;
  propose: (
    path: string,
    script: { graph: unknown }[],
    request?: string,
  ) => Promise<DraftProposalResult>;
  draft: (
    path: string,
  ) => Promise<{ payload: string; headers: { etag?: unknown } }>;
  save: (
    path: string,
    etag: unknown,
    graph: unknown,
  ) => Promise<{ statusCode: number; payload: string }>;
  requests: readonly string[];
  manual: WorkflowNode;
  httpRequest: WorkflowNode;
  httpWorkflow: WorkflowGraph;
}>) {
  it('hides disabled Code from discovery and refuses a new Code step', async () => {
    const path = await workflow();
    const graph = {
      ...httpWorkflow,
      nodes: [
        manual,
        { ...httpRequest, definition: { key: 'core.code', version: 1 } },
      ],
    };
    const candidate = { graph };
    const start = requests.length;
    const result = await propose(
      path,
      [candidate, candidate, candidate],
      'Add a Code step.',
    );
    const { messages } = JSON.parse(requests[start] ?? 'null') as {
      messages: readonly { content: string }[];
    };
    const { task } = JSON.parse(
      messages[0]?.content.split('\n').at(-1) ?? 'null',
    ) as { task: string };
    const { catalog } = JSON.parse(task.split('\n').at(-1) ?? 'null') as {
      catalog: readonly { definition: { key: string } }[];
    };
    expect(catalog.map(({ definition }) => definition.key)).not.toContain(
      'core.code',
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      issues: [{ code: 'definition_not_placeable' }],
    });
  });

  it('returns candidate issues for malformed and unavailable attachments', async () => {
    const path = await workflow();
    const initial = await draft(path);
    for (const [artifactId, message] of [
      [randomUUID(), 'The attachment is unavailable.'],
      ['invalid-artifact-id', 'The attachment reference is malformed.'],
    ] as const) {
      const file = {
        ...httpRequest,
        definition: { key: 'core.read_file', version: 1 },
        inputMappings: {
          file: {
            kind: 'literal',
            value: {
              kind: 'artifact',
              artifactId,
              sha256: '0'.repeat(64),
              byteLength: 1,
              mediaType: 'text/plain',
            },
          },
        },
      };
      const graph = { ...httpWorkflow, nodes: [manual, file] };
      const result = await propose(path, [{ graph }]);
      expect(result).toMatchObject({
        kind: 'rejected',
        issues: [{ path: '$.nodes[1].inputMappings.file.value', message }],
        rounds: 0,
      });
      expect(JSON.stringify(result)).not.toContain(artifactId);
      const saved = await save(path, initial.headers.etag, graph);
      expect(saved.statusCode, saved.payload).toBe(400);
    }
    expect((await draft(path)).payload).toBe(initial.payload);
  });

  it('reports a saved draft that exceeds the model request budget', async () => {
    const path = await workflow();
    const initial = await draft(path);
    const graph = {
      edges: [],
      settings: {},
      nodes: Array.from({ length: 150 }, (_, index) => ({
        ...manual,
        id: `step-${String(index)}`,
        label: 'Process the incoming order and record the line item',
      })),
    };
    const saved = await save(path, initial.headers.etag, graph);
    expect(saved.statusCode, saved.payload).toBe(200);
    const start = requests.length;
    expect(await propose(path, [])).toMatchObject({
      kind: 'request_too_large',
      rounds: 0,
    });
    expect(requests).toHaveLength(start);
  });
}
