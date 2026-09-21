import {
  ACTIVE_QUEUE_JOB_NAMES,
  JOB_NAME,
  type QueueConsumer,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createDispatchConsumerCapabilityRegistry,
  DispatchConsumerCapabilityError,
} from '../src/transport/dispatch-consumer-capabilities.js';
import { parseWorkerConfig } from '../src/config/worker-config.js';
import type { CoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import type { TriggerRuntime } from '../src/triggers/trigger-runtime.js';
import { dispatchCapabilitiesProvider } from '../src/transport/dispatch-providers.js';

function consumer(
  isReady: () => boolean = () => true,
  waitUntilReady: () => Promise<void> = () => Promise.resolve(),
) {
  return { isReady, waitUntilReady } as Pick<
    QueueConsumer,
    'isReady' | 'waitUntilReady'
  >;
}

describe('dispatch consumer capability registry', () => {
  it('supports an empty registry and exact empty selection', async () => {
    const registry = createDispatchConsumerCapabilityRegistry([]);

    expect(registry.readyJobNames()).toEqual([]);
    await expect(registry.assertReady([])).resolves.toBeUndefined();
  });

  it('rejects duplicate, invalid, and incomplete capability input', () => {
    const selected = consumer();
    expect(() =>
      createDispatchConsumerCapabilityRegistry([
        { consumer: selected, jobName: JOB_NAME.advanceWorkflowRun },
        { consumer: selected, jobName: JOB_NAME.advanceWorkflowRun },
      ]),
    ).toThrow();
    expect(() =>
      createDispatchConsumerCapabilityRegistry([
        { consumer: selected, jobName: 'unknown-job' },
      ] as never),
    ).toThrow();
    expect(() =>
      createDispatchConsumerCapabilityRegistry([
        { jobName: JOB_NAME.advanceWorkflowRun },
      ] as never),
    ).toThrow('incomplete');
  });

  it('reports the exact absent consumer without waiting another capability', async () => {
    const waitUntilReady = vi.fn().mockResolvedValue(undefined);
    const registry = createDispatchConsumerCapabilityRegistry([
      {
        consumer: consumer(() => true, waitUntilReady),
        jobName: JOB_NAME.advanceWorkflowRun,
      },
    ]);

    const failure = await registry
      .assertReady([JOB_NAME.reconcileWorkflowTriggers])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DispatchConsumerCapabilityError);
    expect((failure as Error).message).toContain(
      JOB_NAME.reconcileWorkflowTriggers,
    );
    expect(waitUntilReady).not.toHaveBeenCalled();
  });

  it('preserves a consumer wait rejection exactly', async () => {
    const waitFailure = new Error('consumer startup failed');
    const registry = createDispatchConsumerCapabilityRegistry([
      {
        consumer: consumer(
          () => true,
          () => Promise.reject(waitFailure),
        ),
        jobName: JOB_NAME.advanceWorkflowRun,
      },
    ]);

    await expect(
      registry.assertReady([JOB_NAME.advanceWorkflowRun]),
    ).rejects.toBe(waitFailure);
  });

  it('rechecks readiness after waiting and reports the capability that became unready', async () => {
    let ready = true;
    const registry = createDispatchConsumerCapabilityRegistry([
      {
        consumer: consumer(
          () => ready,
          () => {
            ready = false;
            return Promise.resolve();
          },
        ),
        jobName: JOB_NAME.advanceWorkflowRun,
      },
    ]);

    await expect(
      registry.assertReady([JOB_NAME.advanceWorkflowRun]),
    ).rejects.toThrow(JOB_NAME.advanceWorkflowRun);
    expect(registry.readyJobNames()).toEqual([]);
  });

  it('returns only the exact ready subset in configured order', () => {
    const registry = createDispatchConsumerCapabilityRegistry([
      {
        consumer: consumer(() => false),
        jobName: JOB_NAME.reconcileWorkflowTriggers,
      },
      {
        consumer: consumer(() => true),
        jobName: JOB_NAME.advanceWorkflowRun,
      },
      {
        consumer: consumer(() => true),
        jobName: JOB_NAME.executeNodeAttempt,
      },
    ]);

    expect(registry.readyJobNames()).toEqual([
      JOB_NAME.advanceWorkflowRun,
      JOB_NAME.executeNodeAttempt,
    ]);
  });

  it('allows one shared consumer to serve multiple named capabilities', async () => {
    const waitUntilReady = vi.fn().mockResolvedValue(undefined);
    const shared = consumer(() => true, waitUntilReady);
    const registry = createDispatchConsumerCapabilityRegistry([
      { consumer: shared, jobName: JOB_NAME.reconcilePreviewAttempt },
      { consumer: shared, jobName: JOB_NAME.reconcileUnknownOutcome },
    ]);

    await expect(
      registry.assertReady([
        JOB_NAME.reconcilePreviewAttempt,
        JOB_NAME.reconcileUnknownOutcome,
      ]),
    ).resolves.toBeUndefined();
    expect(waitUntilReady).toHaveBeenCalledTimes(2);
  });
});

describe('dispatch capability provider activation', () => {
  it('maps every active job to its intended composed consumer', () => {
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      OUTBOX_DISPATCH_JOB_NAMES: ACTIVE_QUEUE_JOB_NAMES.join(','),
      REDIS_URL: 'redis://localhost:6379/0',
      INVITATION_EMAIL_API_KEY: 're_test',
      INVITATION_EMAIL_FROM: 'invites@example.test',
      INVITATION_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64'),
      INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
      PUBLIC_WEB_ORIGIN: 'http://localhost:5173',
    });
    const coordinatorConsumer = consumer() as QueueConsumer;
    const attemptConsumer = consumer() as QueueConsumer;
    const maintenanceConsumer = consumer() as QueueConsumer;
    const triggerConsumer = consumer() as QueueConsumer;
    const provider = dispatchCapabilitiesProvider(config, {}) as {
      useFactory(
        coordinator: CoordinatorRuntime,
        attempt: NodeAttemptRuntime,
        maintenance: PreviewMaintenanceRuntime,
        trigger: TriggerRuntime,
      ): ReturnType<typeof createDispatchConsumerCapabilityRegistry>;
    };

    const registry = provider.useFactory(
      { consumer: coordinatorConsumer } as CoordinatorRuntime,
      { consumer: attemptConsumer } as NodeAttemptRuntime,
      { consumer: maintenanceConsumer } as PreviewMaintenanceRuntime,
      { consumer: triggerConsumer } as TriggerRuntime,
    );

    expect(registry.readyJobNames()).toEqual(ACTIVE_QUEUE_JOB_NAMES);
  });

  it('returns an explicit registry override without inspecting runtime inputs', () => {
    const override = createDispatchConsumerCapabilityRegistry([]);
    const config = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      REDIS_URL: 'redis://localhost:6379/0',
    });
    const provider = dispatchCapabilitiesProvider(config, {
      dispatchConsumerCapabilities: override,
    }) as {
      useFactory(
        coordinator: undefined,
        attempt: undefined,
        maintenance: undefined,
        trigger: undefined,
      ): ReturnType<typeof createDispatchConsumerCapabilityRegistry>;
    };

    expect(
      provider.useFactory(undefined, undefined, undefined, undefined),
    ).toBe(override);
  });
});
