export class GovernanceError extends Error {
  override readonly name = 'GovernanceError';
  constructor(
    readonly reason: 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
