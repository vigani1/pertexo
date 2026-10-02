import {
  createOwnedQualificationEvidence,
  ownedVitestCommand,
} from './owned-qualification-evidence.mjs';

export const WORKFLOW_ORGANIZATION_GATES = Object.freeze(
  [
    {
      id: 'organization-database',
      minimumTests: 95,
      command: ownedVitestCommand(
        '@pertexo/database',
        'test/workflow-organization.integration.test.ts',
        'test/workflow-organization-read.integration.test.ts',
        'test/workflow-organization-readiness.integration.test.ts',
        'test/workflow-organization-maintenance-plans.integration.test.ts',
        'test/workflow-folders-batch.integration.test.ts',
        'test/workflow-organization-adapters.integration.test.ts',
        'test/workflow-tags.integration.test.ts',
      ),
      environment: { F07_ORGANIZATION_OWNED_FIXTURE: 'true' },
    },
    {
      id: 'organization-api',
      minimumTests: 20,
      command: ownedVitestCommand(
        '@pertexo/api',
        'test/workflow-authoring/organization.integration.test.ts',
        'test/workflow-authoring/favorite-persistence.integration.test.ts',
        'test/workflow-authoring/folders-bulk.integration.test.ts',
      ),
      environment: { F07_ORGANIZATION_OWNED_FIXTURE: 'true' },
    },
    {
      id: 'organization-process',
      minimumTests: 6,
      command: [
        'node',
        '--test',
        '--test-reporter=./infrastructure/testing/curated-cutover-gate-reporter.mjs',
        'infrastructure/testing/organization-process.integration.test.mjs',
        'infrastructure/testing/organization-process-owner.test.mjs',
      ],
      environment: { F07_PROCESS_OWNED_QUALIFICATION: 'true' },
    },
    {
      id: 'organization-browser',
      minimumTests: 4,
      command: ownedVitestCommand(
        '@pertexo/api',
        'test/workflow-organization-browser.integration.test.ts',
      ),
      environment: {
        F07_ORGANIZATION_OWNED_FIXTURE: 'true',
        F07_ORGANIZATION_BROWSER_INTEGRATION: 'true',
      },
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
  gates: WORKFLOW_ORGANIZATION_GATES,
  label: 'Workflow organization',
  exactTests: true,
});
export function assertWorkflowOrganizationQualification(manifest) {
  return evidence.assertQualification(manifest);
}
export async function validateWorkflowOrganizationQualificationDirectory(
  directory,
  expectedSource,
) {
  return evidence.validateDirectory(directory, expectedSource);
}
