import process from 'node:process';

// Git hooks export repository/index/config overrides. A subprocess targeting
// an explicit repository must not inherit the caller's Git metadata or identity.
export function isolatedGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}
