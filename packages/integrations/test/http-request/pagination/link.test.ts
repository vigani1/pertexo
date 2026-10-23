import { describe, expect, it } from 'vitest';

import { nextLink } from '../../../src/http-request/pagination/link.js';

describe('bounded Link next relation', () => {
  it('respects quoted commas, escapes and relative URI commas', () => {
    expect(
      nextLink(
        '</items?q=a,b>; title="an escaped \\" quote, here"; rel="prev next", </last>; rel=last',
        1,
      ),
    ).toBe('/items?q=a,b');
  });
  it('ignores links with a different context and non-next relations', () => {
    expect(
      nextLink('</next>; rel=next; anchor="/other", </last>; rel=last', 1),
    ).toBeUndefined();
  });
  it('does not choose an arbitrary target when next links conflict', () => {
    expect(() => nextLink('</a>; rel=next, </b>; rel=next', 1)).toThrow();
  });
});
