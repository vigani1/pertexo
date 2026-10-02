import { describe, expect, it } from 'vitest';
import { curatedTemplateQualificationBuild } from './support/curated-template-build-qualification';

const owned = {
  EDITOR_BROWSER_INTEGRATION: 'true',
  EDITOR_BROWSER_CASE: 'curated-templates',
  EDITOR_BROWSER_OWNED_FIXTURE: 'true',
  EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify({
    project: 'pertexo-f06-owned-qualification',
  }),
  PERTEXO_API_PROXY_TARGET: 'http://127.0.0.1:45231',
  PERTEXO_LIVE_MAIL_ORIGIN: 'http://127.0.0.1:45232',
};

describe('Owned curated-template build substitution', () => {
  it.each(['production', 'development', 'test'])(
    'keeps %s default gates regardless of environment',
    (mode) => {
      expect(curatedTemplateQualificationBuild(mode, owned)).toBe(false);
    },
  );
  it('permits only the explicit owned scenario and qualification mode', () => {
    expect(
      curatedTemplateQualificationBuild(
        'curated-template-qualification',
        owned,
      ),
    ).toBe(true);
  });
  it.each(Object.keys(owned))('fails closed without %s', (key) => {
    expect(() =>
      curatedTemplateQualificationBuild('curated-template-qualification', {
        ...owned,
        [key]: undefined,
      }),
    ).toThrow();
  });
  it.each([
    'https://127.0.0.1:45231',
    'http://example.test:45231',
    'http://127.0.0.1:45231/path',
    'http://user@127.0.0.1:45231',
    'http://127.0.0.1:45231/?token=x',
  ])('rejects non-owned origin %s', (origin) => {
    expect(() =>
      curatedTemplateQualificationBuild('curated-template-qualification', {
        ...owned,
        PERTEXO_API_PROXY_TARGET: origin,
      }),
    ).toThrow();
  });
});
