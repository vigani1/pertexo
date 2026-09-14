import process from 'node:process';

// Git hooks export repository/index/config overrides. A subprocess targeting
// an explicit repository must not inherit the caller's Git metadata or identity.
export function isolatedGitEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')),
  );
}
