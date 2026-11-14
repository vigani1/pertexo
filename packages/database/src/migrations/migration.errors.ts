/** Names the file that stopped a migration, so a failed deploy has a reason. */
export class MigrationFileFailedError extends Error {
  public override readonly name = 'MigrationFileFailedError';

  public constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(
      `Migration ${file} failed: ${cause instanceof Error ? cause.message : 'no reason given'}`,
      { cause },
    );
  }
}
