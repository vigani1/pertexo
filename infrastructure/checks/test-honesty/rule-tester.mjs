import { describe, it } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';

import { repositoryRoot } from './ratchet.mjs';

// Rule tests run in Oxlint's own plugin runtime, with file names resolved
// from the repository root as the real lint resolves them.
RuleTester.describe = describe;
RuleTester.it = it;

export const tester = new RuleTester({ cwd: repositoryRoot });

/** A ratchet case: `count` violations in `code`, against an allowance. */
export function ratchetCases({ code, filename, count, options = {} }) {
  const allow = (n) => [{ ...options, allow: { [filename]: n } }];
  return {
    valid: [
      {
        name: 'its exact allowance passes',
        code,
        filename,
        options: allow(count),
      },
    ],
    invalid: [
      {
        name: 'an allowance above the count asks to be lowered',
        code,
        filename,
        options: allow(count + 1),
        errors: [{ messageId: 'stale', data: { count: String(count) } }],
      },
      {
        name: 'one violation over the allowance reports them all',
        code,
        filename,
        options: count > 1 ? allow(count - 1) : [options],
        errors: count,
      },
    ],
  };
}
