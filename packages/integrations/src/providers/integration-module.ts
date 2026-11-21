import type { ConnectionDefinition } from './connection-definition.js';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { NodeCatalog } from '@pertexo/node-sdk';
import type {
  NodeDefinitionRegistration,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import type { PostgresClient } from '../database/postgres-client.js';
import type { EmailSendNotificationExecutorDependencies } from '../email/send-notification/send-notification.executor.js';
import type { HttpRequestExecutorDependencies } from '../http/request/request.executor.js';
import type { SlackSendMessageExecutorDependencies } from '../slack/send-message/send-message.executor.js';

export type IntegrationExecutorDependencies = Readonly<{
  database?: PostgresClient;
  httpRequest: HttpRequestExecutorDependencies;
  httpRequestTelemetry?: HttpRequestExecutorDependencies['telemetry'];
  slackSendMessage: SlackSendMessageExecutorDependencies;
  slackSendMessageTelemetry?: SlackSendMessageExecutorDependencies['telemetry'];
  emailSendNotification: EmailSendNotificationExecutorDependencies;
  emailSendNotificationTelemetry?: EmailSendNotificationExecutorDependencies['telemetry'];
}>;

export type IntegrationPresentation = NonNullable<
  NodeDefinitionCatalogItem['presentation']
>;

export interface IntegrationModule {
  readonly key: string;
  readonly presentation: IntegrationPresentation;
  readonly steps: readonly Readonly<{
    registration: NodeDefinitionRegistration;
    createExecutor: (
      dependencies: IntegrationExecutorDependencies,
    ) => NodeExecutorRegistration;
    presentation?: Partial<IntegrationPresentation>;
  }>[];
  readonly connections?: readonly ConnectionDefinition[];
  readonly policies?: NodeCatalog['policies'];
}
