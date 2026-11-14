export { validateRegisteredCuratedTemplateSetup } from './curated-template-policy.js';
export { platformPortableDefinitionPolicy } from './portable-definition-policy.js';

import {
  createHttpRequestExecutorRegistration,
  type HttpRequestExecutorDependencies,
  createSlackSendMessageExecutorRegistration,
  type SlackSendMessageExecutorDependencies,
  createEmailSendNotificationExecutorRegistration,
  type EmailSendNotificationExecutorDependencies,
} from '@pertexo/integrations/server';
import {
  PLATFORM_NODE_CATALOG,
  PLATFORM_NODE_DEFINITION_REGISTRATIONS,
} from './catalog.js';
import {
  createNodeRegistry,
  type NodeExecutorRegistration,
  type NodeRegistry,
} from '@pertexo/node-sdk/server';
import { CORE_NODE_EXECUTOR_REGISTRATIONS } from '@pertexo/nodes-core/server';

export type PlatformNodeRegistryDependencies = Readonly<{
  httpRequest: HttpRequestExecutorDependencies;
  httpRequestTelemetry?: HttpRequestExecutorDependencies['telemetry'];
  slackSendMessage: SlackSendMessageExecutorDependencies;
  slackSendMessageTelemetry?: SlackSendMessageExecutorDependencies['telemetry'];
  emailSendNotification: EmailSendNotificationExecutorDependencies;
  emailSendNotificationTelemetry?: EmailSendNotificationExecutorDependencies['telemetry'];
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
