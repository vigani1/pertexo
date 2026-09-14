import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerProcessShutdown } from '../src/runtime/worker-process-shutdown.js';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

const originalExitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  logger.error.mockReset();
});

describe('worker process shutdown', () => {
  it('rolls back SIGINT when SIGTERM listener installation fails', () => {
    const installFailure = new Error('SIGTERM install failed');
    const once = vi.spyOn(process, 'once').mockImplementation((event) => {
      if (event === 'SIGTERM') throw installFailure;
      return process;
    });
    const removeListener = vi
      .spyOn(process, 'removeListener')
      .mockImplementation((() => process) as typeof process.removeListener);
    const shutdown = new WorkerProcessShutdown(
      { close: vi.fn().mockResolvedValue(undefined) },
      logger,
    );

    expect(() => {
      shutdown.install();
    }).toThrow(installFailure);
    expect(once).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('installs once, coalesces signals, and removes both listeners after close', async () => {
    const listeners = new Map<string, () => void>();
    const once = vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: () => void,
    ) => {
      listeners.set(event, listener);
      return process;
    }) as typeof process.once);
    const removeListener = vi
      .spyOn(process, 'removeListener')
      .mockImplementation((() => process) as typeof process.removeListener);
    const deferred = Promise.withResolvers<undefined>();
    const application = { close: vi.fn(() => deferred.promise) };
    const shutdown = new WorkerProcessShutdown(application, logger);

    shutdown.install();
    shutdown.install();
    listeners.get('SIGINT')?.();
    listeners.get('SIGTERM')?.();

    expect(once).toHaveBeenCalledTimes(2);
    expect(application.close).toHaveBeenCalledOnce();
    expect(application.close).toHaveBeenCalledWith('SIGINT');

    deferred.resolve(undefined);
    await shutdown.close('SIGTERM');

    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(removeListener.mock.calls.map(([event]) => event)).toEqual([
      'SIGINT',
      'SIGTERM',
    ]);
  });

  it('reports a close failure, sets the exit code, and remains idempotent', async () => {
    const failure = new Error('close failed');
    const application = { close: vi.fn().mockRejectedValue(failure) };
    const shutdown = new WorkerProcessShutdown(application, logger);

    await expect(shutdown.close('SIGTERM')).resolves.toBeUndefined();
    await expect(shutdown.close('SIGINT')).resolves.toBeUndefined();

    expect(application.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'worker.shutdown_failed',
      { signal: 'SIGTERM' },
      failure,
    );
  });

  it('closes startup rollback without inventing an operating-system signal', async () => {
    const application = { close: vi.fn().mockResolvedValue(undefined) };
    const shutdown = new WorkerProcessShutdown(application, logger);

    const firstClose = shutdown.close();
    const secondClose = shutdown.close('SIGTERM');

    expect(firstClose).toBe(secondClose);
    await firstClose;
    expect(application.close).toHaveBeenCalledOnce();
    expect(application.close).toHaveBeenCalledWith(undefined);
  });

  it('contains synchronous close and diagnostic failures while uninstalling listeners', async () => {
    const listeners = new Map<string, () => void>();
    vi.spyOn(process, 'once').mockImplementation(((event, listener) => {
      listeners.set(String(event), listener as () => void);
      return process;
    }) as typeof process.once);
    const removeListener = vi
      .spyOn(process, 'removeListener')
      .mockImplementation((() => process) as typeof process.removeListener);
    const closeFailure = new Error('synchronous close failed');
    const diagnosticFailure = new Error('shutdown diagnostic failed');
    const application = {
      close: vi.fn(() => {
        throw closeFailure;
      }),
    };
    logger.error.mockImplementationOnce(() => {
      throw diagnosticFailure;
    });
    const shutdown = new WorkerProcessShutdown(application, logger);
    shutdown.install();

    listeners.get('SIGINT')?.();
    await expect(shutdown.close('SIGTERM')).resolves.toBeUndefined();

    expect(application.close).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'worker.shutdown_failed',
      { signal: 'SIGINT' },
      closeFailure,
    );
    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });
});
