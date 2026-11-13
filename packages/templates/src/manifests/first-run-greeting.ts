import type { WorkflowPortableManifest } from '@pertexo/workflow-model';

// A first run with nothing to set up: click Run, see a result.
export const FIRST_RUN_GREETING_MANIFEST: WorkflowPortableManifest = {
  format: 'pertexo.workflow',
  graph: {
    nodes: [
      {
        id: 'manual-start',
        definition: {
          key: 'core.manual',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'greeting',
        definition: {
          key: 'core.set',
          version: 1,
        },
        position: {
          x: 300,
          y: 0,
        },
        configVersion: 1,
        config: {},
        inputMappings: {
          message: {
            kind: 'literal',
            value: 'Hello from your first workflow',
          },
          shouted: {
            kind: 'expression',
            language: 'jsonata',
            expression: '$uppercase("it works")',
          },
        },
        connectionRefs: {},
      },
      {
        id: 'finish',
        definition: {
          key: 'core.terminate',
          version: 1,
        },
        position: {
          x: 600,
          y: 0,
        },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: {
            kind: 'node_output',
            nodeId: 'greeting',
            path: '$',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'start-greeting',
        source: {
          nodeId: 'manual-start',
          port: 'out',
        },
        target: {
          nodeId: 'greeting',
          port: 'in',
        },
      },
      {
        id: 'greeting-finish',
        source: {
          nodeId: 'greeting',
          port: 'out',
        },
        target: {
          nodeId: 'finish',
          port: 'in',
        },
      },
    ],
    settings: {
      maxRunDurationMs: 300000,
    },
  },
  requirements: {
    definitions: [
      {
        key: 'core.manual',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'core.set',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'core.terminate',
        version: 1,
        configVersion: 1,
      },
    ],
  },
  connectionSlots: [],
};
