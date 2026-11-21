import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { tsImport } from 'tsx/esm/api';
import { mergeConfig } from 'vitest/config';

import { laneOf } from './no-flake-masking.mjs';
import { LANES } from './policy.mjs';
import { repositoryRoot } from './ratchet.mjs';

// LANES copies each lane's timeouts so the lint can judge a per-test timeout;
// this keeps the copy equal to what the Vitest and Playwright configs set.

const VITEST_INCLUDE = ['**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs,cjs,jsx}'];
const tracked = execFileSync('git', ['ls-files'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const configs = tracked.filter((file) =>
  /(?:^|\/)(?:vitest|playwright)[^/]*\.config\.ts$/u.test(file),
);

for (const config of configs) {
  test(`${config} runs each file with the timeouts its lane names`, async () => {
    // The live config refuses to load without the origin its journey passes.
    process.env.PERTEXO_LIVE_WEB_ORIGIN ??= 'http://127.0.0.1:9';
    const loaded = await tsImport(
      path.join(repositoryRoot, config),
      import.meta.url,
    );
    const settings = loaded.default;
    // A shared fragment that other configs spread, not a lane of its own.
    if (settings === undefined) return;
    const lanes = config.includes('playwright')
      ? [playwrightLane(config, settings)]
      : vitestLanes(config, settings);
    const seen = new Set();
    for (const lane of lanes) {
      assert.ok(lane.files.length > 0, `${config} selects no tracked file`);
      for (const file of lane.files) {
        assert.ok(!seen.has(file), `${file} runs twice under ${config}`);
        seen.add(file);
        assert.deepEqual(
          pick(laneOf(file, LANES)),
          pick(lane),
          `${file} under ${config}`,
        );
      }
    }
  });
}

function vitestLanes(config, { test: settings = {} }) {
  const projects = settings.projects ?? [{ extends: true }];
  return projects.map(({ extends: inherits, test: options = {} }) =>
    vitestLane(config, mergeConfig(inherits === true ? settings : {}, options)),
  );
}

function vitestLane(config, settings) {
  const root = path.posix.dirname(config);
  const include = settings.include ?? VITEST_INCLUDE;
  const exclude = [
    '**/node_modules/**',
    '**/dist/**',
    ...(settings.exclude ?? []),
    ...(path.posix.basename(config) === 'vitest.config.ts'
      ? scriptExcludes(root)
      : []),
  ];
  return {
    files: inside(root, include, exclude),
    testTimeout: settings.testTimeout ?? 5_000,
    hookTimeout: settings.hookTimeout ?? 10_000,
  };
}

/** `vitest run --exclude '<glob>'` in the package's test script. */
function scriptExcludes(root) {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, root, 'package.json'), 'utf8'),
  );
  return [
    ...(manifest.scripts?.test ?? '').matchAll(/--exclude '([^']+)'/gu),
  ].map(([, glob]) => glob);
}

function playwrightLane(config, settings) {
  const root = path.posix.join(path.posix.dirname(config), settings.testDir);
  const timeout = settings.timeout ?? 30_000;
  return {
    files: inside(root, ['**/*.spec.ts'], []),
    testTimeout: timeout,
    hookTimeout: timeout,
  };
}

function inside(root, include, exclude) {
  return tracked.filter((file) => {
    if (!file.startsWith(`${root}/`)) return false;
    const relative = file.slice(root.length + 1);
    const matches = (globs) =>
      globs.some((glob) => path.matchesGlob(relative, glob));
    return matches(include) && !matches(exclude);
  });
}

function pick({ testTimeout, hookTimeout }) {
  return { testTimeout, hookTimeout };
}
