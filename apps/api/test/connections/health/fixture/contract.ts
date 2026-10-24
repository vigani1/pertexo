import type { ChildProcess } from 'node:child_process';

import type { ServerResponse } from 'node:http';

import type { z } from 'zod';
import type { connectionResponseSchema } from '@pertexo/contracts';

import type { useBetterAuthRealApi } from '../../../support/better-auth/real-api.support.js';
import type { Browser } from '../../../support/better-auth/real-api.support.js';

export type ConnectionHealthFixtureOptions = Readonly<{
  webOrigin?: string;
  abandonPublicationBeforeRestart?: boolean;
  beforeClose?: () => Promise<void>;
  browserLifetime?: (path: string, instanceId: string) => void;
}>;

export interface ConnectionHealthFixtureState {
  worker: ChildProcess;
  browser: Browser;
  workspaceId: string;
  connectionId: string;
  workflowId: string;
  actorId: string;
  staleRun: string;
  rotationRun: string;
  sends: number;
  nextResponse: 'hold' | 'reject' | 'healthy';
  commandStage: string;
}

export type ConnectionHealthApi = ReturnType<typeof useBetterAuthRealApi>;

export interface ConnectionHealthCommandContext {
  api: ConnectionHealthApi;
  state: ConnectionHealthFixtureState;
  options: ConnectionHealthFixtureOptions;
  scope: AbortController;
  held: Set<ServerResponse>;
  wait: <T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean,
    timeoutMillis?: number,
  ) => Promise<T>;
  readConnection: () => Promise<z.output<typeof connectionResponseSchema>>;
  readRun: (runId: string) => Promise<string>;
  startRun: () => Promise<string>;
  completeHeld: (runId: string) => Promise<void>;
}
