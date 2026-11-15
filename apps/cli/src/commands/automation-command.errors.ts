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

/** The CLI's exit codes; `pertexo --help` lists them. */
const EXIT_CODE = Object.freeze({
  failed: 1,
  usage: 2,
  refused: 3,
  notFound: 4,
  conflict: 5,
  busy: 6,
  uncertain: 7,
});

/** So a script can branch without reading the JSON. */
export function exitCodeFor(error: AutomationCommandError): number {
  if (error.uncertain) return EXIT_CODE.uncertain;
  if (
    error.code.startsWith('cli.invalid_') &&
    error.code !== 'cli.invalid_response'
  )
    return EXIT_CODE.usage;
  if (error.status === 401 || error.status === 403) return EXIT_CODE.refused;
  if (error.status === 404) return EXIT_CODE.notFound;
  if (error.status === 409 || error.status === 412 || error.status === 428)
    return EXIT_CODE.conflict;
  if (error.status === 429 || error.status === 503) return EXIT_CODE.busy;
  return EXIT_CODE.failed;
}
