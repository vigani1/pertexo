import { writeFile, unlink } from 'node:fs/promises';
import { startCodeRunner } from './app.js';
import { parseRunnerConfig } from './config.js';

try {
  const config = parseRunnerConfig();
  const runner = await startCodeRunner(config);
  const marker = '/tmp/pertexo-code-runner-ready';
  try {
    if (config.mode === 'hardened')
      await writeFile(marker, '', { mode: 0o600 });
  } catch (error: unknown) {
    await runner.close();
    throw error;
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        if (config.mode === 'hardened') await unlink(marker);
      } finally {
        await runner.close();
      }
    })().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.info(
    config.mode === 'hardened'
      ? 'Code runner ready (hardened).'
      : 'Code runner ready (development process mode; OS isolation is weaker).',
  );
} catch (error: unknown) {
  const pending: unknown[] = [error];
  const reasons: string[] = [];
  for (let index = 0; index < pending.length && index < 8; index++) {
    const failure = pending[index];
    if (!(failure instanceof Error)) continue;
    reasons.push(failure.message.slice(0, 2048));
    if (failure instanceof AggregateError)
      pending.push(...(failure.errors as unknown[]).slice(0, 2));
    if (failure.cause !== undefined) pending.push(failure.cause);
  }
  console.error(
    reasons.length === 0
      ? 'Code runner startup failed.'
      : reasons.join('\n').slice(0, 8192),
  );
  process.exitCode = 1;
}
