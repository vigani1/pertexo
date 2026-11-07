import {
  StartupSettingError,
  parseStartupSettings,
} from '@pertexo/observability/startup';
import {
  parseCallbackKeyConfig,
  type CallbackKeyConfig,
} from '@pertexo/secrets/server';
import path from 'node:path';
import { parseCodeSettings, codeRunnerSocketPath } from '@pertexo/node-sdk';
import type { WorkerCodeRunnerConfig } from '../attempts/code/client.js';
import { z } from 'zod';
import {
  parseArtifactStoreConfig,
  type ArtifactStoreConfig,
} from '@pertexo/artifact-store/server';
import {
  parseMaintenanceDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import {
  parseConnectionEncryptionConfig,
  type ConnectionEnvelopeEncryptionConfig,
} from '@pertexo/secrets/server';
import {
  parseAllowedPrivateNetworks,
  type SecureHttpAddressPolicy,
} from '@pertexo/secrets/server';
import {
  parseSystemMailDeliveryConfig,
  type SystemMailDeliveryConfig,
} from './system-mail.js';
import {
  parseInvitationDeliveryConfig,
  type InvitationDeliveryConfig,
} from './invitation-delivery.js';
import { workerConfigSchema } from './worker-environment.schemas.js';

export type WorkerConfig = Readonly<
  z.output<typeof workerConfigSchema> & {
    publicWebOrigin?: string;
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
    throw new StartupSettingError('ARTIFACT_STORE_ENDPOINT', 'https_required');
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
      throw new StartupSettingError(
        'ARTIFACT_SCRATCH_DIRECTORY',
        'absolute_private_directory_required',
      );
    const invitationDelivery = parseInvitationDeliveryConfig(raw, {
      deployed: deployed,
    });
    const systemMailDelivery = parseSystemMailDeliveryConfig(raw, {
      deployed: deployed,
    });
    const publicWebOrigin = notificationPublicWebOrigin(raw, {
      deployed,
      enabled: connectionEncryption !== undefined,
      mail: systemMailDelivery,
      invitation: invitationDelivery,
    });
    if (deployed && connectionEncryption === undefined)
      throw new StartupSettingError(
        'CONNECTION_ENCRYPTION_MODE',
        'required_when_deployed',
      );
    return Object.freeze({
      ...result.data,
      ...(publicWebOrigin === undefined ? {} : { publicWebOrigin }),
      ...(callbacks === undefined ? {} : { callbacks }),
      httpRequest: Object.freeze({
        allowedPrivateNetworks: parseAllowedPrivateNetworks(
          raw.HTTP_ALLOWED_PRIVATE_NETWORKS,
        ),
      }),
      codeRunner: {
        settings: parseCodeSettings(raw),
        socketPath: workerCodeRunnerSocket(raw.CODE_RUNNER_SOCKET, deployed),
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

function workerCodeRunnerSocket(
  configured: string | undefined,
  hardened: boolean,
): string {
  const uid = process.getuid?.() ?? 'local';
  try {
    return codeRunnerSocketPath({ configured, hardened, uid });
  } catch (error) {
    throw new StartupSettingError(
      'CODE_RUNNER_SOCKET',
      'unix_socket_path_required',
      { cause: error },
    );
  }
}

function workerPublicWebOrigin(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): string | undefined {
  if (environment.PUBLIC_WEB_ORIGIN === undefined) return undefined;
  const { PUBLIC_WEB_ORIGIN } = parseStartupSettings(
    z.object({ PUBLIC_WEB_ORIGIN: z.url() }),
    environment,
    { PUBLIC_WEB_ORIGIN: 'http_origin_required' },
  );
  const url = new URL(PUBLIC_WEB_ORIGIN);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'http_origin_required');
  if (deployed && url.protocol !== 'https:')
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'https_required');
  return url.origin;
}

function notificationPublicWebOrigin(
  environment: Readonly<Record<string, string | undefined>>,
  options: Readonly<{
    deployed: boolean;
    enabled: boolean;
    mail: SystemMailDeliveryConfig | undefined;
    invitation: InvitationDeliveryConfig | undefined;
  }>,
): string | undefined {
  const origin =
    options.mail?.noticeSender?.publicWebOrigin ??
    options.invitation?.webOrigin ??
    workerPublicWebOrigin(environment, options.deployed);
  if (options.enabled && origin === undefined)
    throw new StartupSettingError('PUBLIC_WEB_ORIGIN', 'http_origin_required');
  return origin;
}
