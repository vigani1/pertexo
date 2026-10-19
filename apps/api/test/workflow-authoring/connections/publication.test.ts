import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import { missingConnectionIssues } from '../../../src/platform/workflow/connection-validation.js';

const catalog: WorkflowDefinitionCatalog = {
  definitions: [
    { key: 'core.set', version: 1 },
    {
      key: 'http.request',
      version: 1,
      integration: {
        providerKey: 'http',
        operationKey: 'request',
        connectionSlots: ['http_headers'],
      },
    },
  ],
};

type Node = WorkflowGraph['nodes'][number];
const node = (
  id: string,
  key: string,
  connectionRefs: Record<string, string> = {},
  structured?: Node['structured'],
): Node => ({
  id,
  definition: { key, version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs,
  ...(structured === undefined ? {} : { structured }),
});
const graph = (...nodes: Node[]): WorkflowGraph => ({
  nodes,
  edges: [],
  settings: {},
});

describe('connection publication policy', () => {
  it('asks for a connection on a step that sends through one', () => {
    expect(
      missingConnectionIssues(graph(node('call', 'http.request')), catalog),
    ).toEqual([
      {
        code: 'invalid_graph',
        path: '$.nodes.call.connectionRefs.http_headers',
        message: 'Choose a connection for this step.',
      },
    ]);
  });

  it('accepts a chosen connection and steps without one', () => {
    expect(
      missingConnectionIssues(
        graph(
          node('call', 'http.request', {
            http_headers: '01900000-0000-7000-8000-000000000001',
          }),
          node('shape', 'core.set'),
        ),
        catalog,
      ),
    ).toEqual([]);
  });

  it('skips a disabled step, which never runs', () => {
    expect(
      missingConnectionIssues(
        graph({ ...node('call', 'http.request'), disabled: true }),
        catalog,
      ),
    ).toEqual([]);
  });

  it('finds the step inside a For each body', () => {
    const loop = node(
      'each',
      'core.foreach',
      {},
      {
        kind: 'for_each',
        maxIterations: 10,
        maxConcurrency: 1,
        body: {
          nodes: [node('call', 'http.request')],
          edges: [],
          settings: {},
          inputPorts: ['item', 'ordinal'],
          outputPorts: ['result'],
        },
      },
    );
    expect(
      missingConnectionIssues(graph(loop), catalog).map((issue) => issue.path),
    ).toEqual([
      '$.nodes.each.structured.body.nodes.call.connectionRefs.http_headers',
    ]);
  });
});
