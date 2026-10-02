import { ownedBrowserQualificationBuild } from './owned-browser-build-qualification';

/** Build-time attestation only: no values become browser environment variables. */
export function curatedTemplateQualificationBuild(
  mode: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return ownedBrowserQualificationBuild(mode, env, {
    mode: 'curated-template-qualification',
    scenario: 'curated-templates',
  });
}
