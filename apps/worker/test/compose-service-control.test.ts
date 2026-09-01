import { describe, expect, it, vi } from 'vitest';

import { createComposeServiceController } from './support/compose-service-control.js';

describe('Compose service control', () => {
  it('retries the documented clean-exit transition and waits for the original container to become healthy', async () => {
    let now = 0;
    const compose = vi
      .fn<(arguments_: readonly string[]) => Promise<string>>()
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('postgres-container');
    const inspect = vi
      .fn<
        (containerId: string) => Promise<{
          exitCode: number;
          health: 'healthy' | 'starting' | 'unhealthy' | null;
          status: 'created' | 'exited' | 'restarting' | 'running';
        }>
      >()
      .mockResolvedValueOnce({
        exitCode: 0,
        health: null,
        status: 'exited',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        health: null,
        status: 'exited',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        health: 'starting',
        status: 'running',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        health: 'healthy',
        status: 'running',
      });
    const controller = createComposeServiceController({
      compose,
      inspect,
      now: () => now,
      pollIntervalMillis: 10,
      startDeadlineMillis: 100,
      wait: (millis) => {
        now += millis;
        return Promise.resolve();
      },
    });

    const stopped = await controller.stop('postgres');
    await expect(controller.start(stopped)).resolves.toBe(20);

    expect(compose.mock.calls).toEqual([
      [['ps', '--all', '--quiet', 'postgres']],
      [['stop', '--timeout', '10', 'postgres']],
      [['ps', '--all', '--quiet', 'postgres']],
      [['start', 'postgres']],
      [['ps', '--all', '--quiet', 'postgres']],
      [['ps', '--all', '--quiet', 'postgres']],
      [['start', 'postgres']],
      [['ps', '--all', '--quiet', 'postgres']],
      [['ps', '--all', '--quiet', 'postgres']],
    ]);
  });

  it('fails a genuinely unhealthy service without retrying it', async () => {
    const compose = vi
      .fn<(arguments_: readonly string[]) => Promise<string>>()
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('postgres-container')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('postgres-container');
    const inspect = vi
      .fn<
        (containerId: string) => Promise<{
          exitCode: number;
          health: 'healthy' | 'starting' | 'unhealthy' | null;
          status: 'created' | 'exited' | 'restarting' | 'running';
        }>
      >()
      .mockResolvedValueOnce({
        exitCode: 0,
        health: null,
        status: 'exited',
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        health: 'unhealthy',
        status: 'running',
      });
    const controller = createComposeServiceController({
      compose,
      inspect,
      now: () => 0,
      pollIntervalMillis: 10,
      startDeadlineMillis: 100,
      wait: () => Promise.resolve(),
    });

    const stopped = await controller.stop('postgres');
    await expect(controller.start(stopped)).rejects.toThrow(
      'Compose service postgres became unhealthy',
    );
    expect(compose).toHaveBeenCalledTimes(5);
  });
});
