import { describe, expect, it } from 'vitest';

import { canonicalEmail } from '../../../src/identity/email-policy.js';

describe('canonicalEmail', () => {
  it.each([
    ['A.Person@Example.TEST', 'a.person@example.test'],
    ['  person@example.test\t', 'person@example.test'],
    ['ｐｅｒｓｏｎ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'person@example.test'],
    [' ＰＥＲＳＯＮ＠example.test ', 'person@example.test'],
    ['  𝐀@EXAMPLE.TEST  ', 'a@example.test'],
    ['  ¨USER@EXAMPLE.TEST  ', ' \u0308user@example.test'],
  ])('reads %j as %j', (value, expected) => {
    expect(canonicalEmail(value)).toBe(expected);
  });
});
