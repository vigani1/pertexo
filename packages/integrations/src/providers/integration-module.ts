import type { NodeConnectionRuntime } from '@pertexo/node-sdk/server';
import type {
  MaterializedPollConfig,
  JsonValue,
} from '@pertexo/workflow-model';
import type { ConnectionLookup } from './connection-lookup.js';
import type { ProviderHttpClient } from './http-client.js';
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
  httpClient: Pick<ProviderHttpClient, 'executeStreaming' | 'redactText'>;
  httpRequest?: HttpRequestExecutorDependencies;
  httpRequestTelemetry?: HttpRequestExecutorDependencies['telemetry'];
  fixedEndpointHttpClient: Pick<ProviderHttpClient, 'execute'>;
  slackSendMessage?: SlackSendMessageExecutorDependencies;
  slackSendMessageTelemetry?: SlackSendMessageExecutorDependencies['telemetry'];
  smtp?: EmailSendNotificationExecutorDependencies['smtp'];
  emailSendNotification?: EmailSendNotificationExecutorDependencies;
  emailSendNotificationTelemetry?: EmailSendNotificationExecutorDependencies['telemetry'];
}>;

export type IntegrationPollFetcher = (
  input: Readonly<{
    config: MaterializedPollConfig;
    seenKeys: readonly string[];
    maxItems: number;
    maxPages: number;
    signal: AbortSignal;
  }>,
  dependencies: Readonly<{
    httpClient: Pick<ProviderHttpClient, 'executeStreaming'>;
    database: PostgresClient;
    connections?: () => NodeConnectionRuntime;
  }>,
) => Promise<readonly Readonly<{ key: string | number; item: JsonValue }>[]>;

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
    fetchPoll?: IntegrationPollFetcher;
    presentation?: Partial<IntegrationPresentation>;
  }>[];
  readonly executorSummaryCodes?: readonly string[];
  readonly lookups?: readonly ConnectionLookup[];
  readonly connections?: readonly ConnectionDefinition[];
  readonly policies?: NodeCatalog['policies'];
}
