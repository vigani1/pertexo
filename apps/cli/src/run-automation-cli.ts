import { parseAutomationArguments } from './automation-arguments.js';
import { parseAutomationHttpConfig } from './automation-http-config.js';
import { createAutomationHttpClient } from './automation-http-client.js';
import { executeAutomationCommand } from './execute-automation-command.js';
import {
  AutomationCommandError,
  exitCodeFor,
} from './automation-command.errors.js';
import { readFileSync } from 'node:fs';

const HELP = `Pertexo CLI, over the HTTP API
Set PERTEXO_API_URL and PERTEXO_API_TOKEN in your environment. --workspace defaults to the token's.
  whoami
  workflows list [--limit N --after CURSOR]
  workflows get|draft --workflow UUID
  workflows versions --workflow UUID [--version UUID --limit N --after CURSOR]
  workflows export --workflow UUID --body FILE [--etag QUOTED_ETAG]
  workflows import-preview --body FILE
  workflows import --body FILE --key STABLE_KEY
  workflows publish --workflow UUID --etag QUOTED_ETAG --key STABLE_KEY
  runs start --workflow UUID --key STABLE_KEY [--body FILE]
  runs list [--workflow UUID --status STATUS --limit N --after CURSOR]
  runs get --run UUID
  runs wait --run UUID [--timeout SECONDS]
  runs cancel --run UUID [--body FILE]
Bodies use the documented HTTP request schemas. Draft JSON also includes its opaque etag.
Secrets are accepted only through the environment. Never retry a write with a new key.
Exit codes: 0 done, 1 other failure, 2 bad usage or settings, 3 token or permission refused,
4 not found, 5 conflict or precondition, 6 busy, retry later, 7 a write's outcome is unknown.
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
    const command = parseAutomationArguments(
      args,
      environment.PERTEXO_API_TOKEN?.split('.')[1],
    );
    if (command === 'help') {
      process.stdout.write(HELP);
      return;
    }
    if (command === 'version') {
      process.stdout.write(`pertexo ${packageVersion()}\n`);
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
    process.exitCode = exitCodeFor(error);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Readonly<{ version: string }>;
  return manifest.version;
}
