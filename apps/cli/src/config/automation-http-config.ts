import { apiTokenCredentialSchema } from '@pertexo/contracts';
import { AutomationCommandError } from '../commands/automation-command.errors.js';

/** The longest `PERTEXO_API_URL` the CLI accepts. */
const API_URL_MAX_CHARACTERS = 2_048;

export type AutomationHttpConfig = Readonly<{
  origin: string;
  credential: string;
}>;

/** The settings the CLI reads: only `PERTEXO_API_URL` and `PERTEXO_API_TOKEN`. */
export type AutomationEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** The process environment, read here and nowhere else in the CLI. */
export function readAutomationEnvironment(): AutomationEnvironment {
  return process.env;
}

/** The workspace a personal token belongs to: its middle segment. */
export function tokenWorkspaceId(
  token: string | undefined,
): string | undefined {
  return token?.split('.')[1];
}

export function parseAutomationHttpConfig(
  environment: AutomationEnvironment,
): AutomationHttpConfig {
  const parsed = apiTokenCredentialSchema.safeParse(
    environment.PERTEXO_API_TOKEN,
  );
  if (!parsed.success)
    throw new AutomationCommandError(
      'cli.invalid_config',
      'Set PERTEXO_API_TOKEN to a valid personal API token.',
    );
  const value = environment.PERTEXO_API_URL;
  if (value === undefined || value.length > API_URL_MAX_CHARACTERS)
    throw new AutomationCommandError(
      'cli.invalid_config',
      'Set PERTEXO_API_URL to your Pertexo origin.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AutomationCommandError(
      'cli.invalid_config',
      'PERTEXO_API_URL must be an absolute HTTPS origin.',
    );
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  const invalidApiOrigin =
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/';
  if (invalidApiOrigin)
    throw new AutomationCommandError(
      'cli.invalid_config',
      'Use an HTTPS origin without credentials, path, query or fragment. HTTP is allowed only on loopback.',
    );
  return Object.freeze({ origin: url.origin, credential: parsed.data });
}
