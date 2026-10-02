type Environment = Readonly<Record<string, string | undefined>>;

/** Only the fixture owner may substitute default-OFF browser presentation. */
export function ownedBrowserQualificationBuild(
  mode: string,
  env: Environment,
  expected: Readonly<{ mode: string; scenario: string }>,
): boolean {
  if (mode !== expected.mode) return false;
  if (
    env.EDITOR_BROWSER_INTEGRATION !== 'true' ||
    env.EDITOR_BROWSER_CASE !== expected.scenario ||
    env.EDITOR_BROWSER_OWNED_FIXTURE !== 'true'
  )
    throw new Error(
      'Qualification build requires its explicitly owned browser fixture',
    );
  const manifest: unknown = JSON.parse(
    env.EDITOR_BROWSER_OWNERSHIP_MANIFEST ?? 'null',
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('project' in manifest) ||
    typeof manifest.project !== 'string' ||
    !/^pertexo-[a-z0-9-]+$/u.test(manifest.project)
  )
    throw new Error(
      'Qualification build requires the approved ownership manifest',
    );
  for (const name of ['PERTEXO_API_PROXY_TARGET', 'PERTEXO_LIVE_MAIL_ORIGIN']) {
    const origin = new URL(env[name] ?? '');
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.port === '' ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== ''
    )
      throw new Error(
        'Qualification build requires explicit loopback fixture origins',
      );
  }
  return true;
}
