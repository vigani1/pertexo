export type CuratedOwnedFixture = Readonly<{
  project: string;
  postgresId: string;
  redisId: string;
  postgresPort: number;
  redisPort: number;
  adminUrl: string;
  migrationUrl: string;
  apiUrl: string;
  workerUrl: string;
  dispatcherUrl: string;
  redisUrl: string;
}>;
export function verifyCuratedFixtureOwnership(
  environment?: Readonly<Record<string, string | undefined>>,
  inspect?: (id: string) => Promise<string>,
): Promise<CuratedOwnedFixture>;
export function curatedDatabaseUrl(base: string, name: string): string;
export function curatedRedisUrl(base: string, database: number): string;
export function recheckCuratedFixtureOwnership(
  expected: CuratedOwnedFixture,
  environment?: Readonly<Record<string, string | undefined>>,
  inspect?: (id: string) => Promise<string>,
): Promise<void>;
