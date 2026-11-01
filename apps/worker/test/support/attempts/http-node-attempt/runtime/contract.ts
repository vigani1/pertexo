import type { NodeAttemptRunStore } from '@pertexo/core/attempts';
import type { WorkerConnectionResolutionStore } from '@pertexo/core/connections';

import type {
  ResendClient,
  SecureHttpTransportRequest,
  SecureHttpTransportResponse,
  SlackClient,
} from '@pertexo/integrations/server';

import type { NodeConnectionRuntime } from '@pertexo/node-sdk/server';

import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';

type ConnectionAssertCurrentInput = Parameters<
  NonNullable<NodeConnectionRuntime['assertCurrent']>
>[0];

export type HttpNodeAttemptProofRuntimeOptions = Readonly<{
  afterConnectionAssertCurrent?: (
    input: Omit<ConnectionAssertCurrentInput, 'signal'>,
  ) => Promise<void>;
  afterAttemptClaimed?: (
    result: Awaited<ReturnType<NodeAttemptRunStore['claimDelivery']>>,
  ) => Promise<void>;
  afterHeartbeat?: (
    result: Awaited<ReturnType<NodeAttemptRunStore['heartbeat']>>,
  ) => Promise<void>;
  beforeHeartbeat?: (
    input: Parameters<NodeAttemptRunStore['heartbeat']>[0],
  ) => Promise<void>;
  beforeConnectionResolve?: (
    input: Parameters<
      WorkerConnectionResolutionStore['resolveConnectionSecret']
    >[0],
  ) => Promise<void>;
  beforeMarkDispatched?: (
    input: Parameters<NodeAttemptRunStore['markDispatched']>[0],
  ) => Promise<void>;
  beforeRegistryExecute?: (
    request: Parameters<NodeExecutionRegistry['execute']>[0],
  ) => Promise<void>;
  dispatchHttp?: (
    request: SecureHttpTransportRequest,
  ) => Promise<SecureHttpTransportResponse>;
  emailResponseScript?: readonly Awaited<
    ReturnType<ResendClient['sendNotification']>
  >[];
  sendSlackMessage?: SlackClient['sendMessage'];
  sendEmailNotification?: ResendClient['sendNotification'];
  heartbeatIntervalMillis?: number;
  leaseDurationSeconds?: number;
}>;
