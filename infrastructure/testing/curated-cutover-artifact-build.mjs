import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function command(stage, executable, args, cwd, timeout = 180_000) {
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  let forceTimer;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, timeout);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const output = Buffer.concat(chunks).toString('utf8');
    if (code !== 0) {
      const diagnostics = [
        ...new Set(
          output.match(/\b(?:ERR_PNPM_[A-Z_]+|TS[0-9]{4,5})\b/gu) ?? [],
        ),
      ];
      throw new Error(
        `CURATED_ARTIFACT_${stage}_FAILED exit=${String(code)} diagnostics=${diagnostics.slice(0, 8).join(',') || 'none'}`,
      );
    }
    return output.trim();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`CURATED_ARTIFACT_${stage}_FAILED`)
    )
      throw error;
    const code = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)
      ? error.code
      : 'unknown';
    throw new Error(`CURATED_ARTIFACT_${stage}_FAILED diagnostics=${code}`);
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
  }
}
async function filesDigest(root, relative = '') {
  const hash = createHash('sha256');
  const visit = async (directory) => {
    for (const entry of (
      await readdir(path.join(root, directory), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(root, name));
        hash
          .update(`${Buffer.byteLength(name)}:${name}${bytes.length}:`)
          .update(bytes);
      } else throw new Error('Artifact fingerprint must not traverse symlinks');
    }
  };
  await visit(relative);
  return hash.digest('hex');
}
/** Frozen committed source; offline installs never fall back to a registry. */
export async function buildCuratedCutoverArtifact({ repository, ref, label }) {
  if (!/^[a-f0-9]{40}$/u.test(ref) || !/^[a-z][a-z0-9-]{0,40}$/u.test(label))
    throw new Error('Invalid source-bound artifact identity');
  const directory = await mkdtemp(
    path.join(tmpdir(), `pertexo-f06-cutover-${label}-`),
  );
  try {
    const archive = path.join(directory, 'source.tar');
    await command(
      'ARCHIVE',
      'git',
      ['archive', '--format=tar', `--output=${archive}`, ref],
      repository,
    );
    const source = path.join(directory, 'source');
    await mkdir(source);
    await command('EXTRACT', 'tar', ['-xf', archive, '-C', source], repository);
    const sourceDigest = await filesDigest(source);
    const lockDigest = createHash('sha256')
      .update(await readFile(path.join(source, 'pnpm-lock.yaml')))
      .digest('hex');
    await command(
      'OFFLINE_INSTALL',
      'pnpm',
      ['install', '--offline', '--ignore-scripts', '--frozen-lockfile'],
      source,
    );
    await command(
      'COMPILE',
      'pnpm',
      ['exec', 'tsc', '--build', 'apps/api/tsconfig.json', '--pretty', 'false'],
      source,
    );
    const packages = [];
    for (const name of (await readdir(path.join(source, 'packages'))).sort()) {
      const dist = path.join(source, 'packages', name, 'dist');
      if (
        await stat(dist).then(
          () => true,
          () => false,
        )
      )
        packages.push({ name, digest: await filesDigest(dist) });
    }
    const apiDigest = await filesDigest(path.join(source, 'apps/api/dist'));
    return {
      directory,
      source,
      witness: { label, ref, sourceDigest, lockDigest, apiDigest, packages },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
