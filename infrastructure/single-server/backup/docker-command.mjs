import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captureLimit = 64 * 1024;

export function docker(
  args,
  { captureOutput = false, encoding = 'utf8', stdio, ...options } = {},
) {
  const channels = stdio ?? [
    'pipe',
    captureOutput ? 'pipe' : 'inherit',
    captureOutput ? 'pipe' : 'inherit',
  ];
  const captures = new Map();
  let directory;
  try {
    // A synchronous child must never pipe unbounded output into spawnSync.
    const childStdio = (
      Array.isArray(channels) ? channels : Array(3).fill(channels)
    ).map((channel, index) => {
      if (index === 0 || (channel !== 'pipe' && channel != null))
        return channel;
      directory ??= mkdtempSync(join(tmpdir(), 'pertexo-docker-output-'));
      const fd = openSync(join(directory, String(index)), 'w+', 0o600);
      captures.set(index, fd);
      return fd;
    });
    let result;
    try {
      result = execFileSync('docker', args, {
        timeout: 120000,
        ...options,
        encoding,
        stdio: childStdio,
      });
    } catch (error) {
      const stderr = captures.get(2);
      if (stderr !== undefined && error instanceof Error) {
        error.stderr = readDockerOutput(stderr, encoding, true);
        if (error.stderr.length > 0) error.message += `\n${error.stderr}`;
      }
      throw error;
    }
    const stdout = captures.get(1);
    return stdout === undefined ? result : readDockerOutput(stdout, encoding);
  } finally {
    for (const fd of captures.values()) closeSync(fd);
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
}

function readDockerOutput(fd, encoding, diagnostic = false) {
  const size = fstatSync(fd).size;
  if (size > captureLimit && !diagnostic)
    throw Object.assign(
      new Error(
        `Docker stdout exceeded the ${captureLimit}-byte capture limit. Use a streamed output file for larger results.`,
      ),
      { code: 'DOCKER_OUTPUT_LIMIT' },
    );
  const bytes = Buffer.alloc(Math.min(size, captureLimit));
  const read = readSync(
    fd,
    bytes,
    0,
    bytes.length,
    Math.max(0, size - bytes.length),
  );
  let output = bytes.subarray(0, read);
  if (size > captureLimit)
    output = Buffer.concat([
      Buffer.from(`[stderr truncated; showing last ${captureLimit} bytes]\n`),
      output,
    ]);
  return encoding === null || encoding === 'buffer'
    ? output
    : output.toString(encoding);
}
