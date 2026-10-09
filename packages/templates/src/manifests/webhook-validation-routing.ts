import type { WorkflowPortableManifest } from '@pertexo/workflow-model/portability-contract';

// Public instructional base; setup and bindings must be explicitly configured.
export const WEBHOOK_VALIDATION_ROUTING_MANIFEST: WorkflowPortableManifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
  graph: {
    schemaVersion: 1,
    nodes: [
      {
        id: 'webhook-start',
        definition: {
          key: 'core.webhook',
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
        id: 'validate-request',
        definition: {
          key: 'core.validate',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {
          rules: [
            {
              id: 'request-type',
              path: '$.payload.type',
              required: true,
              type: 'string',
              enum: ['notification'],
            },
          ],
        },
        inputMappings: {
          payload: {
            kind: 'run_input',
            path: '$',
          },
        },
        connectionRefs: {},
      },
      {
        id: 'route-validity',
        definition: {
          key: 'core.condition',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {},
        inputMappings: {
          condition: {
            kind: 'node_output',
            nodeId: 'validate-request',
            path: '$.valid',
          },
        },
        connectionRefs: {},
      },
      {
        id: 'accepted',
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
          outcome: {
            kind: 'literal',
            value: 'accepted',
          },
        },
        connectionRefs: {},
      },
      {
        id: 'rejected',
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
          outcome: {
            kind: 'literal',
            value: 'rejected',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'start-validate',
        source: {
          nodeId: 'webhook-start',
          port: 'out',
        },
        target: {
          nodeId: 'validate-request',
          port: 'in',
        },
      },
      {
        id: 'validate-route',
        source: {
          nodeId: 'validate-request',
          port: 'out',
        },
        target: {
          nodeId: 'route-validity',
          port: 'in',
        },
      },
      {
        id: 'route-accepted',
        source: {
          nodeId: 'route-validity',
          port: 'true',
        },
        target: {
          nodeId: 'accepted',
          port: 'in',
        },
      },
      {
        id: 'route-rejected',
        source: {
          nodeId: 'route-validity',
          port: 'false',
        },
        target: {
          nodeId: 'rejected',
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
        key: 'core.condition',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'core.terminate',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'core.validate',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'core.webhook',
        version: 1,
        configVersion: 1,
      },
    ],
    selectionFingerprint:
      'node-select:v1:sha256:a0be3045940d79316109ba42ce12878987f59a13a5ee16c352a70948f5ba1090',
  },
  connectionSlots: [],
};
