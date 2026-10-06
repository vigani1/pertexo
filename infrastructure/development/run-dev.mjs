// Keep the existing per-package Nest TypeScript and Vite dev commands. Unlike
// --run, executing this module retains the CLI-loaded local environment before
// handing it to pnpm's three service processes.
import { spawn } from 'node:child_process';

const child = spawn('pnpm', ['run', 'dev:services'], {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => child.kill(signal));

child.once('error', () => {
  process.stderr.write('Could not start development services.\n');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
