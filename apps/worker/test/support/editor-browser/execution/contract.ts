import type { CallbackKeyConfig } from '@pertexo/integrations/server';

import type { createArtifactDestination } from '../../../attempts/artifacts/http-destination.js';

import type { parseDatabaseConfig } from '@pertexo/database/testing';

import type { createWorkerNodeRuntimeCapabilities } from '../../../../src/attempts/execution/runtime-capabilities.js';

import type { createCuratedTemplateQualificationTransports } from '../../curated-templates/controlled-transports.js';

import type { createEditorControlledHttpTarget } from '../controlled-http.js';

import type {
  createEditorResendMailbox,
  DeliveredEmail,
} from '../notifications/resend-mailbox.js';

import type { createRedisTestNamespace } from '../../infrastructure/redis-test-namespace.js';

import type { EditorBrowserRuntimeConstruction } from '../lifetime.js';

export interface EditorBrowserWorkerConfiguration {
  workerUrl: string;
  dispatcherUrl: string;
  apiUrl: string;
  migrationUrl: string;
  connectionMasterKey?: string;
  authorizationValue?: string;
  callbackConfig?: CallbackKeyConfig;
}

export interface EditorBrowserWorkerState {
  configuration: EditorBrowserWorkerConfiguration | undefined;
  cancelConfiguration: (() => void) | undefined;
  artifactTarget:
    Awaited<ReturnType<typeof createArtifactDestination>> | undefined;
  curatedTarget:
    ReturnType<typeof createCuratedTemplateQualificationTransports> | undefined;
  httpTarget: ReturnType<typeof createEditorControlledHttpTarget> | undefined;
  resendMailbox: ReturnType<typeof createEditorResendMailbox> | undefined;
}

export type EditorWorkerCapabilities = Awaited<
  ReturnType<typeof createWorkerNodeRuntimeCapabilities>
>;

export type EditorWorkerHttpClient = ReturnType<
  typeof createEditorControlledHttpTarget
>['httpClient'];

export type EditorWorkerSetup = Readonly<{
  state: EditorBrowserWorkerState;
  namespace: ReturnType<typeof createRedisTestNamespace>;
  resources: EditorBrowserRuntimeConstruction;
  assertSetupActive: () => void;
}>;

export type EditorWorkerExecution = EditorWorkerSetup &
  Readonly<{
    raw: EditorBrowserWorkerConfiguration;
    database: ReturnType<typeof parseDatabaseConfig>;
    sendHttpEffects: () => void;
    sendEmailDeliveries: (emails: readonly DeliveredEmail[]) => void;
  }>;

export type EditorWorkerAttemptContext = Readonly<{
  controlledCapabilities: EditorWorkerCapabilities | undefined;
  controlledHttpClient: EditorWorkerHttpClient | undefined;
  state: EditorBrowserWorkerState;
}>;
