import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type { TelemetryLifecycle } from '@pertexo/observability';
import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import { ApiDrainState } from '../../../src/platform/health/drain-state.js';

import { createStubApiWorkflowRuntime } from '../../support/api-platform.fixture.js';
import {
  config,
  database,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerEntersDrainStateBeforeShutdownResources(): void {
  it('enters drain state before shutdown resources close', async () => {
    const lifecycle: { drainState?: ApiDrainState } = {};
    const close = vi.fn().mockImplementation(() => {
      expect(lifecycle.drainState?.isDraining()).toBe(true);
      return Promise.resolve();
    });
    const selectedDatabase: WorkspaceDatabase = { ...database, close };
    const selectedApplication = await createTestApiApplication(
      config,
      dependencies(selectedDatabase),
    );
    lifecycle.drainState = selectedApplication.get(ApiDrainState);
    applicationFixture.application = selectedApplication;
    await applicationFixture.application.close();
    applicationFixture.application = undefined;

    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['first', ['telemetry']],
    ['middle', ['workflow']],
    ['last', ['database']],
    ['multiple', ['telemetry', 'identity', 'database']],
  ] as const)(
    'attempts every resource and releases signal listeners when the %s closer fails',
    async (_position, failingLabels) => {
      const baselineSignalListeners = process.listenerCount('SIGTERM');
      const events: string[] = [];
      const failures = new Map<string, Error>(
        failingLabels.map((label) => [
          label,
          new Error(`${label} close failed`),
        ]),
      );
      const lifecycle: {
        application?: Awaited<ReturnType<typeof createTestApiApplication>>;
        drain?: ApiDrainState;
      } = {};
      const closeOwner = (label: string) =>
        vi.fn((): Promise<void> => {
          expect(lifecycle.drain?.isDraining()).toBe(true);
          expect(lifecycle.application?.getHttpServer().listening).toBe(false);
          events.push(label);
          const failure = failures.get(label);
          if (failure !== undefined) return Promise.reject(failure);
          return Promise.resolve();
        });
      const databaseClose = closeOwner('database');
      const identityClose = closeOwner('identity');
      const workflowClose = closeOwner('workflow');
      const telemetryClose = closeOwner('telemetry');
      const selectedDatabase: WorkspaceDatabase = {
        ...database,
        close: databaseClose,
      };
      const selectedIdentity = identityRuntime(identityClose);
      const selectedWorkflow = createStubApiWorkflowRuntime(
        selectedIdentity.dependencies.authorization,
        workflowClose,
      );
      const selectedTelemetry: TelemetryLifecycle = {
        enabled: true,
        started: true,
        start: vi.fn(),
        shutdown: telemetryClose,
      };
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(selectedDatabase, selectedTelemetry),
        identityRuntime: selectedIdentity,
        workflowRuntime: selectedWorkflow,
      });
      lifecycle.application = applicationFixture.application;
      lifecycle.drain = applicationFixture.application.get(ApiDrainState);
      await applicationFixture.application.listen({
        host: '127.0.0.1',
        port: 0,
      });

      const result = await applicationFixture.application
        .close()
        .catch((error: unknown) => error);
      applicationFixture.application = undefined;

      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual(
        events.flatMap((label) => {
          const failure = failures.get(label);
          return failure === undefined ? [] : [failure];
        }),
      );
      expect(events).toEqual(['telemetry', 'workflow', 'identity', 'database']);
      expect(databaseClose).toHaveBeenCalledOnce();
      expect(identityClose).toHaveBeenCalledOnce();
      expect(workflowClose).toHaveBeenCalledOnce();
      expect(telemetryClose).toHaveBeenCalledOnce();
      expect(process.listenerCount('SIGTERM')).toBe(baselineSignalListeners);
    },
  );

  it('shuts telemetry down with the Nest application lifecycle', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const selectedTelemetry: TelemetryLifecycle = {
      enabled: true,
      started: true,
      start: vi.fn(),
      shutdown,
    };
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(database, selectedTelemetry),
    );
    await applicationFixture.application.init();
    await applicationFixture.application.close();
    applicationFixture.application = undefined;

    expect(shutdown).toHaveBeenCalledOnce();
  });
}
