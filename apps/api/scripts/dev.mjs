import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const directory = fileURLToPath(new URL('../', import.meta.url));

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
      process.stderr.write(
        `API development process failed: ${error.message}\n`,
      );
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
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
  const server = start(['--watch', 'dist/main.js']);
  const children = [watcher, server];
  let receivedSignal;
  let stopping = false;

  function stop(signal) {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    }
  }

  process.once('SIGINT', () => {
    receivedSignal = 'SIGINT';
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    receivedSignal = 'SIGTERM';
    stop('SIGTERM');
  });

  const results = children.map(completion);
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
