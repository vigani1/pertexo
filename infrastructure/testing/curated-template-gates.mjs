import {
  createOwnedQualificationEvidence,
  ownedVitestCommand as vitest,
} from './owned-qualification-evidence.mjs';
export const CURATED_TEMPLATE_GATES = Object.freeze(
  [
    {
      id: 'origin-guard',
      minimumTests: 2340,
      command: vitest(
        '@pertexo/api',
        'test/curated-template-origin-guard.integration.test.ts',
      ),
      environment: { F06_ORIGIN_GUARD_OWNED_FIXTURE: 'true' },
    },
    {
      id: 'origin-boundary',
      minimumTests: 16,
      command: vitest(
        '@pertexo/database',
        'test/workflow-template-origin-boundary.integration.test.ts',
      ),
      environment: { F06_ORIGIN_BOUNDARY_OWNED_FIXTURE: 'true' },
    },
    {
      id: 'curated-browser',
      minimumTests: 1,
      command: vitest(
        '@pertexo/api',
        'test/editor-browser.integration.test.ts',
      ),
      environment: {
        EDITOR_BROWSER_INTEGRATION: 'true',
        EDITOR_BROWSER_CASE: 'curated-templates',
      },
    },
    {
      id: 'compiled-cutover',
      minimumTests: 10,
      command: [
        'node',
        '--test',
        '--test-reporter=./infrastructure/testing/curated-cutover-gate-reporter.mjs',
        'infrastructure/testing/curated-cutover.integration.test.mjs',
      ],
      environment: { F06_CUTOVER_OWNED_FIXTURE: 'true' },
    },
  ].map((gate) =>
    Object.freeze({
      ...gate,
      command: Object.freeze(gate.command),
      environment: Object.freeze(gate.environment),
    }),
  ),
);

const evidence = createOwnedQualificationEvidence({
  gates: CURATED_TEMPLATE_GATES,
  label: 'Curated',
});
export function assertCuratedQualification(manifest) {
  return evidence.assertQualification(manifest);
}

export async function validateCuratedQualificationDirectory(
  directory,
  expectedSource,
) {
  return evidence.validateDirectory(directory, expectedSource);
}
