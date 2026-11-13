/**
 * Where the app sends people for help: the public guides in Pertexo's
 * repository, read on GitHub, so an install needs nothing hosted. A test
 * checks every path here exists in `docs/`.
 */
const REPOSITORY = 'https://github.com/vigani1/pertexo/blob/main/';

export const GUIDE_PATHS = Object.freeze({
  firstWorkflow: 'docs/guides/getting-started.md',
  allGuides: 'docs/guides/README.md',
  glossary: 'CONTEXT.md',
});

export const HELP_LINKS = Object.freeze({
  firstWorkflow: `${REPOSITORY}${GUIDE_PATHS.firstWorkflow}`,
  allGuides: `${REPOSITORY}${GUIDE_PATHS.allGuides}`,
  glossary: `${REPOSITORY}${GUIDE_PATHS.glossary}#core-terms`,
});

// The guide that explains a step type, by its exact definition key, then
// by the start of the key for whole families.
const STEP_GUIDES: Readonly<Record<string, string>> = Object.freeze({
  'core.approval': 'approvals',
  'core.request_input': 'forms',
  'core.form': 'forms',
  'core.webhook': 'webhooks',
  'core.respond_webhook': 'webhook-responses',
  'core.foreach': 'for-each',
  'core.code': 'code',
  'core.create_file': 'files',
  'core.read_file': 'files',
  'core.run_values': 'run-values',
  'core.workflow_error': 'error-workflows',
  'core.wait': 'callbacks',
  'core.set': 'data-transforms',
  'core.filter': 'data-transforms',
  'core.sort': 'data-transforms',
  'core.summarize': 'data-transforms',
  'core.unique': 'data-transforms',
  'core.take': 'data-transforms',
  'core.concat': 'data-transforms',
  'http.request': 'http-requests',
});
const FAMILY_GUIDES: readonly (readonly [prefix: string, guide: string])[] = [
  ['core.table_', 'data-tables'],
  ['email.', 'email'],
  ['slack.', 'connections'],
];

/** The repository path of the guide for a step type, if it has one. */
export function stepGuidePath(definitionKey: string): string | undefined {
  const guide =
    STEP_GUIDES[definitionKey] ??
    FAMILY_GUIDES.find(([prefix]) => definitionKey.startsWith(prefix))?.[1];
  return guide === undefined ? undefined : `docs/guides/${guide}.md`;
}

/** The guide for a step type, on GitHub, if it has one. */
export function stepGuideLink(definitionKey: string): string | undefined {
  const path = stepGuidePath(definitionKey);
  return path === undefined ? undefined : `${REPOSITORY}${path}`;
}
