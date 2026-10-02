import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { CURATED_TEMPLATE_GATES } from '../testing/curated-template-gates.mjs';

export const REQUIRED_ORDINARY_CI_GATES = Object.freeze([
  'architecture:check',
  'built-exports:check',
  'quality:local:check',
]);

export const DELIBERATE_ORDINARY_CI_EXCLUSIONS = Object.freeze({
  'mutation:check': 'integration',
  'quality:local': null,
  'test:browser-probes': 'browser',
});

// The fast pre-push gate runs every static gate in check, but replaces these
// repository-wide steps with prepush:changed, scoped to the changed packages.
export const FAST_PRE_PUSH_SCOPED_GATES = Object.freeze([
  'lint',
  'test',
  'typecheck',
]);

const CURATED_TEMPLATE_JOB = 'curated-templates';
const CURATED_TEMPLATE_REPORTS_DIRECTORY =
  '$RUNNER_TEMP/curated-template-qualification';
const CURATED_TEMPLATE_UPLOAD_DIRECTORY =
  '${{ runner.temp }}/curated-template-qualification';
const CURATED_TEMPLATE_QUALIFICATION_COMMAND = `node infrastructure/testing/run-curated-template-qualification.mjs --reports-directory "${CURATED_TEMPLATE_REPORTS_DIRECTORY}"`;
const CURATED_TEMPLATE_DATABASE_URLS = Object.freeze({
  DATABASE_ADMIN_URL:
    'postgresql://postgres:pertexo-local-superuser@127.0.0.1:5432/postgres',
  DATABASE_MIGRATION_URL:
    'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo',
  DATABASE_API_URL:
    'postgresql://pertexo_api:pertexo-local-api@127.0.0.1:5432/pertexo',
  DATABASE_WORKER_URL:
    'postgresql://pertexo_worker:pertexo-local-worker@127.0.0.1:5432/pertexo',
  DATABASE_DISPATCHER_URL:
    'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@127.0.0.1:5432/pertexo',
  REDIS_URL: 'redis://:pertexo-local-redis@127.0.0.1:6379/0',
});

const SCRIPT_NAME = /^[a-z][a-z0-9:-]*$/u;

function fail(message) {
  throw new Error(`Ordinary CI gate policy is invalid: ${message}`);
}

function packageScripts(packageManifest) {
  const scripts = packageManifest?.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts))
    fail('package.json scripts are missing');
  return scripts;
}

function parsePnpmScriptSequence(value, label) {
  if (typeof value !== 'string' || value.length === 0)
    fail(`${label} is missing`);
  const segments = value.split(' && ');
  const names = segments.map((segment) => {
    const match = /^pnpm ([a-z][a-z0-9:-]*)$/u.exec(segment);
    if (match === null)
      fail(`${label} must be a sequence of named pnpm scripts`);
    return match[1];
  });
  return names;
}

function directPnpmScript(step) {
  if (typeof step?.run !== 'string') return null;
  const match = /^pnpm ([a-z][a-z0-9:-]*)$/u.exec(step.run.trim());
  return match?.[1] ?? null;
}

function workflowJobs(workflow) {
  const jobs = workflow?.jobs;
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs))
    fail('workflow jobs are missing');
  return jobs;
}

function jobSteps(jobs, name) {
  const steps = jobs[name]?.steps;
  if (!Array.isArray(steps)) fail(`${name} job steps are missing`);
  return steps;
}

function requireExactlyOnce(names, required, label) {
  for (const name of required) {
    const count = names.filter((candidate) => candidate === name).length;
    if (count !== 1)
      fail(
        `${label} must invoke ${name} exactly once; observed ${String(count)}`,
      );
  }
}

function normalizedShellCommand(value) {
  return typeof value === 'string'
    ? value
        .replaceAll(/\\\s*\n\s*/gu, ' ')
        .replaceAll(/\s+/gu, ' ')
        .trim()
    : '';
}

