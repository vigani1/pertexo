import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';

export type FileWorkload = 'raw' | 'multipart' | 'csv' | 'json' | 'http';
export function fileNode(id: string, key: string): WorkflowNode {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}
export function fileLink(source: string, target: string) {
  return {
    id: `${source}-${target}`,
    source: { nodeId: source, port: 'out' },
    target: { nodeId: target, port: 'in' },
  };
}
const filePart = 'part_11111111-1111-4111-8111-111111111111';
function httpConfig(url: string, method: 'GET' | 'POST') {
  return {
    method,
    url,
    headers: {},
    timeoutMillis: method === 'POST' ? 30000 : 5000,
    maxRedirects: 0,
    maxResponseBytes: 10485760,
    inlineResponseBytes: 262144,
  };
}
/** Every run has its own workflow, preserving default workflow/workspace limits. */
export function fileGraph(kind: FileWorkload, origin: string): WorkflowGraph {
  const manual = fileNode('manual', 'core.manual');
  let steps: WorkflowNode[];
  if (kind === 'raw' || kind === 'multipart') {
    const send: WorkflowNode = {
      ...fileNode('send', 'http.request'),
      config: {
        ...httpConfig(`${origin}/${kind}`, 'POST'),
        ...(kind === 'multipart'
          ? {
              multipart: {
                parts: [
                  {
                    inputKey: filePart,
                    name: 'file',
                    kind: 'file',
                    filename: 'qualification.bin',
                  },
                  ...Array.from({ length: 63 }, (_, index) => ({
                    inputKey: `part_${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`,
                    name: `text-${String(index)}`,
                    kind: 'text',
                  })),
                ],
              },
            }
          : {}),
      },
      inputMappings:
        kind === 'raw'
          ? { body: { kind: 'run_input', path: '$.file' } }
          : {
              [filePart]: { kind: 'run_input', path: '$.file' },
              ...Object.fromEntries(
                Array.from({ length: 63 }, (_, index) => [
                  `part_${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`,
                  { kind: 'literal' as const, value: `field-${String(index)}` },
                ]),
              ),
            },
    };
    steps = [manual, send];
  } else {
    const read: WorkflowNode =
      kind === 'http'
        ? {
            ...fileNode('read', 'http.request'),
            config: {
              ...httpConfig(`${origin}/items`, 'GET'),
              pagination: {
                mode: 'next_link',
                source: { kind: 'body', path: '$.next' },
                itemsPath: '$.data',
                maxPages: 100,
                delayMillis: 0,
                outputMode: 'pages',
              },
            },
          }
        : {
            ...fileNode('read', 'core.read_file'),
            config: {
              format: kind,
              outputMode: 'pages',
              ...(kind === 'csv'
                ? { delimiter: ',', convertValues: true }
                : {}),
            },
            inputMappings: { file: { kind: 'run_input', path: '$.file' } },
          };
    const create: WorkflowNode = {
      ...fileNode('create', 'core.create_file'),
      config: { format: 'json', inputMode: 'pages' },
      inputMappings: {
        pages: { kind: 'node_output', nodeId: 'read', path: '$.pages' },
      },
    };
    steps = [manual, read, create];
  }
  const finish: WorkflowNode = {
    ...fileNode('finish', 'core.terminate'),
    inputMappings: {
      result: {
        kind: 'node_output',
        nodeId: steps.at(-1)?.id ?? '',
        path: '$',
      },
    },
  };
  const nodes = [...steps, finish];
  return {
    settings: { maxRunDurationMs: 600000 },
    nodes,
    edges: nodes
      .slice(1)
      .map((target, index) => fileLink(nodes[index]?.id ?? '', target.id)),
  };
}
export function quietFileGraph(): WorkflowGraph {
  const nodes = [
    fileNode('manual', 'core.manual'),
    {
      ...fileNode('set', 'core.set'),
      inputMappings: {
        value: { kind: 'literal' as const, value: 'short-work' },
      },
    },
    fileNode('finish', 'core.terminate'),
  ];
  return {
    settings: { maxRunDurationMs: 30000 },
    nodes,
    edges: nodes
      .slice(1)
      .map((target, index) => fileLink(nodes[index]?.id ?? '', target.id)),
  };
}

/** Two ordinary pages exercise both loop levels without changing loop budgets. */
export function pagedLoopGraph(origin: string): WorkflowGraph {
  const read: WorkflowNode = {
    ...fileNode('read', 'core.read_file'),
    config: { format: 'csv', delimiter: ',', outputMode: 'pages' },
    inputMappings: { file: { kind: 'run_input', path: '$.file' } },
  };
  const load: WorkflowNode = {
    ...fileNode('load', 'core.read_file'),
    config: { format: 'json' },
    inputMappings: {
      file: { kind: 'structured_input', port: 'item', path: '$' },
    },
  };
  const row: WorkflowNode = {
    ...fileNode('row', 'core.foreach'),
    inputMappings: {
      items: { kind: 'node_output', nodeId: 'load', path: '$' },
    },
    structured: {
      kind: 'for_each',
      maxIterations: 1000,
      maxConcurrency: 16,
      body: {
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
        edges: [],
        nodes: [
          {
            ...fileNode('value', 'core.set'),
            inputMappings: {
              amount: {
                kind: 'structured_input',
                port: 'item',
                path: '$.amount',
              },
            },
          },
        ],
      },
    },
  };
  const summarize: WorkflowNode = {
    ...fileNode('summarize', 'core.summarize'),
    config: { valuePath: '$.amount', groupBy: '$.currency', missing: 'error' },
    inputMappings: {
      items: { kind: 'node_output', nodeId: 'load', path: '$' },
    },
  };
  const page: WorkflowNode = {
    ...fileNode('page', 'core.foreach'),
    inputMappings: {
      items: { kind: 'node_output', nodeId: 'read', path: '$.pages' },
    },
    structured: {
      kind: 'for_each',
      maxIterations: 2,
      maxConcurrency: 1,
      body: {
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
        nodes: [load, row, summarize],
        edges: [
          fileLink('load', 'row'),
          fileLink('row', 'summarize'),
          fileLink('load', 'summarize'),
        ],
      },
    },
  };
  const create: WorkflowNode = {
    ...fileNode('create', 'core.create_file'),
    config: { format: 'json', inputMode: 'pages' },
    inputMappings: {
      pages: { kind: 'node_output', nodeId: 'read', path: '$.pages' },
    },
  };
  const send: WorkflowNode = {
    ...fileNode('send', 'http.request'),
    config: {
      ...httpConfig(`${origin}/multipart`, 'POST'),
      multipart: {
        parts: [
          {
            inputKey: filePart,
            name: 'file',
            kind: 'file',
            filename: 'result.json',
          },
        ],
      },
    },
    inputMappings: {
      [filePart]: { kind: 'node_output', nodeId: 'create', path: '$.file' },
    },
  };
  const finish: WorkflowNode = {
    ...fileNode('finish', 'core.terminate'),
    inputMappings: {
      summaries: { kind: 'node_output', nodeId: 'page', path: '$.results' },
      response: { kind: 'node_output', nodeId: 'send', path: '$' },
    },
  };
  const nodes = [
    fileNode('manual', 'core.manual'),
    read,
    page,
    create,
    send,
    finish,
  ];
  return {
    settings: { maxRunDurationMs: 600000 },
    nodes,
    edges: [
      ...nodes
        .slice(1)
        .map((target, index) => fileLink(nodes[index]?.id ?? '', target.id)),
      fileLink('read', 'create'),
      fileLink('page', 'finish'),
    ],
  };
}
