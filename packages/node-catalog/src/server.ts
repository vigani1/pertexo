export { platformPortableDefinitionPolicy } from './portable-definition-policy.js';
export { validateRegisteredCuratedTemplateSetup } from './curated-template-policy.js';

import {
  createHttpRequestExecutorRegistration,
  type HttpRequestExecutorDependencies,
  type HttpRequestExecutorTelemetry,
  createSlackSendMessageExecutorRegistration,
  type SlackSendMessageExecutorDependencies,
  type SlackSendMessageExecutorTelemetry,
  createEmailSendNotificationExecutorRegistration,
  type EmailSendNotificationExecutorDependencies,
  type EmailSendNotificationExecutorTelemetry,
} from '@pertexo/integrations/server';
import {
  PLATFORM_NODE_CATALOG,
  PLATFORM_NODE_DEFINITION_REGISTRATIONS,
  resolvePlatformNodeDefinition,
} from './catalog.js';
import {
  createNodeRegistry,
  type NodeExecutorRegistration,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '@pertexo/nodes-core/server';

export { resolvePlatformNodeDefinition };

export type PlatformNodeRegistryDependencies = Readonly<{
  httpRequest: HttpRequestExecutorDependencies;
  httpRequestTelemetry?: HttpRequestExecutorTelemetry;
  slackSendMessage: SlackSendMessageExecutorDependencies;
  slackSendMessageTelemetry?: SlackSendMessageExecutorTelemetry;
  emailSendNotification: EmailSendNotificationExecutorDependencies;
  emailSendNotificationTelemetry?: EmailSendNotificationExecutorTelemetry;
}>;

/** The executing registry for the platform catalog; provider clients can be injected. */
export function createPlatformNodeRegistry(
  dependencies: PlatformNodeRegistryDependencies,
): NodeRegistry {
  const { httpRequest, slackSendMessage, emailSendNotification } = dependencies;
  const executors: readonly NodeExecutorRegistration[] = [
    ...CORE_NODE_EXECUTOR_REGISTRATIONS,
    createHttpRequestExecutorRegistration({
      ...httpRequest,
      ...(dependencies.httpRequestTelemetry === undefined
        ? {}
        : { telemetry: dependencies.httpRequestTelemetry }),
    }),
    createSlackSendMessageExecutorRegistration({
      ...slackSendMessage,
      ...(dependencies.slackSendMessageTelemetry === undefined
        ? {}
        : { telemetry: dependencies.slackSendMessageTelemetry }),
    }),
    createEmailSendNotificationExecutorRegistration({
      ...emailSendNotification,
      ...(dependencies.emailSendNotificationTelemetry === undefined
        ? {}
        : { telemetry: dependencies.emailSendNotificationTelemetry }),
    }),
  ];
  return createNodeRegistry({
    catalog: PLATFORM_NODE_CATALOG,
    definitions: PLATFORM_NODE_DEFINITION_REGISTRATIONS,
    executors,
  });
}
