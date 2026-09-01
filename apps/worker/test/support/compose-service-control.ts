import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type ComposeService = 'postgres' | 'redis';
type ContainerStatus = 'created' | 'exited' | 'restarting' | 'running';
type ContainerHealth = 'healthy' | 'starting' | 'unhealthy' | null;

type ContainerState = Readonly<{
  exitCode: number;
  health: ContainerHealth;
  status: ContainerStatus;
}>;

type StoppedComposeService = Readonly<{
  containerId: string;
  service: ComposeService;
}>;

type ComposeServiceControllerDependencies = Readonly<{
  compose: (arguments_: readonly string[]) => Promise<string>;
  inspect: (containerId: string) => Promise<ContainerState>;
  now: () => number;
  pollIntervalMillis: number;
  startDeadlineMillis: number;
  wait: (millis: number) => Promise<void>;
}>;

const MAX_CLEAN_EXIT_START_ATTEMPTS = 2;

function oneContainerId(output: string, service: ComposeService): string {
  const ids = output
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const [containerId] = ids;
  if (containerId === undefined || ids.length !== 1)
    throw new Error(
      `Compose service ${service} must resolve to exactly one container`,
    );
  return containerId;
}

function isContainerStatus(value: unknown): value is ContainerStatus {
  return (
    typeof value === 'string' &&
    ['created', 'exited', 'restarting', 'running'].includes(value)
  );
}

function isContainerHealth(value: unknown): value is ContainerHealth {
  return (
    value === null ||
    (typeof value === 'string' &&
      ['healthy', 'starting', 'unhealthy'].includes(value))
  );
}

export function createComposeServiceController(
  dependencies: ComposeServiceControllerDependencies,
): Readonly<{
  start: (stopped: StoppedComposeService) => Promise<number>;
  stop: (service: ComposeService) => Promise<StoppedComposeService>;
}> {
  const currentContainerId = async (service: ComposeService): Promise<string> =>
    oneContainerId(
      await dependencies.compose(['ps', '--all', '--quiet', service]),
      service,
    );

  const assertSameContainer = async (
    stopped: StoppedComposeService,
  ): Promise<void> => {
    if ((await currentContainerId(stopped.service)) !== stopped.containerId)
      throw new Error(
        `Compose service ${stopped.service} changed container identity during recovery`,
      );
  };

  return Object.freeze({
    async stop(service) {
      const containerId = await currentContainerId(service);
      await dependencies.compose(['stop', '--timeout', '10', service]);
      const state = await dependencies.inspect(containerId);
      if (state.status !== 'exited' || state.exitCode !== 0)
        throw new Error(
          `Compose service ${service} did not reach the intended clean stopped state`,
        );
      return Object.freeze({ containerId, service });
    },

    async start(stopped) {
      const startedAt = dependencies.now();
      const deadline = startedAt + dependencies.startDeadlineMillis;
      for (
        let attempt = 1;
        attempt <= MAX_CLEAN_EXIT_START_ATTEMPTS;
        attempt += 1
      ) {
        await assertSameContainer(stopped);
        try {
          await dependencies.compose(['start', stopped.service]);
        } catch (error: unknown) {
          const state = await dependencies.inspect(stopped.containerId);
          if (
            state.status !== 'exited' ||
            state.exitCode !== 0 ||
            attempt === MAX_CLEAN_EXIT_START_ATTEMPTS
          )
            throw error;
        }

        while (dependencies.now() < deadline) {
          await assertSameContainer(stopped);
          const state = await dependencies.inspect(stopped.containerId);
          if (state.status === 'running' && state.health === 'healthy')
            return dependencies.now() - startedAt;
          if (state.health === 'unhealthy')
            throw new Error(
              `Compose service ${stopped.service} became unhealthy`,
            );
          if (state.status === 'exited') {
            if (
              state.exitCode === 0 &&
              attempt < MAX_CLEAN_EXIT_START_ATTEMPTS
            ) {
              await dependencies.wait(dependencies.pollIntervalMillis);
              break;
            }
            throw new Error(
              `Compose service ${stopped.service} exited unexpectedly with code ${String(state.exitCode)}`,
            );
          }
          await dependencies.wait(dependencies.pollIntervalMillis);
        }
      }
      throw new Error(
        `Compose service ${stopped.service} did not become healthy before its recovery deadline`,
      );
    },
  });
}

export function createDockerComposeServiceController(options: {
  readonly cwd: string;
  readonly operationTimeoutMillis: number;
}): ReturnType<typeof createComposeServiceController> {
  const run = async (
    executable: string,
    arguments_: readonly string[],
  ): Promise<string> => {
    const result = await execFileAsync(executable, arguments_, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.operationTimeoutMillis,
    });
    return result.stdout.trim();
  };
  return createComposeServiceController({
    compose: (arguments_) => run('docker', ['compose', ...arguments_]),
    inspect: async (containerId) => {
      const raw = await run('docker', [
        'inspect',
        '--format',
        '{{json .State}}',
        containerId,
      ]);
      const parsed = JSON.parse(raw) as {
        ExitCode?: unknown;
        Health?: { Status?: unknown };
        Status?: unknown;
      };
      const status = parsed.Status;
      const exitCode = parsed.ExitCode;
      const health = parsed.Health?.Status ?? null;
      if (
        !isContainerStatus(status) ||
        typeof exitCode !== 'number' ||
        !isContainerHealth(health)
      )
        throw new Error('Docker returned an invalid Compose container state');
      return {
        exitCode,
        health,
        status,
      };
    },
    now: () => performance.now(),
    pollIntervalMillis: 250,
    startDeadlineMillis: options.operationTimeoutMillis,
    wait: (millis) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, millis);
      }),
  });
}
