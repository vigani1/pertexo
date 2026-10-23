import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { parseCodeSettings } from '@pertexo/node-sdk';
import { assertRunnerIsolation } from '../src/config.js';

const host = vi.hoisted(() => ({
  files: new Map<string, string>(),
  temp: { uid: 0, mode: 0o700 },
}));
vi.mock('node:fs/promises', () => ({
  readFile: (path: string) => {
    const contents = host.files.get(path);
    if (contents === undefined) throw new Error('Fixture file is missing');
    return Promise.resolve(contents);
  },
  stat: () => Promise.resolve(host.temp),
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const config = {
  settings: parseCodeSettings({}),
  mode: 'hardened' as const,
  socketPath: '/tmp/runner.sock',
};
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(process, 'getgid').mockReturnValue(10001);
  for (const name of Object.keys(process.env))
    if (
      /DATABASE|REDIS|AUTH|CONNECTION|AWS|SMTP|SECRET|TOKEN|ARTIFACT/u.test(
        name,
      )
    )
      vi.stubEnv(name, undefined);
  host.temp = { uid: 0, mode: 0o700 };
  host.files = new Map([
    ['/proc/self/status', 'NoNewPrivs:\t1\nCapEff:\t00000000000000e0\n'],
    ['/proc/net/dev', 'header\nheader\nlo: 0\ntun0: 0\n'],
    ['/sys/class/net/lo/flags', '0x9'],
    ['/sys/class/net/tun0/flags', '0x0'],
    [
      '/proc/self/mountinfo',
      '0 0 0 0 / ro - overlay\n0 0 0 0 /tmp rw,noexec - tmpfs\n',
    ],
    ['/sys/fs/cgroup/memory.max', String(4 * 1024 ** 3)],
    ['/sys/fs/cgroup/memory.oom.group', '0'],
    ['/proc/self/oom_score_adj', '-1000'],
    ['/sys/fs/cgroup/cpu.max', '1000 100000'],
    ['/sys/fs/cgroup/pids.max', '1'],
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  if (platform !== undefined)
    Object.defineProperty(process, 'platform', platform);
});

describe('hardened runner startup isolation', () => {
  it('accepts loopback and down tunnel interfaces with all kernel fences', async () => {
    await expect(assertRunnerIsolation(config)).resolves.toBeUndefined();
  });
  it('does not inspect the host in process mode', async () => {
    host.files.clear();
    await expect(
      assertRunnerIsolation({ ...config, mode: 'process' }),
    ).resolves.toBeUndefined();
  });
  it.each([
    ['/proc/self/status', 'NoNewPrivs:\t0\nCapEff:\te0\n', 'no-new-privileges'],
    ['/proc/self/status', 'NoNewPrivs:\t1\n', 'no-new-privileges'],
    ['/proc/self/status', 'NoNewPrivs:\t1\nCapEff:\te1\n', 'no-new-privileges'],
    ['/sys/class/net/tun0/flags', '0x1', 'network_mode: none'],
    [
      '/proc/net/dev',
      'header\nheader\ninvalid/name: 0\n',
      'Invalid network interface',
    ],
    [
      '/proc/self/mountinfo',
      '0 0 0 0 / rw\n0 0 0 0 /tmp rw,noexec',
      'read-only root',
    ],
    ['/proc/self/mountinfo', '0 0 0 0 / ro\n0 0 0 0 /tmp rw', 'read-only root'],
    ['/sys/fs/cgroup/memory.max', 'max', 'derived container bounds'],
    ['/sys/fs/cgroup/memory.max', '1', 'derived container bounds'],
    ['/sys/fs/cgroup/memory.oom.group', '1', 'derived container bounds'],
    ['/proc/self/oom_score_adj', '0', 'derived container bounds'],
    ['/sys/fs/cgroup/cpu.max', 'max 100000', 'derived container bounds'],
    ['/sys/fs/cgroup/cpu.max', '100000000 1', 'derived container bounds'],
    ['/sys/fs/cgroup/cpu.max', '1000', 'derived container bounds'],
    ['/sys/fs/cgroup/pids.max', 'max', 'derived container bounds'],
    ['/sys/fs/cgroup/pids.max', '1000000', 'derived container bounds'],
  ])('refuses a missing fence in %s: %s', async (path, value, message) => {
    host.files.set(path, value);
    await expect(assertRunnerIsolation(config)).rejects.toThrow(message);
  });
  it.each([
    { uid: 1, mode: 0o700 },
    { uid: 0, mode: 0o777 },
  ])('requires private manager-owned scratch: %j', async (temp) => {
    host.temp = temp;
    await expect(assertRunnerIsolation(config)).rejects.toThrow(
      'read-only root',
    );
  });
  it('refuses shared credentials before inspecting kernel files', async () => {
    vi.stubEnv('AUTH_SECRET', 'private-value');
    host.files.clear();
    await expect(assertRunnerIsolation(config)).rejects.toThrow(
      'shared credential environment',
    );
  });
  it('refuses the wrong manager identity before reading kernel files', async () => {
    vi.spyOn(process, 'getgid').mockReturnValue(0);
    host.files.clear();
    await expect(assertRunnerIsolation(config)).rejects.toThrow(
      'Linux manager identity',
    );
  });
  it('keeps network refusal ahead of filesystem refusal', async () => {
    host.files.set('/sys/class/net/tun0/flags', '0x1');
    host.files.set('/proc/self/mountinfo', '');
    await expect(assertRunnerIsolation(config)).rejects.toThrow(
      'network_mode: none',
    );
  });
});
