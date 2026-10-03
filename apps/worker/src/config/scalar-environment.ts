/** Normalize scalar configuration input before the specialized config parsers. */
export function stringEnvironment(
  environment: Readonly<Record<string, unknown>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => {
      if (value === undefined || typeof value === 'string')
        return [name, value];
      if (typeof value === 'number' || typeof value === 'boolean')
        return [name, String(value)];
      throw new TypeError('Worker environment values must be scalar');
    }),
  );
}
