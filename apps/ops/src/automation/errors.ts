export class AutomationCommandError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly uncertain = false,
  ) {
    super(message);
  }
}

export function invalidArgument(message: string): never {
  throw new AutomationCommandError('cli.invalid_argument', message);
}
