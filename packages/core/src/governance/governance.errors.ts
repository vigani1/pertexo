export class GovernanceError extends Error {
  override readonly name = 'GovernanceError';
  constructor(
    readonly reason: 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

export function requireGovernanceSettings<T>(settings: T | undefined): T {
  if (settings === undefined)
    throw new GovernanceError(
      'conflict',
      'Workspace settings are unavailable.',
    );
  return settings;
}
