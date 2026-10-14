import { apiTokenCredentialSchema } from '@pertexo/contracts';
import { AutomationCommandError } from './errors.js';

export type AutomationHttpConfig = Readonly<{
  origin: string;
  credential: string;
}>;

export function parseAutomationHttpConfig(
  environment: Readonly<Record<string, string | undefined>>,
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
  if (value === undefined || value.length > 2_048)
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
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  )
    throw new AutomationCommandError(
      'cli.invalid_config',
      'Use an HTTPS origin without credentials, path, query or fragment. HTTP is allowed only on loopback.',
    );
  return Object.freeze({ origin: url.origin, credential: parsed.data });
}
