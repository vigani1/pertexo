import { parseAutomationArguments } from './arguments.js';
import { parseAutomationHttpConfig } from './config.js';
import { createAutomationHttpClient } from './http.js';
import { executeAutomationCommand } from './commands.js';
import { AutomationCommandError } from './errors.js';

const HELP = `Pertexo automation (HTTP; no operator/database configuration)
Set PERTEXO_API_URL and PERTEXO_API_TOKEN in your environment.
  workflows list --workspace UUID [--limit N --after CURSOR]
  workflows get|draft --workspace UUID --workflow UUID
  workflows versions --workspace UUID --workflow UUID [--version UUID --limit N --after CURSOR]
  workflows export --workspace UUID --workflow UUID --body FILE [--etag QUOTED_ETAG]
  workflows import-preview --workspace UUID --body FILE
  workflows import --workspace UUID --body FILE --key STABLE_KEY
  workflows publish --workspace UUID --workflow UUID --etag QUOTED_ETAG --key STABLE_KEY
  runs start --workspace UUID --workflow UUID --key STABLE_KEY [--body FILE]
  runs list --workspace UUID [--workflow UUID --limit N --after CURSOR]
  runs get --workspace UUID --run UUID
  runs cancel --workspace UUID --run UUID [--body FILE]
Bodies use the documented HTTP request schemas. Draft JSON also includes its opaque etag.
Secrets are accepted only through the environment. Never retry a write with a new key.
`;

export async function runAutomationCli(
  args: string[],
  environment = process.env,
): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const command = parseAutomationArguments(args);
    if (command === 'help') {
      process.stdout.write(HELP);
      return;
    }
    const config = parseAutomationHttpConfig(environment);
    if (config.credential.split('.')[1] !== command.workspaceId)
      throw new AutomationCommandError(
        'cli.invalid_argument',
        'The workspace must match the configured personal token.',
      );
    const result = await executeAutomationCommand(
      createAutomationHttpClient(config),
      command,
      shutdown.signal,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    const error =
      cause instanceof AutomationCommandError
        ? cause
        : new AutomationCommandError(
            'cli.command_failed',
            'The command could not be completed.',
          );
    process.stderr.write(
      `${JSON.stringify({ code: error.code, detail: error.message, ...(error.requestId === undefined ? {} : { requestId: error.requestId }), ...(error.uncertain ? { outcome: 'unknown', next: 'Check the result. Retry only with the same token and exact command, including its key, body and preconditions where required.' } : {}) })}\n`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
