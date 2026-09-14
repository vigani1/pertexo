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

    expect(compose.mock.calls.map(([arguments_]) => [arguments_])).toEqual([
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

  it('does not admit another start after a clean-exit retry consumes the deadline', async () => {
    let now = 0;
    const composeCalls: string[][] = [];
    const compose = vi.fn((arguments_: readonly string[]) => {
      composeCalls.push([...arguments_]);
      return Promise.resolve(
        arguments_[0] === 'ps' ? 'postgres-container' : '',
      );
    });
    const controller = createComposeServiceController({
      compose,
      inspect: vi.fn().mockResolvedValue({
        exitCode: 0,
        health: null,
        status: 'exited',
      }),
      now: () => now,
      pollIntervalMillis: 10,
      startDeadlineMillis: 10,
      wait: (millis) => {
        now += millis;
        return Promise.resolve();
      },
    });

    await expect(
      controller.start({
        containerId: 'postgres-container',
        service: 'postgres',
      }),
    ).rejects.toThrow(/recovery deadline/u);
    expect(
      composeCalls.filter((arguments_) => arguments_[0] === 'start'),
    ).toHaveLength(1);
  });

  it('passes the shrinking recovery budget to every admitted command', async () => {
    let now = 0;
    const timeouts: number[] = [];
    const compose = vi.fn(
      (arguments_: readonly string[], timeoutMillis?: number) => {
        if (timeoutMillis !== undefined) timeouts.push(timeoutMillis);
        now += 2;
        return Promise.resolve(arguments_[0] === 'ps' ? 'redis-container' : '');
      },
    );
    const controller = createComposeServiceController({
      compose,
      inspect: (_containerId, timeoutMillis) => {
        if (timeoutMillis !== undefined) timeouts.push(timeoutMillis);
        now += 2;
        return Promise.resolve({
          exitCode: 0,
          health: 'healthy' as const,
          status: 'running' as const,
        });
      },
      now: () => now,
      pollIntervalMillis: 10,
      startDeadlineMillis: 20,
      wait: () => Promise.resolve(),
    });

    await expect(
      controller.start({ containerId: 'redis-container', service: 'redis' }),
    ).resolves.toBe(8);
    expect(timeouts).toEqual([20, 18, 16, 14]);
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
