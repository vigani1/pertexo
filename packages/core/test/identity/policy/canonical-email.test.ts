import { describe, expect, it } from 'vitest';

import { canonicalEmail } from '../../src/index.js';

describe('canonicalEmail', () => {
  it.each([
    ['A.Person@Example.TEST', 'a.person@example.test'],
    ['  person@example.test\t', 'person@example.test'],
    ['ｐｅｒｓｏｎ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'person@example.test'],
    [' ＰＥＲＳＯＮ＠example.test ', 'person@example.test'],
  ])('reads %j as %j', (value, expected) => {
    expect(canonicalEmail(value)).toBe(expected);
  });
});
