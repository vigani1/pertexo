import {
  classifyProcessError,
  describeProcessFailure,
} from '@pertexo/observability/startup';

/**
 * How an ops entry reports the failure that ends its process: one JSON fatal
 * event on stderr, then a failing exit code. `cause` replaces the described
 * failure when the entry must not print what the error carries.
 */
export function reportProcessFailure(
  event: string,
  error: unknown,
  cause: string = describeProcessFailure(error),
): void {
  process.stderr.write(
    `${JSON.stringify({
      cause,
      errorType: classifyProcessError(error),
      event,
      level: 'fatal',
    })}\n`,
  );
  process.exitCode = 1;
}
