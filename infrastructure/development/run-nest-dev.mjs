// Runs a NestJS app from its package directory: compile with TypeScript, then
// watch the emitted JavaScript. tsx and other esbuild runners drop the
// decorator metadata Nest needs to inject constructor parameters by type.

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const directory = process.cwd();

function start(args) {
  return spawn(process.execPath, args, {
    cwd: directory,
    env: process.env,
    stdio: 'inherit',
  });
}

function completion(child) {
  return new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`Development process failed: ${error.message}\n`);
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Runs the built app and keeps it running. Rebuilt files restart it at once,
 * as `node --watch` did. An unexpected exit restarts it too, after a pause
 * that grows while it keeps failing: the worker deliberately exits when a
 * readiness check fails, which happens after a laptop sleeps, and
 * `node --watch` would wait for the next file change before starting it again.
 */
function superviseServer() {
  let child;
  let stopped = false;
  let reloading = false;
  let failures = 0;
  let restartTimer;
  let reloadTimer;
  let finish;
  const result = new Promise((resolve) => {
    finish = resolve;
  });

  function launch() {
    restartTimer = undefined;
    const startedAt = Date.now();
    child = start(['dist/main.js']);
    child.once('error', (error) => {
      process.stderr.write(`Development process failed: ${error.message}\n`);
    });
    child.once('exit', (code, signal) => {
      child = undefined;
      if (stopped) {
        finish(code ?? 1);
        return;
      }
      if (reloading) {
        reloading = false;
        failures = 0;
        launch();
        return;
      }
      // An app that ran for a while failed afresh; it isn't crash-looping.
      failures = Date.now() - startedAt > 30_000 ? 1 : failures + 1;
      const delay = Math.min(1_000 * 2 ** (failures - 1), 30_000);
      process.stderr.write(
        `\nThe app exited (${signal ?? `code ${String(code)}`}); restarting in ${String(delay / 1_000)}s.\n`,
      );
      restartTimer = setTimeout(launch, delay);
    });
  }

  const emitted = watch('dist', { recursive: true }, () => {
    clearTimeout(reloadTimer);
    // One rebuild writes many files; restart once they have settled.
    reloadTimer = setTimeout(() => {
      if (stopped) return;
      if (child === undefined) {
        clearTimeout(restartTimer);
        failures = 0;
        launch();
        return;
      }
      reloading = true;
      child.kill('SIGTERM');
    }, 200);
  });

  launch();
  return {
    result,
    stop(signal) {
      if (stopped) return;
      stopped = true;
      emitted.close();
      clearTimeout(reloadTimer);
      clearTimeout(restartTimer);
      if (child === undefined) finish(0);
      else child.kill(signal);
    },
  };
}

const initialBuild = start([
  compiler,
  '-p',
  'tsconfig.json',
  '--noEmitOnError',
]);
const buildResult = await completion(initialBuild);
if (buildResult !== 0) {
  process.exitCode = buildResult;
} else {
  const watcher = start([
    compiler,
    '-p',
    'tsconfig.json',
    '--watch',
    '--noEmitOnError',
    '--preserveWatchOutput',
  ]);
  const server = superviseServer();
  let receivedSignal;
  let stopping = false;

  function stop(signal) {
    if (stopping) return;
    stopping = true;
    if (watcher.exitCode === null && watcher.signalCode === null)
      watcher.kill(signal);
    server.stop(signal);
  }

  process.once('SIGINT', () => {
    receivedSignal = 'SIGINT';
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    receivedSignal = 'SIGTERM';
    stop('SIGTERM');
  });

  const results = [completion(watcher), server.result];
  const first = await Promise.race(results);
  stop('SIGTERM');
  await Promise.all(results);
  process.exitCode =
    receivedSignal === 'SIGINT'
      ? 130
      : receivedSignal === 'SIGTERM'
        ? 143
        : first === 0
          ? 1
          : first;
}
