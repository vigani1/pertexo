/** Contains only owned setting names and remedies, never rejected input. */
export class IdentityConfigurationError extends Error {
  public override readonly name = 'IdentityConfigurationError';
  public constructor(
    settings: string,
    rule: 'invalid_configuration' | 'incomplete_pair',
  ) {
    const remedy =
      rule === 'incomplete_pair'
        ? 'supply both settings or remove both.'
        : 'supply matching settings and valid keys; check the identity configuration guide.';
    super(`${settings} (${rule}): ${remedy}`);
  }
}
