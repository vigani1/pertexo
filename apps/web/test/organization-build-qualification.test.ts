import { describe, expect, it } from 'vitest';
import { ownedBrowserQualificationBuild } from './support/owned-browser-build-qualification';

const expected = {
  mode: 'workflow-organization-qualification',
  scenario: 'workflow-organization',
};
const owned = {
  EDITOR_BROWSER_INTEGRATION: 'true',
  EDITOR_BROWSER_CASE: expected.scenario,
  EDITOR_BROWSER_OWNED_FIXTURE: 'true',
  EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify({
    project: 'pertexo-f07-owned-qualification',
  }),
  PERTEXO_API_PROXY_TARGET: 'http://127.0.0.1:45231',
  PERTEXO_LIVE_MAIL_ORIGIN: 'http://127.0.0.1:45232',
};
describe('owned organization build substitution', () => {
  it('accepts only this explicit scenario and mode', () => {
    expect(ownedBrowserQualificationBuild(expected.mode, owned, expected)).toBe(
      true,
    );
    for (const mode of [
      'production',
      'development',
      'test',
      'curated-template-qualification',
    ])
      expect(ownedBrowserQualificationBuild(mode, owned, expected)).toBe(false);
    expect(() =>
      ownedBrowserQualificationBuild(
        expected.mode,
        { ...owned, EDITOR_BROWSER_CASE: 'curated-templates' },
        expected,
      ),
    ).toThrow();
  });
  it.each(Object.keys(owned))('requires explicit %s', (key) => {
    expect(() =>
      ownedBrowserQualificationBuild(
        expected.mode,
        { ...owned, [key]: undefined },
        expected,
      ),
    ).toThrow();
  });
  it('rejects a remote target and malformed ownership manifest', () => {
    expect(() =>
      ownedBrowserQualificationBuild(
        expected.mode,
        { ...owned, PERTEXO_API_PROXY_TARGET: 'https://example.test' },
        expected,
      ),
    ).toThrow();
    expect(() =>
      ownedBrowserQualificationBuild(
        expected.mode,
        { ...owned, EDITOR_BROWSER_OWNERSHIP_MANIFEST: '{}' },
        expected,
      ),
    ).toThrow();
  });
});
