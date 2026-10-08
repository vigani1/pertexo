import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = new URL('../../', import.meta.url);
const moduleUrl = new URL(
  './curated-cutover-artifact-build.mjs',
  import.meta.url,
);

// Command/identity/cleanup contract only. The cold-metadata regression is proved
// separately with actual pinned pnpm and independently compiled full archives.
for (const mode of ['success', 'changed-lock', 'failure']) {
  test(`cache preparation archives frozen source and closes ownership on ${mode}`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-cache-contract-'),
    );
    const log = path.join(directory, 'command.json');
    const { stdout: ref } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
    });
    const executable = path.join(directory, 'pnpm');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CACHE_CONTRACT_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
if (process.env.CACHE_CONTRACT_MODE === 'changed-lock') writeFileSync('pnpm-lock.yaml', 'changed');
if (process.env.CACHE_CONTRACT_MODE === 'failure') { console.error('ERR_PNPM_NO_OFFLINE_META https://private:secret@example.test'); process.exit(1); }
`,
      { mode: 0o700 },
    );
    const args = [
      '--input-type=module',
      '-e',
      `import {prepareCuratedCutoverCache} from ${JSON.stringify(moduleUrl.href)};
try { console.log(JSON.stringify(await prepareCuratedCutoverCache({repository:${JSON.stringify(path.resolve(repository.pathname))},ref:${JSON.stringify(ref.trim())},label:'cache-contract'}))); }
catch(error) { console.error(error.message); process.exitCode=1; }`,
    ];
    const options = {
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        CACHE_CONTRACT_LOG: log,
        CACHE_CONTRACT_MODE: mode,
      },
      timeout: 20000,
    };
    try {
      if (mode === 'success') {
        const result = JSON.parse(
          (await exec(process.execPath, args, options)).stdout,
        );
        assert.equal(result.ref, ref.trim());
        assert.match(result.sourceDigest, /^[a-f0-9]{64}$/u);
        assert.match(result.lockDigest, /^[a-f0-9]{64}$/u);
      } else {
        await assert.rejects(exec(process.execPath, args, options), (error) => {
          assert.match(
            error.stderr,
            mode === 'failure'
              ? /CURATED_ARTIFACT_CACHE_PREPARE_FAILED.*ERR_PNPM_NO_OFFLINE_META/u
              : /changed the source lockfile/u,
          );
          assert.doesNotMatch(error.stderr, /private|secret|https:/u);
          return true;
        });
      }
      const command = JSON.parse(await readFile(log, 'utf8'));
      assert.deepEqual(command.args, [
        'fetch',
        '--ignore-scripts',
        '--frozen-lockfile',
      ]);
      assert.notEqual(command.cwd, path.resolve(repository.pathname));
      await assert.rejects(readFile(path.join(command.cwd, 'pnpm-lock.yaml')), {
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
