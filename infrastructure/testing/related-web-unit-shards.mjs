import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WEB_UNIT_SHARD_COUNT } from './web-unit-shards.mjs';

// Recorded test work plus isolated-file startup, divided over four workers.
// Leave room for dependency builds inside a five-minute job.
const RELATED_WORK_BUDGET_MS = 240_000;
const FILE_STARTUP_MS = 1_000;

export function relatedWebUnitShardCount(changed) {
  const web = resolve('apps/web');
  const durations = JSON.parse(
    readFileSync(new URL('./unit-durations.json', import.meta.url), 'utf8'),
  );
  const reverse = new Map();
  const tests = [];
  for (const area of ['src', 'test']) {
    for (const relative of readdirSync(`${web}/${area}`, { recursive: true })) {
      if (!/\.tsx?$/u.test(relative)) continue;
      const file = `${web}/${area}/${relative}`;
      if (/\.test\.tsx?$/u.test(file)) tests.push(file);
      const source = readFileSync(file, 'utf8');
      for (const [, name] of source.matchAll(
        /(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/gu,
      )) {
        const base = name.startsWith('@/')
          ? `${web}/src/${name.slice(2)}`
          : name.startsWith('.')
            ? resolve(dirname(file), name)
            : undefined;
        if (!base) continue;
        const dependency = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
          base.replace(/\.js$/u, '.ts'),
        ].find(
          (candidate) => /\.tsx?$/u.test(candidate) && existsSync(candidate),
        );
        if (!dependency) continue;
        const consumers = reverse.get(dependency) ?? new Set();
        consumers.add(file);
        reverse.set(dependency, consumers);
      }
    }
  }
  const reached = new Set(changed.map((file) => resolve(web, file)));
  for (const file of reached)
    for (const consumer of reverse.get(file) ?? []) reached.add(consumer);
  const work = tests
    .filter((file) => reached.has(file))
    .reduce(
      (total, file) =>
        total +
        (durations[file.slice(web.length + 1)] ?? FILE_STARTUP_MS) +
        FILE_STARTUP_MS,
      0,
    );
  return work > RELATED_WORK_BUDGET_MS ? WEB_UNIT_SHARD_COUNT : 1;
}
