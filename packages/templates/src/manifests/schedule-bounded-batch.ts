import type { WorkflowPortableManifest } from '@pertexo/workflow-model';

// Public instructional base; setup and bindings must be explicitly configured.
export const SCHEDULE_BOUNDED_BATCH_MANIFEST: WorkflowPortableManifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
  graph: {
    schemaVersion: 1,
    nodes: [
      {
        id: 'schedule-start',
        definition: {
          key: 'core.schedule',
          version: 3,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 3,
        config: {
          kind: 'interval',
          intervalMinutes: 60,
          misfirePolicy: 'skip',
        },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'batch-items',
        definition: {
          key: 'core.foreach',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {},
        inputMappings: {
          items: {
            kind: 'literal',
            value: [
              {
                value: 'alpha',
              },
              {
                value: 'beta',
              },
            ],
          },
        },
        connectionRefs: {},
        structured: {
          kind: 'for_each',
          maxIterations: 3,
          maxConcurrency: 1,
          body: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'batch-body-result',
                definition: {
                  key: 'core.set',
                  version: 1,
                },
                position: {
                  x: 0,
                  y: 0,
                },
                configVersion: 1,
                config: {},
                inputMappings: {
                  item: {
                    kind: 'structured_input',
                    port: 'item',
                    path: '$',
                  },
                  ordinal: {
                    kind: 'structured_input',
                    port: 'ordinal',
                    path: '$',
                  },
                },
                connectionRefs: {},
              },
            ],
            edges: [],
            settings: {
              maxRunDurationMs: 300000,
            },
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
          },
        },
      },
      {
        id: 'batch-complete',
        definition: {
          key: 'core.terminate',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: {
            kind: 'node_output',
            nodeId: 'batch-items',
            path: '$',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'schedule-batch',
        source: {
          nodeId: 'schedule-start',
          port: 'out',
        },
        target: {
          nodeId: 'batch-items',
          port: 'in',
        },
      },
      {
        id: 'batch-complete-edge',
        source: {
          nodeId: 'batch-items',
          port: 'out',
        },
        target: {
          nodeId: 'batch-complete',
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
        key: 'core.foreach',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'core.schedule',
        version: 3,
        configVersion: 3,
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
