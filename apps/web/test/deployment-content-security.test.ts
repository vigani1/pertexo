// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const template = await readFile(
  new URL('../deployment/nginx.conf.template', import.meta.url),
  'utf8',
);

function policiesIn(block: string): string[] {
  return [
    ...block.matchAll(/add_header Content-Security-Policy "([^"]+)" always;/gu),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function directive(policy: string, name: string): string[] | undefined {
  return policy
    .split(';')
    .map((part) => part.trim().split(/\s+/u))
    .find((parts) => parts[0] === name)
    ?.slice(1);
}

function location(start: string): string {
  const from = template.indexOf(start);
  return template.slice(from, template.indexOf('\n  }', from));
}

/** nginx drops inherited add_header lines in any block that sets its own. */
const EFFECTIVE = {
  'the app': location('location / {'),
  'the bundled assets': location('location /assets/'),
  'what falls through': template.slice(template.lastIndexOf('\n  }')),
};

describe('the policy the production web server sends', () => {
  // sec-04: frame-ancestors alone lets any injected script run.
  it.fails.each(Object.entries(EFFECTIVE))(
    'blocks script that did not ship with the app on %s',
    (_name, block) => {
      const [policy] = policiesIn(block);
      expect(policy).toBeDefined();
      const scripts =
        directive(policy ?? '', 'script-src') ??
        directive(policy ?? '', 'default-src');
      expect(scripts).toContain("'self'");
      expect(scripts).not.toContain("'unsafe-inline'");
      expect(scripts).not.toContain("'unsafe-eval'");
      expect(scripts).not.toContain('*');
      expect(directive(policy ?? '', 'object-src')).toEqual(["'none'"]);
      expect(directive(policy ?? '', 'base-uri')).toBeDefined();
      expect(directive(policy ?? '', 'frame-ancestors')).toEqual(["'none'"]);
    },
  );
});