function requiredCuratedTemplateOwner(jobs) {
  const gateMinimums = CURATED_TEMPLATE_GATES.map(({ id, minimumTests }) => ({
    id,
    minimumTests,
  }));
  if (
    JSON.stringify(gateMinimums) !==
    JSON.stringify([
      { id: 'origin-guard', minimumTests: 2340 },
      { id: 'origin-boundary', minimumTests: 16 },
      { id: 'curated-browser', minimumTests: 1 },
      { id: 'compiled-cutover', minimumTests: 10 },
    ])
  )
    fail(
      'curated-template owner must retain all four exact no-skip gate minima',
    );
  const job = jobs[CURATED_TEMPLATE_JOB];
  if (job === undefined)
    fail('curated-template fixtures require one dedicated owner');
  if (job.if !== undefined || job['continue-on-error'] === true)
    fail('curated-template owner must be required');
  if (
    job.env?.COMPOSE_PROJECT_NAME !==
    'pertexo-ci-${{ github.run_id }}-${{ github.run_attempt }}-curated-templates'
  )
    fail('curated-template owner must use its unique Compose project');

  const steps = jobSteps(jobs, CURATED_TEMPLATE_JOB);
  const requiredStep = (predicate, message) => {
    const matches = steps.filter(predicate);
    if (matches.length !== 1) fail(message);
    const [step] = matches;
    if (step.if !== undefined || step['continue-on-error'] === true)
      fail(`${message}; the step must be required`);
    return step;
  };
  const checkout = requiredStep(
    (step) => step.uses?.startsWith('actions/checkout@'),
    'curated-template owner must check out source exactly once',
  );
  if (checkout.with?.['fetch-depth'] !== 0)
    fail('curated-template owner requires full Git history');
  const node = requiredStep(
    (step) => step.uses?.startsWith('actions/setup-node@'),
    'curated-template owner must set up Node exactly once',
  );
  if (node.with?.['node-version'] !== 24)
    fail('curated-template owner must use Node 24');
  const pnpm = requiredStep(
    (step) => step.uses?.startsWith('pnpm/action-setup@'),
    'curated-template owner must set up pnpm exactly once',
  );
  if (pnpm.with?.version !== '11.22.0')
    fail('curated-template owner must pin pnpm 11.22.0');
  requiredStep(
    (step) =>
      normalizedShellCommand(step.run) === 'pnpm install --frozen-lockfile',
    'curated-template owner must install the frozen dependency graph exactly once',
  );
  requiredStep(
    (step) => normalizedShellCommand(step.run) === 'pnpm build',
    'curated-template owner must build the workspace exactly once',
  );
  const browser = requiredStep(
    (step) =>
      normalizedShellCommand(step.run) ===
      'pnpm --filter @pertexo/web exec playwright install --with-deps chromium',
    'curated-template owner must install Playwright Chromium exactly once',
  );
  const start = requiredStep(
    (step) =>
      normalizedShellCommand(step.run) ===
      'docker compose up -d --wait postgres redis',
    'curated-template owner must create PostgreSQL and Redis exactly once',
  );
  const qualification = requiredStep(
    (step) =>
      normalizedShellCommand(step.run).endsWith(
        CURATED_TEMPLATE_QUALIFICATION_COMMAND,
      ),
    'curated-template owner must invoke the source-bound qualification command exactly once',
  );
  const preparation = requiredStep(
    (step) =>
      step.run?.includes(
        'node infrastructure/testing/prepare-curated-cutover-cache.mjs',
      ),
    'curated-template cache preparation must run exactly once',
  );
  if (steps.indexOf(preparation) >= steps.indexOf(qualification))
    fail('curated-template cache preparation must precede qualification');
  for (const witness of [
    'export PNPM_CONFIG_STORE_DIR="$(pnpm store path --silent)"',
    'export PNPM_CONFIG_CACHE_DIR="$RUNNER_TEMP/curated-cutover-pnpm-cache"',
    'PNPM_CONFIG_STORE_DIR=%s',
    'PNPM_CONFIG_CACHE_DIR=%s',
    '>> "$GITHUB_ENV"',
  ])
    if (!preparation.run.includes(witness))
      fail(
        'curated-template cache preparation must share explicit canonical store and task-owned metadata paths',
      );
  if (
    steps.indexOf(qualification) <= steps.indexOf(browser) ||
    steps.indexOf(qualification) <= steps.indexOf(start)
  )
    fail(
      'curated-template qualification must follow browser and service setup',
    );
  if (qualification.env?.EDITOR_BROWSER_OWNED_FIXTURE !== 'true')
    fail('curated-template owner must require the canonical owned fixture');
  for (const [name, value] of Object.entries(CURATED_TEMPLATE_DATABASE_URLS))
    if (qualification.env?.[name] !== value)
      fail(`curated-template owner must pin explicit ${name}`);
  const command = normalizedShellCommand(qualification.run);
  for (const witness of [
    'docker inspect --format',
    'docker compose ps -q postgres',
    'docker compose ps -q redis',
    'EDITOR_BROWSER_OWNERSHIP_MANIFEST',
    '127.0.0.1:$POSTGRES_PORT',
    '127.0.0.1:$REDIS_PORT',
    CURATED_TEMPLATE_QUALIFICATION_COMMAND,
  ])
    if (!command.includes(witness))
      fail(
        `curated-template owner is missing source or ownership witness: ${witness}`,
      );

  const cleanup = steps.filter(
    (step) =>
      step.if === 'always()' &&
      step['continue-on-error'] !== true &&
      normalizedShellCommand(step.run) ===
        'docker compose down -v --remove-orphans',
  );
  if (
    cleanup.length !== 1 ||
    steps.indexOf(cleanup[0]) <= steps.indexOf(qualification)
  )
    fail('curated-template owner must retain one required post-run cleanup');
  const upload = steps.filter(
    (step) =>
      step.if === 'always()' &&
      step['continue-on-error'] !== true &&
      step.uses?.startsWith('actions/upload-artifact@') &&
      step.with?.path === CURATED_TEMPLATE_UPLOAD_DIRECTORY &&
      step.with?.['if-no-files-found'] === 'error',
  );
  if (
    upload.length !== 1 ||
    steps.indexOf(upload[0]) <= steps.indexOf(qualification)
  )
    fail(
      'curated-template owner must upload the complete qualification directory',
    );
}

