export class AutomationCommandError extends Error {
  public readonly uncertain: boolean;
  public constructor(
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    { uncertain = false }: Readonly<{ uncertain?: boolean | undefined }> = {},
  ) {
    super(message);
    this.uncertain = uncertain;
  }
}

export function invalidArgument(message: string): never {
  throw new AutomationCommandError('cli.invalid_argument', message);
}
