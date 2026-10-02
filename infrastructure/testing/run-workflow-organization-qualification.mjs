#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  WORKFLOW_ORGANIZATION_GATES,
  assertWorkflowOrganizationQualification,
  validateWorkflowOrganizationQualificationDirectory,
} from './workflow-organization-gates.mjs';
import { runOwnedFeatureQualification } from './owned-feature-qualification.mjs';

export async function runWorkflowOrganizationQualification(
  directory,
  environment = process.env,
) {
  return runOwnedFeatureQualification(
    directory,
    {
      gates: WORKFLOW_ORGANIZATION_GATES,
      assert: assertWorkflowOrganizationQualification,
      validateDirectory: validateWorkflowOrganizationQualificationDirectory,
      sourceEnvironment: (source) => ({
        F07_PROCESS_COMPATIBLE_SOURCE: source.head,
      }),
    },
    environment,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [option, directory, ...extra] = process.argv.slice(2);
  if (option !== '--reports-directory' || !directory || extra.length)
    throw new Error(
      'usage: run-workflow-organization-qualification.mjs --reports-directory <fresh-absolute-directory>',
    );
  await runWorkflowOrganizationQualification(directory);
}
