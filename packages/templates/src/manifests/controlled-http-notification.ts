import type { WorkflowPortableManifest } from '@pertexo/workflow-model';

// Public instructional base; setup and bindings must be explicitly configured.
export const CONTROLLED_HTTP_NOTIFICATION_MANIFEST: WorkflowPortableManifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
  graph: {
    schemaVersion: 1,
    nodes: [
      {
        id: 'notification-start',
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
        id: 'controlled-http',
        definition: {
          key: 'http.request',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://example.test/curated-demo',
          headers: {},
          timeoutMillis: 1000,
          maxRedirects: 0,
          maxResponseBytes: 1024,
          inlineResponseBytes: 1024,
        },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'notify-on-200',
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
            kind: 'expression',
            language: 'jsonata',
            expression: 'nodeOutputs."controlled-http".status = 200',
            policyVersion: 1,
          },
        },
        connectionRefs: {},
      },
      {
        id: 'slack-notification',
        definition: {
          key: 'slack.send_message',
          version: 1,
        },
        position: {
          x: 0,
          y: 0,
        },
        configVersion: 1,
        config: {
          timeoutMillis: 1000,
        },
        inputMappings: {
          channelId: {
            kind: 'literal',
            value: 'CEXAMPLE',
          },
          text: {
            kind: 'literal',
            value: 'Curated demo: controlled endpoint returned 200.',
          },
        },
        connectionRefs: {},
      },
      {
        id: 'notification-complete',
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
            value: 'notification-complete',
          },
        },
        connectionRefs: {},
      },
      {
        id: 'notification-skipped',
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
            value: 'notification-skipped',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'notification-http',
        source: {
          nodeId: 'notification-start',
          port: 'out',
        },
        target: {
          nodeId: 'controlled-http',
          port: 'in',
        },
      },
      {
        id: 'http-condition',
        source: {
          nodeId: 'controlled-http',
          port: 'out',
        },
        target: {
          nodeId: 'notify-on-200',
          port: 'in',
        },
      },
      {
        id: 'condition-slack',
        source: {
          nodeId: 'notify-on-200',
          port: 'true',
        },
        target: {
          nodeId: 'slack-notification',
          port: 'in',
        },
      },
      {
        id: 'slack-complete',
        source: {
          nodeId: 'slack-notification',
          port: 'out',
        },
        target: {
          nodeId: 'notification-complete',
          port: 'in',
        },
      },
      {
        id: 'condition-skip',
        source: {
          nodeId: 'notify-on-200',
          port: 'false',
        },
        target: {
          nodeId: 'notification-skipped',
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
        key: 'core.webhook',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'http.request',
        version: 1,
        configVersion: 1,
      },
      {
        key: 'slack.send_message',
        version: 1,
        configVersion: 1,
      },
    ],
    selectionFingerprint:
      'node-select:v1:sha256:8d088833aecf943752bcd78cf18475e682cfae0b62f1b6445fb709fc4bd53513',
  },
  connectionSlots: [
    {
      nodeId: 'controlled-http',
      slot: 'http_headers',
      providerKey: 'http',
      authType: 'http_headers',
    },
    {
      nodeId: 'slack-notification',
      slot: 'slack_bot_token',
      providerKey: 'slack',
      authType: 'slack_bot_token',
    },
  ],
};
