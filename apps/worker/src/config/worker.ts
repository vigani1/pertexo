import {
  parseCallbackKeyConfig,
  type CallbackKeyConfig,
} from '@pertexo/integrations/server';
import path from 'node:path';
import { parseCodeSettings, codeRunnerSocketPath } from '@pertexo/node-sdk';
import type { WorkerCodeRunnerConfig } from '../attempts/code/client.js';
import { z } from 'zod';
import {
  parseArtifactStoreConfig,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  parseMaintenanceDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import {
  parseConnectionEncryptionConfig,
  type ConnectionEnvelopeEncryptionConfig,
  parseAllowedPrivateNetworks,
  type SecureHttpAddressPolicy,
} from '@pertexo/integrations/server';
import {
  parseSystemMailDeliveryConfig,
  type SystemMailDeliveryConfig,
} from './system-mail.js';
import {
  parseInvitationDeliveryConfig,
  type InvitationDeliveryConfig,
} from './invitation-delivery.js';
import { workerConfigSchema } from './worker/environment.js';

export type WorkerConfig = Readonly<
  z.output<typeof workerConfigSchema> & {
    callbacks?: CallbackKeyConfig;
    artifactStore: ArtifactStoreConfig;
    artifactScratchDirectory: string;
    codeRunner: WorkerCodeRunnerConfig;
    httpRequest: SecureHttpAddressPolicy;
    retention: RetentionConfig;
    connectionEncryption?: ConnectionEnvelopeEncryptionConfig;
    invitationDelivery?: InvitationDeliveryConfig;
    systemMailDelivery?: SystemMailDeliveryConfig;
  }
>;

export type RetentionConfig = Readonly<{
  maintenanceDatabase: DatabaseConfig;
}>;

function stringEnvironment(
  environment: Readonly<Record<string, unknown>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => {
      if (value === undefined || typeof value === 'string')
        return [name, value];
      if (typeof value === 'number' || typeof value === 'boolean')
        return [name, String(value)];
      throw new TypeError('Worker environment values must be scalar');
    }),
  );
}

function artifactStoreConfig(
  environment: Readonly<Record<string, string | undefined>>,
  { deployed }: Readonly<{ deployed: boolean }>,
): ArtifactStoreConfig {
  const parsed = parseArtifactStoreConfig(environment);
  if (deployed && new URL(parsed.endpoint).protocol !== 'https:')
    throw new Error('HTTPS artifact store endpoint is required when deployed');
  return parsed;
}

export function parseWorkerConfig(
  environment: Readonly<Record<string, unknown>> = process.env,
): WorkerConfig {
  const result = workerConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new Error('Invalid worker configuration', { cause: result.error });
  }
  try {
    const raw = stringEnvironment(environment);
    const deployed =
      result.data.nodeEnv === 'staging' || result.data.nodeEnv === 'production';
    const callbacks = parseCallbackKeyConfig(raw, { deployed });
    const connectionEncryption = parseConnectionEncryptionConfig(raw, {
      deployed,
    });
    const artifactStore = artifactStoreConfig(raw, { deployed: deployed });
    const artifactScratchDirectory = z
      .object({
        ARTIFACT_SCRATCH_DIRECTORY: z.string().min(1).max(4096),
      })
      .parse({
        ARTIFACT_SCRATCH_DIRECTORY:
          raw.ARTIFACT_SCRATCH_DIRECTORY ??
          (deployed ? undefined : path.resolve('.pertexo/worker-scratch')),
      }).ARTIFACT_SCRATCH_DIRECTORY;
    if (!path.isAbsolute(artifactScratchDirectory))
      throw new Error(
        'ARTIFACT_SCRATCH_DIRECTORY must be an absolute private disk-backed directory',
      );
    const invitationDelivery = parseInvitationDeliveryConfig(raw, {
      deployed: deployed,
    });
    const systemMailDelivery = parseSystemMailDeliveryConfig(raw, {
      deployed: deployed,
    });
    if (deployed && connectionEncryption === undefined)
      throw new Error('A deployed worker requires connection encryption');
    return Object.freeze({
      ...result.data,
      ...(callbacks === undefined ? {} : { callbacks }),
      httpRequest: Object.freeze({
        allowedPrivateNetworks: parseAllowedPrivateNetworks(
          raw.HTTP_ALLOWED_PRIVATE_NETWORKS,
        ),
      }),
      codeRunner: {
        settings: parseCodeSettings(raw),
        socketPath: codeRunnerSocketPath({
          configured: raw.CODE_RUNNER_SOCKET,
          hardened: deployed,
          uid: process.getuid?.() ?? 'local',
        }),
        requireHardened: deployed,
      },
      ...(connectionEncryption === undefined ? {} : { connectionEncryption }),
      artifactStore,
      artifactScratchDirectory,
      retention: Object.freeze({
        maintenanceDatabase: parseMaintenanceDatabaseConfig(raw),
      }),
      ...(invitationDelivery === undefined ? {} : { invitationDelivery }),
      ...(systemMailDelivery === undefined ? {} : { systemMailDelivery }),
      database: Object.freeze(result.data.database),
      dispatcherDatabase: Object.freeze(result.data.dispatcherDatabase),
      workflowAutoPause: Object.freeze(result.data.workflowAutoPause),
      coordinator: Object.freeze(result.data.coordinator),
      nodeAttempt: Object.freeze(result.data.nodeAttempt),
      resourceSafety: Object.freeze(result.data.resourceSafety),
      triggerRuntime: Object.freeze(result.data.triggerRuntime),
      workspaceInbox: Object.freeze(result.data.workspaceInbox),
      outboxDispatcher: Object.freeze(result.data.outboxDispatcher),
    });
  } catch (error: unknown) {
    throw new Error('Invalid worker configuration', { cause: error });
  }
}
