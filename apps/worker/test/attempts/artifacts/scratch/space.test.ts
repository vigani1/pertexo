import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactScratchSpace } from '../../../../src/attempts/artifacts/scratch/space.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-scratch-test-'));
  roots.push(directory);
  return { directory, space: await ArtifactScratchSpace.create(directory) };
}
function input(
  maxBytes = 10_485_760,
  attemptId = 'attempt',
  body = Readable.from([Buffer.from('test')]),
) {
  return { maxBytes, attemptId, body, signal: new AbortController().signal };
}
async function bytes(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

it('spools private bytes, hashes through EOF, reopens exact bytes and releases everything', async () => {
  const { directory, space } = await fixture();
  const original = Buffer.from('test');
  const body = Buffer.from(original);
  const file = await space.spool(input(4, 'attempt', Readable.from([body])));
  expect(file.byteLength).toBe(4);
  expect(file.sha256).toBe(createHash('sha256').update(original).digest('hex'));
  expect(body.every((byte) => byte === 0)).toBe(true);
  const [name] = await readdir(directory);
  const folder = path.join(directory, name ?? 'missing');
  expect((await lstat(folder)).mode & 0o777).toBe(0o700);
  expect((await lstat(path.join(folder, 'body'))).mode & 0o777).toBe(0o600);
  expect(await bytes(file.open())).toEqual(original);
  expect(await bytes(file.open())).toEqual(original);
  await Promise.all([file.release(), file.release()]);
  expect(await readdir(directory)).toEqual([]);
  expect(() => file.open()).toThrow();
});

it('limits all live spools belonging to one attempt and returns successful cleanup charges', async () => {
  const { space } = await fixture();
  const first = await space.spool(input());
  const second = await space.spool(input());
  await expect(space.spool(input(1))).rejects.toMatchObject({
    safeErrorCode: 'execution.file_scratch_full',
  });
  await first.release();
  const next = await space.spool(input());
  await next.release();
  await second.release();
});

it('caps aggregate worker reservations independently of attempt identity', async () => {
  const { space } = await fixture();
  const files = [];
  try {
    for (let index = 0; index < 51; index++)
      files.push(
        await space.spool(input(20_971_520, 'attempt-' + String(index))),
      );
    await expect(
      space.spool(input(20_971_520, 'overflow')),
    ).rejects.toMatchObject({ safeErrorCode: 'execution.file_scratch_full' });
  } finally {
    await Promise.all(files.map((file) => file.release()));
  }
});

it('refuses an oversized stream, closes it and frees its failed spool reservation', async () => {
  const { space, directory } = await fixture();
  const body = Readable.from([Buffer.alloc(5)]);
  await expect(space.spool(input(4, 'attempt', body))).rejects.toMatchObject({
    safeErrorCode: 'execution.file_size',
    possiblyDispatched: false,
  });
  expect(body.destroyed).toBe(true);
  expect(await readdir(directory)).toEqual([]);
  const file = await space.spool(input(20_971_520));
  await file.release();
});

it('keeps failed cleanup charged until startup can remove abandoned owned spools', async () => {
  const { space, directory } = await fixture();
  const file = await space.spool(input(20_971_520));
  await chmod(directory, 0o500);
  try {
    await expect(file.release()).rejects.toMatchObject({
      safeErrorCode: 'execution.file_scratch_cleanup',
    });
  } finally {
    await chmod(directory, 0o700);
  }
  await expect(space.spool(input(1, 'another-attempt'))).rejects.toMatchObject({
    safeErrorCode: 'execution.file_scratch_cleanup',
  });
  const restarted = await ArtifactScratchSpace.create(directory);
  expect(await readdir(directory)).toEqual([]);
  const next = await restarted.spool(input());
  await next.release();
});

it('cleans only owned names and never follows an abandoned spool symlink', async () => {
  const { directory } = await fixture();
  const external = await mkdtemp(
    path.join(tmpdir(), 'pertexo-scratch-foreign-'),
  );
  roots.push(external);
  await writeFile(path.join(external, 'keep'), 'safe');
  await writeFile(path.join(directory, 'unrelated'), 'keep');
  await symlink(external, path.join(directory, 'spool-abc123'));
  await ArtifactScratchSpace.create(directory);
  expect(await readdir(directory)).toEqual(['unrelated']);
  expect(await readFile(path.join(external, 'keep'), 'utf8')).toBe('safe');
});

it('refuses startup when owned abandoned files cannot be cleaned', async () => {
  const { directory } = await fixture();
  const abandoned = path.join(directory, 'spool-abc123');
  await mkdir(abandoned, { mode: 0o700 });
  await writeFile(path.join(abandoned, 'body'), 'private');
  await chmod(abandoned, 0o000);
  try {
    await expect(ArtifactScratchSpace.create(directory)).rejects.toThrow();
  } finally {
    await chmod(abandoned, 0o700);
  }
});

it('refuses shared or symlinked scratch roots before opening consumers', async () => {
  const { directory } = await fixture();
  await chmod(directory, 0o755);
  try {
    await expect(ArtifactScratchSpace.create(directory)).rejects.toThrow(
      'private',
    );
  } finally {
    await chmod(directory, 0o700);
  }
  const link = path.join(directory, 'link');
  await symlink(directory, link);
  await expect(ArtifactScratchSpace.create(link)).rejects.toThrow('private');
});

it('publishes no spool handle when its source fails at EOF and erases owned chunks', async () => {
  const { space, directory } = await fixture();
  const chunk = Buffer.from('test');
  async function* source() {
    yield await Promise.resolve(chunk);
    throw new Error('private source path must not escape');
  }
  await expect(
    space.spool(input(4, 'attempt', Readable.from(source()))),
  ).rejects.toMatchObject({
    safeErrorCode: 'execution.file_scratch_io',
    errorSummary:
      'File scratch space is unavailable. Check the worker storage before retrying.',
  });
  expect(chunk.every((byte) => byte === 0)).toBe(true);
  expect(await readdir(directory)).toEqual([]);
});

it('closes paused readers before releasing their disk reservation', async () => {
  const { space, directory } = await fixture();
  const file = await space.spool(input());
  const stream = file.open();
  await file.release();
  expect(stream.closed).toBe(true);
  expect(await readdir(directory)).toEqual([]);
});

it('cleans cancellation after a partial write and refuses fresh canceled work', async () => {
  const { space, directory } = await fixture();
  const controller = new AbortController();
  async function* source() {
    yield await Promise.resolve(Buffer.from('test'));
    controller.abort();
    yield Buffer.from('next');
  }
  await expect(
    space.spool({ ...input(), body: source(), signal: controller.signal }),
  ).rejects.toMatchObject({ kind: 'canceled' });
  expect(await readdir(directory)).toEqual([]);
  await expect(
    space.spool({ ...input(), signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('attempts file and directory cleanup after a source error even when file close also fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-scratch-double-'));
  roots.push(root);
  let closed = 0,
    removed = 0;
  const scratch = await ArtifactScratchSpace.create(root, {
    openFile: async (filename) => {
      const file = await open(filename, 'wx', 0o600);
      const close = file.close.bind(file);
      file.close = async () => {
        closed++;
        await close();
        throw new Error('private close failure');
      };
      return file;
    },
    removeDirectory: async (directory) => {
      removed++;
      await rm(directory, { recursive: true, force: true });
    },
  });
  const bytes = new Uint8Array([1]);
  const result: unknown = await scratch
    .spool({
      attemptId: 'failed',
      maxBytes: 1,
      body: (async function* () {
        yield await Promise.resolve(bytes);
        throw new Error('private source failure');
      })(),
      signal: new AbortController().signal,
    })
    .catch((error: unknown) => error);
  expect(result).toMatchObject({
    safeErrorCode: 'execution.file_scratch_cleanup',
  });
  expect(bytes).toEqual(new Uint8Array([0]));
  expect(closed).toBe(1);
  expect(removed).toBe(1);
  expect(await readdir(root)).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('private');
  await expect(
    scratch.spool({
      attemptId: 'new',
      maxBytes: 1,
      body: Readable.from([Buffer.from('x')]),
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ safeErrorCode: 'execution.file_scratch_cleanup' });
});

it('cancels and closes a stalled native producer after sixty seconds, then allows fresh work', async () => {
  const { space, directory } = await fixture();
  vi.useFakeTimers();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const body = new Readable({
    read: () => {
      reading();
    },
  });
  const failed = expect(
    space.spool({
      ...input(100),
      body,
      cancelSource: (reason) => {
        body.destroy(reason);
      },
    }),
  ).rejects.toMatchObject({ safeErrorCode: 'execution.file_progress_timeout' });
  await started;
  await vi.advanceTimersByTimeAsync(60000);
  await failed;
  expect(body.closed).toBe(true);
  expect(await readdir(directory)).toEqual([]);
  vi.useRealTimers();
  const next = await space.spool(input(4, 'next'));
  await next.release();
});
