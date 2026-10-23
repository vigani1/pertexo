import {
  parseCodeSettings,
  codeRunnerSocketPath,
  codeContainerLimits,
  type CodeSettings,
} from '@pertexo/node-sdk';
import { readFile, stat } from 'node:fs/promises';

export type RunnerConfig = Readonly<{
  settings: CodeSettings;
  mode: 'hardened' | 'process';
  socketPath: string;
}>;
export function parseRunnerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RunnerConfig {
  const deployed =
    environment.NODE_ENV === 'production' || environment.NODE_ENV === 'staging';
  const mode =
    environment.CODE_RUNNER_MODE ?? (deployed ? 'hardened' : 'process');
  const invalidRunnerMode =
    (mode !== 'hardened' && mode !== 'process') ||
    (deployed && mode !== 'hardened');
  if (invalidRunnerMode)
    throw new Error('Deployed Code runners require hardened mode');
  const socketPath = codeRunnerSocketPath({
    configured: environment.CODE_RUNNER_SOCKET,
    hardened: mode === 'hardened',
    uid: process.getuid?.() ?? 'local',
  });
  return Object.freeze({
    settings: parseCodeSettings(environment),
    mode,
    socketPath,
  });
}
export async function assertRunnerIsolation(
  config: RunnerConfig,
): Promise<void> {
  if (config.mode === 'process') return;
  assertManagerEnvironment();
  const [
    status,
    interfaces,
    mounts,
    maximum,
    oomGroup,
    score,
    temp,
    cpu,
    pids,
  ] = await Promise.all([
    readFile('/proc/self/status', 'utf8'),
    readFile('/proc/net/dev', 'utf8'),
    readFile('/proc/self/mountinfo', 'utf8'),
    readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    readFile('/sys/fs/cgroup/memory.oom.group', 'utf8'),
    readFile('/proc/self/oom_score_adj', 'utf8'),
    stat('/tmp'),
    readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
    readFile('/sys/fs/cgroup/pids.max', 'utf8'),
  ]);
  assertManagerPrivileges(status);
  await assertNetworkIsolation(interfaces);
  assertFilesystemIsolation(mounts, temp);
  assertContainerBounds(config, { maximum, oomGroup, score, cpu, pids });
}

function assertManagerEnvironment(): void {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== 0 ||
    process.getgid?.() !== 10001
  )
    throw new Error('Hardened Code runner requires its Linux manager identity');
  for (const name of Object.keys(process.env))
    if (
      /DATABASE|REDIS|AUTH|CONNECTION|AWS|SMTP|SECRET|TOKEN|ARTIFACT/u.test(
        name,
      )
    )
      throw new Error('Code runner refuses shared credential environment');
}

function assertManagerPrivileges(status: string): void {
  const capabilities = /^CapEff:\s*(\w+)$/mu.exec(status)?.[1];
  if (
    !/^NoNewPrivs:\s*1$/mu.test(status) ||
    capabilities === undefined ||
    BigInt('0x' + capabilities) !== 224n
  )
    throw new Error(
      'Code runner requires no-new-privileges and only SETUID, SETGID, KILL',
    );
}

async function assertNetworkIsolation(interfaces: string): Promise<void> {
  // Docker Desktop can expose DOWN kernel tunnel devices even with network:none.
  // A runnable non-loopback interface is forbidden; tasks additionally cannot
  // create any socket under the launcher's inherited syscall filter.
  for (const line of interfaces.split('\n').slice(2)) {
    if (!line.includes(':')) continue;
    const name = line.split(':')[0]?.trim();
    if (name === undefined || !/^[a-zA-Z0-9_.-]+$/u.test(name))
      throw new Error('Invalid network interface');
    const flags = Number(
      (await readFile(`/sys/class/net/${name}/flags`, 'utf8')).trim(),
    );
    if ((flags & 1) !== 0 && (flags & 8) === 0)
      throw new Error('Code runner requires network_mode: none');
  }
}

function assertFilesystemIsolation(
  mounts: string,
  temp: Readonly<{ uid: number; mode: number }>,
): void {
  const root = mounts.split('\n').find((line) => line.split(' ')[4] === '/');
  const temporary = mounts
    .split('\n')
    .find((line) => line.split(' ')[4] === '/tmp');
  const unsafeFilesystemIsolation =
    !root?.split(' ')[5]?.split(',').includes('ro') ||
    !temporary?.split(' ')[5]?.split(',').includes('noexec') ||
    temp.uid !== 0 ||
    (temp.mode & 0o777) !== 0o700;
  if (unsafeFilesystemIsolation)
    throw new Error(
      'Code runner requires a read-only root and private noexec tmpfs',
    );
}

function assertContainerBounds(
  config: RunnerConfig,
  {
    maximum,
    oomGroup,
    score,
    cpu,
    pids,
  }: Readonly<{
    maximum: string;
    oomGroup: string;
    score: string;
    cpu: string;
    pids: string;
  }>,
): void {
  const limits = codeContainerLimits(config.settings);
  const [quota, period] = cpu.trim().split(/\s+/u).map(Number);
  const unsafeProcessLimits =
    quota === undefined ||
    period === undefined ||
    !Number.isFinite(quota) ||
    quota / period > limits.cpus ||
    !Number.isFinite(Number(pids.trim())) ||
    Number(pids.trim()) > limits.pids ||
    maximum.trim() === 'max' ||
    Number(maximum) <
      codeContainerLimits(config.settings).memoryMiB * 1_048_576 ||
    oomGroup.trim() !== '0' ||
    score.trim() !== '-1000';
  if (unsafeProcessLimits)
    throw new Error(
      'Code runner requires derived container bounds and manager OOM protection',
    );
}
