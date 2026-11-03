export class AutomationCommandError extends Error {
  public readonly uncertain: boolean;
  public readonly status: number | undefined;
  public constructor(
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    {
      uncertain = false,
      status,
    }: Readonly<{ uncertain?: boolean | undefined; status?: number }> = {},
  ) {
    super(message);
    this.uncertain = uncertain;
    this.status = status;
  }
}

export function invalidArgument(message: string): never {
  throw new AutomationCommandError('cli.invalid_argument', message);
}

/** So a script can branch without reading the JSON. `pertexo --help` lists these. */
export function exitCodeFor(error: AutomationCommandError): number {
  if (error.uncertain) return 7;
  if (
    error.code.startsWith('cli.invalid_') &&
    error.code !== 'cli.invalid_response'
  )
    return 2;
  if (error.status === 401 || error.status === 403) return 3;
  if (error.status === 404) return 4;
  if (error.status === 409 || error.status === 412 || error.status === 428)
    return 5;
  if (error.status === 429 || error.status === 503) return 6;
  return 1;
}
