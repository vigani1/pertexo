import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { copyIn, sources } from './source-copy';

// Who may do something comes from the role policy (whoCan, ADMINISTRATORS),
// so copy can't drift from what the server allows. A list of two or more
// role names written into a string or JSX text is a copy of that policy.
const ROLE = String.raw`(?:owners?|admins?|builders?|operators?|viewers?)`;
const WRITTEN_ROLE_LIST = new RegExp(
  String.raw`\b${ROLE}(?:,\s${ROLE})*,?\s(?:and|or)\s${ROLE}\b`,
  'giu',
);
// The policy's own words, where the lists are made.
const OWNER = 'features/workspaces/model/workspace-roles.ts';
// A fact about two roles, not a list of who may act.
const NOT_POLICY: readonly string[] = [
  'features/federation/components/directory/mappings.tsx: Builder and operator',
];

it('names who may act through the role policy, not as written role lists', () => {
  const root = join(import.meta.dirname, '../../src');
  const found = sources(root)
    .filter((path) => relative(root, path) !== OWNER)
    .flatMap((path) =>
      copyIn(path).flatMap((text) =>
        [...text.matchAll(WRITTEN_ROLE_LIST)].map(
          ([phrase]) => `${relative(root, path)}: ${phrase}`,
        ),
      ),
    );
  expect(found).toEqual(NOT_POLICY);
});