function requiredCuratedTemplateOrdinaryExclusions(jobs) {
  const steps = jobSteps(jobs, 'integration');
  const commandFor = (report) => {
    const output = `--outputFile=../../${report}`;
    const matches = steps
      .map((step) => normalizedShellCommand(step.run))
      .filter((command) => command.includes(output));
    if (matches.length !== 1)
      fail(`curated-template routing requires one ordinary ${report} owner`);
    return matches[0];
  };
  const exclusions = (command, packageName, report) => {
    const marker = `pnpm --filter ${packageName} exec vitest run`;
    const output = `--outputFile=../../${report}`;
    const end = command.indexOf(output);
    const start = command.lastIndexOf(marker, end);
    if (start < 0 || end < 0)
      fail(
        `curated-template routing cannot identify the ${packageName} command`,
      );
    return [
      ...command.slice(start, end).matchAll(/--exclude\s+([^\s]+)/gu),
    ].map((match) => match[1]);
  };
  const apiReport = 'artifacts/api-gates.json';
  const api = exclusions(commandFor(apiReport), '@pertexo/api', apiReport);
  const expectedApi = [
    'test/platform/compatibility-rollout.integration.test.ts',
    'test/editor-browser.integration.test.ts',
    'test/usage-browser.integration.test.ts',
    'test/workflow-concurrency-browser.integration.test.ts',
    'test/connection-health-browser.integration.test.ts',
    'test/curated-template-origin-guard.integration.test.ts',
  ];
  if (JSON.stringify(api) !== JSON.stringify(expectedApi))
    fail(
      'ordinary API integration must exclude only its dedicated opt-in owners',
    );
  const databaseReport = 'artifacts/database-gates.json';
  const database = exclusions(
    commandFor(databaseReport),
    '@pertexo/database',
    databaseReport,
  );
  if (
    JSON.stringify(database) !==
    JSON.stringify([
      'test/workflow-template-origin-boundary.integration.test.ts',
    ])
  )
    fail(
      'ordinary database integration must exclude only the curated origin boundary owner',
    );
}

