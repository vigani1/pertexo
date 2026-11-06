import { execFileSync } from 'node:child_process';

export const docker = (args, { captureOutput = false, ...options } = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 120000,
    // Progress (pull/bootstrap/copy/restore) is unbounded; only IDs, ports and
    // fixture query/listing answers need capture, with an explicit small budget.
    stdio: captureOutput
      ? ['pipe', 'pipe', 'pipe']
      : ['pipe', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024,
    ...options,
  });
