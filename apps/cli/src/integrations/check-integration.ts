import { loadAuthorCommunityRelease } from '@pertexo/node-catalog/server';
import { z } from 'zod';
import { AutomationCommandError } from '../commands/automation-command.errors.js';
import { readCommandJson } from '../commands/command-json-file.js';
import {
  CONFORMANCE_FILE,
  conformanceExamples,
} from './conformance.schemas.js';
import { INTEGRATION_FILE } from './init-integration.js';
import { checkExample } from './check-example.js';

export async function checkIntegration(signal: AbortSignal) {
  let release;
  try {
    release = await loadAuthorCommunityRelease('.', INTEGRATION_FILE);
  } catch (cause) {
    throw checkFailure(INTEGRATION_FILE, cause);
  }
  let examples;
  try {
    examples = conformanceExamples.parse(
      await readCommandJson(CONFORMANCE_FILE),
    );
  } catch (cause) {
    throw checkFailure(CONFORMANCE_FILE, cause);
  }
  for (const [index, example] of examples.entries()) {
    const path = `${CONFORMANCE_FILE}[${String(index)}]`;
    try {
      await checkExample(release, example, signal);
    } catch (cause) {
      throw checkFailure(path, cause);
    }
  }
  return { ...release.metadata, examples: examples.length };
}

function checkFailure(path: string, cause: unknown): AutomationCommandError {
  let detail = 'Check failed.';
  if (cause instanceof z.ZodError) detail = z.prettifyError(cause);
  else if (cause instanceof Error) detail = cause.message;
  return new AutomationCommandError(
    'cli.integration_check_failed',
    `${path}${detail.startsWith('.') ? '' : ': '}${detail}`,
  );
}
