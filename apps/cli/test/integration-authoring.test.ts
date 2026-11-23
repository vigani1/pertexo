import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { parseCommunityApprovalSet } from '@pertexo/node-catalog/server';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const execute = promisify(execFile);

it('scaffolds a release and checks its exact bytes and example without API settings', async () => {
  await withAuthorFolder(async (cwd, run) => {
    await run('init');
    const bytes = await readFile(path.join(cwd, 'integration.json'));
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toContain(
      'integration check',
    );
    const fixtureFile = path.join(cwd, 'conformance.json');
    const [example] = JSON.parse(await readFile(fixtureFile, 'utf8')) as [
      {
        request: { headers: { 'x-api-key': string } };
        response: { body: { title: string } };
        output: { title: string };
      },
    ];
    example.response.body.title = example.request.headers['x-api-key'];
    example.output.title = '[Redacted]';
    await writeFile(fixtureFile, JSON.stringify([example]));
    const checked = await run('check');
    expect(JSON.parse(checked.stdout)).toEqual({
      file: 'integration.json',
      providerKey: 'community.example.posts',
      version: '1.0.0',
      origin: 'https://example-posts.provider.test',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      examples: 1,
    });
    await expect(run('init')).rejects.toMatchObject({ code: 5 });
    expect(await readFile(path.join(cwd, 'integration.json'))).toEqual(bytes);
  });
});

it('reports the path of a mismatched conformance request', async () => {
  await withAuthorFolder(async (cwd, run) => {
    await run('init');
    const file = path.join(cwd, 'conformance.json');
    const examples = JSON.parse(await readFile(file, 'utf8')) as [
      { request: { path: string } },
    ];
    examples[0].request.path = '/wrong';
    await writeFile(file, JSON.stringify(examples));
    await expect(run('check')).rejects.toThrow(
      'conformance.json[0].request.path',
    );
  });
});

it('rejects a destination override in a release and in deployment approvals', async () => {
  await withAuthorFolder(async (cwd, run) => {
    await run('init');
    const file = path.join(cwd, 'integration.json');
    const { examples: _examples, ...approval } = JSON.parse(
      (await run('check')).stdout,
    ) as {
      examples: number;
      file: string;
      providerKey: string;
      version: string;
      origin: string;
      sha256: string;
    };
    const release = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >;
    const transport = { destination: 'http://127.0.0.1:8080' };
    await writeFile(file, JSON.stringify({ ...release, transport }));
    await expect(run('check')).rejects.toThrow('transport');
    expect(() =>
      parseCommunityApprovalSet(
        cwd,
        JSON.stringify([{ ...approval, transport }]),
      ),
    ).toThrow('approval');
  });
});

async function withAuthorFolder(
  test: (
    cwd: string,
    run: (operation: string) => Promise<{ stdout: string }>,
  ) => Promise<void>,
) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pertexo-author-'));
  try {
    await test(cwd, (operation) =>
      execute(process.execPath, [entrypoint, 'integration', operation], {
        cwd,
        env: {},
        encoding: 'utf8',
        timeout: 5000,
      }),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
