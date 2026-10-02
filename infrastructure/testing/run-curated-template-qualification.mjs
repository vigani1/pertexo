#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  CURATED_TEMPLATE_GATES,
  assertCuratedQualification,
  validateCuratedQualificationDirectory,
} from './curated-template-gates.mjs';
import { runOwnedFeatureQualification } from './owned-feature-qualification.mjs';

export async function runCuratedTemplateQualification(
  directory,
  environment = process.env,
) {
  return runOwnedFeatureQualification(
    directory,
    {
      gates: CURATED_TEMPLATE_GATES,
      assert: assertCuratedQualification,
      validateDirectory: validateCuratedQualificationDirectory,
      sourceEnvironment: (source) => ({
        F06_CUTOVER_COMPATIBLE_SOURCE: source.head,
      }),
    },
    environment,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [option, directory, ...extra] = process.argv.slice(2);
  if (option !== '--reports-directory' || !directory || extra.length)
    throw new Error(
      'usage: run-curated-template-qualification.mjs --reports-directory <fresh-absolute-directory>',
    );
  await runCuratedTemplateQualification(directory);
}
