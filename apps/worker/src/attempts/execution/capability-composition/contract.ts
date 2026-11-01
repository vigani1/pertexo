import type { CallbackStore, RunValuesStore } from '@pertexo/core/runs';
import type {
  CallbackKeyConfig,
  CallbackTokenKeys,
} from '@pertexo/integrations/server';

import type { WorkerDataTablesStore } from '@pertexo/core/data-tables';

import type { createCodeRunnerClient } from '../../code/client.js';
import type { WorkerCodeRunnerConfig } from '../../code/client.js';

import type { WebhookResponseStore } from '@pertexo/core/triggers';
import type {
  ArtifactStore,
  ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import type { WorkerConnectionResolutionStore } from '@pertexo/core/connections';

import type {
  DatabaseConfig,
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import type {
  ConnectionEnvelopeEncryptionConfig,
  ConnectionEnvelopeEncryptionRuntime,
  ConnectionEnvelopeEncryption,
  AllowedPrivateNetwork,
  OAuth2TokenService,
} from '@pertexo/integrations/server';
import type { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import type { NodeExecutionCapabilityFactories } from '../capabilities.js';
import type { createProviderConnectionRuntimeFactory } from '../../../providers/connections.js';
import type { ProviderRateLimiter } from '../../../providers/connections.js';
import type {
  ArtifactSpoolOperations,
  WorkerArtifactPersistence,
} from '../../artifacts/runtime.js';

export type WorkerNodeRuntimeCapabilityOptions = Readonly<{
  callbacks?: CallbackKeyConfig;
  database: DatabaseConfig;
  codeRunner?: WorkerCodeRunnerConfig;
  connectionEncryption?: ConnectionEnvelopeEncryptionConfig;
  allowedPrivateNetworks?: readonly AllowedPrivateNetwork[];
  artifactStore?: ArtifactStoreConfig;
  artifactRetentionMillis?: number;
  artifactScratchDirectory?: string;
  redisUrl?: string;
}>;

export type WorkerNodeRuntimeCapabilityDependencies = Readonly<{
  callbackStore?: CallbackStore;
  databaseRuntime?: DatabaseRuntime;
  webhookResponses?: Pick<WebhookResponseStore, 'respond'>;
  dataTables?: Pick<WorkerDataTablesStore, 'execute'>;
  runValues?: Pick<RunValuesStore, 'save'>;
  connectionDatabase?: Parameters<
    typeof createProviderConnectionRuntimeFactory
  >[0];
  connectionEncryption?: Pick<ConnectionEnvelopeEncryption, 'open'>;
  artifactPersistence?: WorkerArtifactPersistence;
  artifactStore?: Pick<ArtifactStore, 'put'> &
    Partial<Pick<ArtifactStore, 'checkReadiness' | 'getStream'>>;
  artifactId?: () => string;
  now?: () => Date;
  spoolDirectory?: string;
  artifactSpoolOperations?: ArtifactSpoolOperations;
  providerRateLimiter?: ProviderRateLimiter;
}>;

export type WorkerNodeRuntimeCapabilities = Readonly<{
  factories: NodeExecutionCapabilityFactories;
  checkReadiness(): Promise<void>;
  checkObjectStore(): Promise<void>;
  close(): Promise<void>;
}>;

interface OwnedCapabilityResources {
  ownedCallbacks: CallbackStore | undefined;
  callbackKeys: CallbackTokenKeys | undefined;
  ownedDataTables: WorkerDataTablesStore | undefined;
  ownedRunValues: RunValuesStore | undefined;
  ownedWebhookResponses: WebhookResponseStore | undefined;
  encryptionRuntime: ConnectionEnvelopeEncryptionRuntime | undefined;
  oauth2Tokens: OAuth2TokenService | undefined;
  ownedConnectionStore: WorkerConnectionResolutionStore | undefined;
  ownedArtifactDatabase: WorkspaceDatabase | undefined;
  ownedArtifactStore: ArtifactStore | undefined;
  ownedProviderRateLimiter: RedisRateLimitRuntime | undefined;
}

export interface CapabilityAssembly {
  readonly options: WorkerNodeRuntimeCapabilityOptions;
  readonly dependencies: WorkerNodeRuntimeCapabilityDependencies;
  readonly resources: OwnedCapabilityResources;
  readonly factories: {
    callbacks?: NonNullable<NodeExecutionCapabilityFactories['callbacks']>;
    runValues?: NonNullable<NodeExecutionCapabilityFactories['runValues']>;
    dataTables?: NonNullable<NodeExecutionCapabilityFactories['dataTables']>;
    code?: NonNullable<NodeExecutionCapabilityFactories['code']>;
    connections?: NonNullable<NodeExecutionCapabilityFactories['connections']>;
    artifacts?: NonNullable<NodeExecutionCapabilityFactories['artifacts']>;
    webhookResponse?: NonNullable<
      NodeExecutionCapabilityFactories['webhookResponse']
    >;
  };
  readonly lifecycle: { terminal: boolean };
  closePromise?: Promise<void> | undefined;
  checkArtifactReadiness?: (() => unknown) | undefined;
  /** Reachability only: workflows that touch no files run without the store. */
  checkObjectStore?: (() => Promise<unknown>) | undefined;
  readonly retentionMillis: number;
  readonly codeClient: ReturnType<typeof createCodeRunnerClient> | undefined;
}
