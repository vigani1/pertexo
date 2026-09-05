import './server-only.js';

import {
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
  EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
} from '@pertexo/integrations';
import {
  createHttpRequestExecutorRegistration,
  createNodeSecureHttpClient,
  type HttpRequestExecutorDependencies,
  type HttpRequestExecutorTelemetry,
  createSlackClient,
  createSlackSendMessageExecutorRegistration,
  type SlackSendMessageExecutorDependencies,
  type SlackSendMessageExecutorTelemetry,
  createEmailSendNotificationExecutorRegistration,
  createResendClient,
  type EmailSendNotificationExecutorDependencies,
  type EmailSendNotificationExecutorTelemetry,
} from '@pertexo/integrations/server';
import {
  parseSupportedPlatformRelease,
  platformIdentityToken,
  resolvePlatformNodeDefinitionForRelease,
} from './definition-resolution.js';
import {
  createNodeRegistry,
  type NodeDefinitionRegistration,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeExecutorRegistration,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';
import { CORE_NODE_DEFINITION_REGISTRATIONS } from '@pertexo/nodes-core';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '@pertexo/nodes-core/server';

export { resolvePlatformNodeDefinitionForRelease };

export type PlatformNodeRegistry = Readonly<{
  compatibility: NodeRegistry['compatibility'];
  historicalCatalog: NodeRegistry['historicalCatalog'];
  dispatchMode: NodeRegistry['dispatchMode'];
  execute(request: NodeExecutionRequest): Promise<NodeExecutionResult>;
}>;

export type PlatformNodeRegistryDependencies = Readonly<{
  httpRequest?: HttpRequestExecutorDependencies;
  httpRequestTelemetry?: HttpRequestExecutorTelemetry;
  slackSendMessage?: SlackSendMessageExecutorDependencies;
  slackSendMessageTelemetry?: SlackSendMessageExecutorTelemetry;
  emailSendNotification?: EmailSendNotificationExecutorDependencies;
  emailSendNotificationTelemetry?: EmailSendNotificationExecutorTelemetry;
}>;

export function createPlatformNodeRegistryForRelease(
  releaseInput: unknown,
  dependencies: PlatformNodeRegistryDependencies = {},
): PlatformNodeRegistry {
  const release = parseSupportedPlatformRelease(releaseInput);

  const definitionRegistrations: readonly NodeDefinitionRegistration[] = [
    ...CORE_NODE_DEFINITION_REGISTRATIONS,
    HTTP_REQUEST_DEFINITION_REGISTRATION,
    SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
    EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION,
  ];
  const definitionsByIdentity = new Map(
    definitionRegistrations.map((registration) => [
      platformIdentityToken(registration.manifest.definition),
      registration,
    ]),
  );
  const releaseDefinitions = release.definitions.map((manifest) => {
    const registration = definitionsByIdentity.get(
      platformIdentityToken(manifest.definition),
    );
    if (registration === undefined)
      throw new Error('Platform compatibility definition is not implemented');
    return Object.freeze({ ...registration, manifest });
  });

  const requiredExecutors = new Set(
    release.executors.map(({ executor }) => platformIdentityToken(executor)),
  );
  const providerExecutors: NodeExecutorRegistration[] = [];
  if (
    requiredExecutors.has(
      platformIdentityToken(
        HTTP_REQUEST_DEFINITION_REGISTRATION.manifest.executor,
      ),
    )
  ) {
    const httpRequestDependencies = dependencies.httpRequest ?? {
      httpClient: createNodeSecureHttpClient(),
    };
    providerExecutors.push(
      createHttpRequestExecutorRegistration(
        {
          ...httpRequestDependencies,
          ...(dependencies.httpRequestTelemetry === undefined
            ? {}
            : { telemetry: dependencies.httpRequestTelemetry }),
        },
        'active',
      ),
    );
  }
  if (
    requiredExecutors.has(
      platformIdentityToken(
        SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION.manifest.executor,
      ),
    )
  ) {
    const slackDependencies = dependencies.slackSendMessage ?? {
      client: createSlackClient(createNodeSecureHttpClient()),
    };
    providerExecutors.push(
      createSlackSendMessageExecutorRegistration(
        {
          ...slackDependencies,
          ...(dependencies.slackSendMessageTelemetry === undefined
            ? {}
            : { telemetry: dependencies.slackSendMessageTelemetry }),
        },
        'active',
      ),
    );
  }
  if (
    requiredExecutors.has(
      platformIdentityToken(
        EMAIL_SEND_NOTIFICATION_DEFINITION_REGISTRATION.manifest.executor,
      ),
    )
  ) {
    const emailDependencies = dependencies.emailSendNotification ?? {
      client: createResendClient(createNodeSecureHttpClient()),
    };
    providerExecutors.push(
      createEmailSendNotificationExecutorRegistration(
        {
          ...emailDependencies,
          ...(dependencies.emailSendNotificationTelemetry === undefined
            ? {}
            : { telemetry: dependencies.emailSendNotificationTelemetry }),
        },
        'active',
      ),
    );
  }
  const executorRegistrations: readonly NodeExecutorRegistration[] = [
    ...CORE_NODE_EXECUTOR_REGISTRATIONS,
    ...providerExecutors,
  ];
  const executorsByIdentity = new Map(
    executorRegistrations.map((registration) => [
      platformIdentityToken(registration.executor),
      registration,
    ]),
  );
  const releaseExecutors = release.executors.map((manifest) => {
    const registration = executorsByIdentity.get(
      platformIdentityToken(manifest.executor),
    );
    if (registration === undefined)
      throw new Error('Platform compatibility executor is not implemented');
    return Object.freeze({ ...manifest, execute: registration.execute });
  });
  const registry = createNodeRegistry({
    release,
    definitions: releaseDefinitions,
    executors: releaseExecutors,
  });
  return Object.freeze({
    compatibility: registry.compatibility,
    historicalCatalog: registry.historicalCatalog,
    dispatchMode: registry.dispatchMode,
    execute: registry.execute,
  });
}
