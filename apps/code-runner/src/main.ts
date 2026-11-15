import { writeFile, unlink } from 'node:fs/promises';
import { startCodeRunner } from './runner-application.js';
import {
  parseRunnerConfig,
  RUNNER_FILE_MODES,
} from './config/runner-config.js';

/** How much of a startup failure's chain of causes the log shows. */
const STARTUP_FAILURE_REPORT = Object.freeze({
  causes: 8,
  reasonCharacters: 2_048,
  groupedErrors: 2,
  characters: 8_192,
});

try {
  const config = parseRunnerConfig();
  const runner = await startCodeRunner(config);
  const marker = '/tmp/pertexo-code-runner-ready';
  try {
    if (config.mode === 'hardened')
      await writeFile(marker, '', { mode: RUNNER_FILE_MODES.privateFile });
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
  for (
    let index = 0;
    index < pending.length && index < STARTUP_FAILURE_REPORT.causes;
    index++
  ) {
    const failure = pending[index];
    if (!(failure instanceof Error)) continue;
    reasons.push(
      failure.message.slice(0, STARTUP_FAILURE_REPORT.reasonCharacters),
    );
    if (failure instanceof AggregateError)
      pending.push(
        ...(failure.errors as unknown[]).slice(
          0,
          STARTUP_FAILURE_REPORT.groupedErrors,
        ),
      );
    if (failure.cause !== undefined) pending.push(failure.cause);
  }
  console.error(
    reasons.length === 0
      ? 'Code runner startup failed.'
      : reasons.join('\n').slice(0, STARTUP_FAILURE_REPORT.characters),
  );
  process.exitCode = 1;
}
