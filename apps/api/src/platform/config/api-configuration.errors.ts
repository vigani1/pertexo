/** Only owned setting names and repair instructions cross the process boundary. */
export class ApiConfigurationError extends Error {
  public override readonly name: string = 'ApiConfigurationError';

  public constructor(
    settings: string,
    remedy: string,
    rule = 'invalid_configuration',
  ) {
    super(`${settings} (${rule}): ${remedy}`);
  }
}

/** A dependency's parser may include rejected values in its exception. */
export function parseConfigurationSection<T>(
  settings: string,
  remedy: string,
  parse: () => T,
): T {
  try {
    return parse();
  } catch {
    throw new ApiConfigurationError(settings, remedy);
  }
}
