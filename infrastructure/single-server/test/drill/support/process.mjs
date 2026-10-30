import { spawn } from 'node:child_process';

/** Runs a command and collects its output; only `must` treats a failure as fatal. */
export function run(
  command,
  args,
  { input, timeout = 600_000, env, cwd } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: status ?? signal,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
    child.stdin.end(input);
  });
}

export async function must(command, args, options) {
  const result = await run(command, args, options);
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
}

export const docker = (args, options) => run('docker', args, options);
export const mustDocker = (args, options) => must('docker', args, options);

/** Polls until `check` returns something truthy, and returns that value. */
export async function waitFor(
  check,
  { timeout = 120_000, every = 1_000, what },
) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}${last ? `: ${last}` : ''}`,
      );
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}
