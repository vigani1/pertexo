import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { editorProviderTarget } from '../../../../../../infrastructure/testing/editor-provider-target.mjs';
import { createNodeProviderHttpClient } from '../../../../src/providers/http-client.js';
import { withArtifactReadOutage } from '../artifact-read-retry.js';

import { createPlatformNodeRegistry } from '../../../../src/providers/node-registry.js';

import type {
  EditorBrowserWorkerState,
  EditorWorkerCapabilities,
  EditorWorkerHttpClient,
  EditorWorkerAttemptContext,
} from './editor-execution.types.js';
import { artifactInputs, emailAttachments } from './environment.js';

export function editorAttemptDependencies(context: EditorWorkerAttemptContext) {
  const { controlledCapabilities, controlledHttpClient, state } = context;
  if (
    controlledCapabilities === undefined ||
    controlledHttpClient === undefined
  )
    return pureEditorDependencies(controlledCapabilities);
  return controlledEditorDependencies({
    controlledCapabilities,
    controlledHttpClient,
    state,
  });
}

function pureEditorDependencies(
  controlledCapabilities: EditorWorkerCapabilities | undefined,
) {
  return {
    runtimeCapabilities: {
      ...(controlledCapabilities?.factories.callbacks === undefined
        ? {}
        : { callbacks: controlledCapabilities.factories.callbacks }),
      ...(controlledCapabilities?.factories.runValues === undefined
        ? {}
        : { runValues: controlledCapabilities.factories.runValues }),
      ...(controlledCapabilities?.factories.dataTables === undefined
        ? {}
        : { dataTables: controlledCapabilities.factories.dataTables }),
      ...(controlledCapabilities?.factories.webhookResponse === undefined
        ? {}
        : {
            webhookResponse: controlledCapabilities.factories.webhookResponse,
          }),
      ...(controlledCapabilities?.factories.code === undefined
        ? {}
        : { code: controlledCapabilities.factories.code }),
      connections: () => ({
        resolve: () =>
          Promise.reject(
            new Error('Provider access is outside this pure-node fixture'),
          ),
      }),
      // Only the file journeys configure a real artifact store.
      artifacts:
        controlledCapabilities?.factories.artifacts ??
        (() => ({
          write: () =>
            Promise.reject(
              new Error('Artifacts are outside this pure-node fixture'),
            ),
        })),
    },
  };
}

function controlledEditorDependencies(
  context: Readonly<{
    controlledCapabilities: EditorWorkerCapabilities;
    controlledHttpClient: EditorWorkerHttpClient;
    state: EditorBrowserWorkerState;
  }>,
) {
  const { controlledCapabilities, controlledHttpClient, state } = context;
  return {
    registry: createPlatformNodeRegistry(
      {
        httpRequest: { httpClient: controlledHttpClient },
        fixedEndpointHttpClient: editorFixedEndpointHttpClient(),
        // Never allow unused provider executors to fall back to real networking.
        slackSendMessage: {
          client: state.curatedTarget?.slackClient ?? {
            sendMessage: () =>
              Promise.reject(
                new Error('Provider outside controlled HTTP fixture'),
              ),
          },
        },
        emailSendNotification: {
          client: state.resendMailbox?.client ?? {
            sendNotification: () =>
              Promise.reject(
                new Error('Provider outside controlled HTTP fixture'),
              ),
          },
        },
      },
      process.env.EDITOR_BROWSER_CASE === 'product'
        ? {
            allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
            allowPlaintext: false,
          }
        : undefined,
    ),
    runtimeCapabilities: {
      ...(artifactInputs
        ? withArtifactReadOutage(controlledCapabilities.factories)
        : controlledCapabilities.factories),
      ...(artifactInputs || emailAttachments
        ? {}
        : {
            artifacts: () => ({
              write: () =>
                Promise.reject(
                  new Error('Artifacts outside inline HTTP fixture'),
                ),
            }),
          }),
    },
  };
}

function editorFixedEndpointHttpClient() {
  const port = process.env.PERTEXO_LIVE_PROVIDER_PORT;
  const client = createNodeProviderHttpClient({
    allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
  });
  return {
    execute: (input: Parameters<typeof client.execute>[0]) => {
      const target =
        process.env.EDITOR_BROWSER_CASE === 'product' && port !== undefined
          ? editorProviderTarget(input, port)
          : undefined;
      return target === undefined
        ? Promise.reject(new Error('Provider outside controlled HTTP fixture'))
        : client.execute(target);
    },
  };
}