export function validateCiGatePolicy({ packageManifest, workflow }) {
  const scripts = packageScripts(packageManifest);
  const jobs = workflowJobs(workflow);
  requiredCuratedTemplateOwner(jobs);
  requiredCuratedTemplateOrdinaryExclusions(jobs);
  for (const name of [
    'build',
    'check',
    'ci:gates:check',
    'mutation:check',
    'performance:local:check',
    'quality:local',
    'quality:local:check',
    'quality:local:contracts',
    'test:browser-probes',
    ...REQUIRED_ORDINARY_CI_GATES,
  ])
    if (!SCRIPT_NAME.test(name) || typeof scripts[name] !== 'string')
      fail(`required package script ${name} is missing`);
  if (
    scripts['mutation:check'] !==
    'node infrastructure/quality/verify-mutation-sensitivity.mjs'
  )
    fail('mutation:check must retain the local qualification implementation');

  const localCheck = parsePnpmScriptSequence(scripts.check, 'check script');
  requireExactlyOnce(
    localCheck,
    ['ci:gates:check', 'build', ...REQUIRED_ORDINARY_CI_GATES],
    'check script',
  );
  if (localCheck.indexOf('built-exports:check') <= localCheck.indexOf('build'))
    fail('check script must build before validating built exports');

  const localQualityCheck = parsePnpmScriptSequence(
    scripts['quality:local:check'],
    'quality:local:check script',
  );
  requireExactlyOnce(
    localQualityCheck,
    ['quality:local:contracts', 'performance:local:check'],
    'quality:local:check script',
  );

  const directByJob = new Map();
  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const direct = steps.map(directPnpmScript).filter((name) => name !== null);
    for (const name of direct)
      if (typeof scripts[name] !== 'string')
        fail(`${jobName} job invokes unknown package script ${name}`);
    directByJob.set(jobName, direct);
  }

  const qualitySteps = jobSteps(jobs, 'quality');
  const qualityScripts = qualitySteps
    .map(directPnpmScript)
    .filter((name) => name !== null);
  requireExactlyOnce(
    qualityScripts,
    ['ci:gates:check', 'build', ...REQUIRED_ORDINARY_CI_GATES],
    'quality job',
  );
  if (
    qualityScripts.indexOf('built-exports:check') <=
    qualityScripts.indexOf('build')
  )
    fail('quality job must build before validating built exports');

  for (const [excluded, owner] of Object.entries(
    DELIBERATE_ORDINARY_CI_EXCLUSIONS,
  )) {
    const owners = [...directByJob.entries()].flatMap(([jobName, names]) =>
      names.includes(excluded) ? [jobName] : [],
    );
    if (owner === null && owners.length !== 0)
      fail(`${excluded} must remain excluded from ordinary CI`);
    if (owner !== null && (owners.length !== 1 || owners[0] !== owner))
      fail(`${excluded} must be owned exactly once by the ${owner} job`);
  }

  const browserSteps = jobSteps(jobs, 'browser');
  if (
    browserSteps.filter(
      (step) => directPnpmScript(step) === 'test:browser-probes',
    ).length !== 1
  )
    fail('test:browser-probes must be owned exactly once by the browser job');
  const probeIndex = browserSteps.findIndex(
    (step) => directPnpmScript(step) === 'test:browser-probes',
  );
  const probe = browserSteps[probeIndex];
  if (probe?.if !== undefined || probe?.['continue-on-error'] === true)
    fail('browser probes must run unconditionally and fail the browser job');
  const installIndex = browserSteps.findIndex(
    (step) =>
      typeof step?.run === 'string' &&
      /^pnpm --filter @pertexo\/web exec playwright install --with-deps chromium(?:\s|$)/u.test(
        step.run.trim().replace(/\s+/gu, ' '),
      ),
  );
  if (installIndex < 0 || installIndex >= probeIndex)
    fail('browser probes must run after Playwright Chromium installation');
  if (
    browserSteps[installIndex]?.if !== undefined ||
    browserSteps[installIndex]?.['continue-on-error'] === true
  )
    fail('browser installation must be required before the probes');
  const prepush = parsePnpmScriptSequence(
    scripts['prepush:check'],
    'prepush:check script',
  );
  requireExactlyOnce(prepush, ['test:browser-probes'], 'prepush:check script');

  const fastPrepush = parsePnpmScriptSequence(
    scripts['prepush:fast'],
    'prepush:fast script',
  );
  requireExactlyOnce(
    fastPrepush,
    [
      ...localCheck.filter(
        (name) => !FAST_PRE_PUSH_SCOPED_GATES.includes(name),
      ),
      'prepush:changed',
    ],
    'prepush:fast script',
  );
  if (
    fastPrepush.indexOf('built-exports:check') <= fastPrepush.indexOf('build')
  )
    fail('prepush:fast script must build before validating built exports');

  return { requiredGates: [...REQUIRED_ORDINARY_CI_GATES] };
}

async function main() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const [packageText, workflowText] = await Promise.all([
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
  ]);
  const result = validateCiGatePolicy({
    packageManifest: JSON.parse(packageText),
    workflow: parseYaml(workflowText),
  });
  process.stdout.write(
    `Validated ${String(result.requiredGates.length)} required ordinary CI gates.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
