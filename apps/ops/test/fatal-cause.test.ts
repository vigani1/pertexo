import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const EXIT_LIMIT_MS = 30_000;

const environment = (): NodeJS.ProcessEnv => ({
  DATABASE_MAINTENANCE_URL:
    'postgresql://maintenance:do-not-print-me@127.0.0.1:1/pertexo',
  OPERATOR_ACTOR_REF: 'test:fatal-cause',
  OPERATOR_COMMAND_ID: randomUUID(),
  OPERATOR_COMMAND_TYPE: 'run.cancel',
  OPERATOR_DRY_RUN: 'true',
  OPERATOR_REASON: 'fatal cause test',
  OPERATOR_WORKSPACE_ID: randomUUID(),
  PATH: process.env.PATH,
});

async function runOperator(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entrypoint], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      output += chunk;
    });
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`operator command did not exit: ${output}`));
    }, EXIT_LIMIT_MS);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, output };
}

describe('an operator command that cannot start', () => {
  it('exits with a failure when a required setting is missing', async () => {
    const { code } = await runOperator(environment());
    expect(code).toBe(1);
  });

  // ops-08: `operator_command.process_failed` names no setting.
  it.fails('names the missing setting in its fatal line', async () => {
    const { output } = await runOperator(environment());
    expect(output).toContain('OPERATOR_RUN_ID');
  });

  it('never prints a password from its connection string', async () => {
    const { output } = await runOperator(environment());
    expect(output).not.toContain('do-not-print-me');
  });
});
