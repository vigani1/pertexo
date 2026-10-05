import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';
import {
  CI_QUALITY_SCRIPTS,
  parseCiQualityArguments,
} from '../quality/run-ci-quality.mjs';
import { CURATED_TEMPLATE_GATES } from '../testing/curated-template-gates.mjs';
import { WORKFLOW_ORGANIZATION_GATES } from '../testing/workflow-organization-gates.mjs';

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
const WORKFLOW_ORGANIZATION_JOB = 'workflow-organization-qualification';
const WORKFLOW_ORGANIZATION_REPORTS_DIRECTORY =
  '$RUNNER_TEMP/workflow-organization-qualification';
const WORKFLOW_ORGANIZATION_UPLOAD_DIRECTORY =
  '${{ runner.temp }}/workflow-organization-qualification';
const WORKFLOW_ORGANIZATION_QUALIFICATION_COMMAND = `node infrastructure/testing/run-workflow-organization-qualification.mjs --reports-directory "${WORKFLOW_ORGANIZATION_REPORTS_DIRECTORY}"`;
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

function ciStepScripts(step) {
  const direct = directPnpmScript(step);
  if (direct !== null) return [direct];
  const command = normalizedShellCommand(step?.run);
  const runner = 'node infrastructure/quality/run-ci-quality.mjs';
  if (!command.includes(runner)) return [];
  const prefix = `set -o pipefail mkdir -p artifacts ${runner} `;
  const suffix = ' 2>&1 | tee artifacts/quality.log';
  if (!command.startsWith(prefix) || !command.endsWith(suffix))
    fail(
      'joined quality command must retain its exact fail-closed log pipeline',
    );
  if (
    step.if !== undefined ||
    (step['continue-on-error'] !== undefined &&
      step['continue-on-error'] !== false)
  )
    fail('joined quality gates must be unconditional and fail closed');
  try {
    return parseCiQualityArguments(
      command.slice(prefix.length, -suffix.length).split(' '),
    ).flat();
  } catch {
    fail('joined quality command must name every original gate exactly once');
  }
}

function requiredQualityOwner(workflow, job, steps) {
  if (
    job.if !== undefined ||
    job.needs !== undefined ||
    job.strategy !== undefined ||
    (job['continue-on-error'] !== undefined &&
      job['continue-on-error'] !== false)
  )
    fail(
      'quality job must be one unconditional fail-closed owner without needs',
    );
  const requireRootBash = (configuration) => {
    if (configuration?.shell !== undefined && configuration.shell !== 'bash')
      fail('quality owner must use the default or literal bash shell');
    if (
      configuration?.['working-directory'] !== undefined &&
      configuration['working-directory'] !== '.'
    )
      fail('quality owner must execute required gates at the repository root');
  };
  requireRootBash(workflow.defaults?.run);
  requireRootBash(job.defaults?.run);
  const direct = new Set([
    'ci:gates:check',
    'build',
    'architecture:check',
    'built-exports:check',
  ]);
  for (const step of steps) {
    requireRootBash(step);
    if (typeof step.run !== 'string') continue;
    const command = normalizedShellCommand(step.run);
    const upstream = command === 'pnpm network-registry:check-upstream';
    if (upstream) {
      if (step.if !== "github.event_name == 'schedule'")
        fail('upstream registry comparison must remain schedule-only');
    } else if (step.if !== undefined)
      fail('required quality steps must be unconditional');
    if (
      step['continue-on-error'] !== undefined &&
      step['continue-on-error'] !== false
    )
      fail('required quality steps must fail closed');
    if (
      command === 'pnpm install --frozen-lockfile' ||
      upstream ||
      direct.has(directPnpmScript(step))
    )
      continue;
    if (command.includes('node infrastructure/quality/run-ci-quality.mjs')) {
      ciStepScripts(step);
      continue;
    }
    fail('quality owner cannot contain opaque or additional gate commands');
  }
}

function requiredFailClosedCommand(step, expectedCommand, label) {
  const lines = step.run
    .trim()
    .split('\n')
    .map((line) => line.trim());
  if (lines[0] !== 'set -euo pipefail' || lines.at(-1) !== expectedCommand)
    fail(`${label} must fail closed and invoke its exact command`);
}

export const INLINE_CALL_HTTP_COMMAND =
  'node --test --test-reporter=./infrastructure/testing/inline-workflow-call-gate-reporter.mjs infrastructure/testing/inline-workflow-call-http.integration.test.mjs';
export const INLINE_CALL_HTTP_VALIDATE_COMMAND =
  'node infrastructure/coverage/validate-vitest-gate-report.mjs "$INLINE_WORKFLOW_CALL_GATE_REPORT" \'Registered inline Call HTTP qualification\' 1';

function requiredInlineCallHttpOwner(workflow, jobs) {
  const name = 'inline-workflow-call-http';
  const job = jobs[name];
  if (
    !job ||
    job.if !== undefined ||
    job.needs !== undefined ||
    job.strategy !== undefined ||
    job['continue-on-error'] !== undefined ||
    job['timeout-minutes'] !== 15
  )
    fail(
      'inline Call HTTP owner must be unconditional, fail closed and bounded to 15 minutes',
    );
  if (
    job.env?.COMPOSE_PROJECT_NAME !==
      'pertexo-ci-${{ github.run_id }}-${{ github.run_attempt }}-inline-workflow-call-http' ||
    job.env?.INLINE_WORKFLOW_CALL_HTTP_INTEGRATION !== 'true' ||
    job.env?.INLINE_WORKFLOW_CALL_GATE_REPORT !== undefined
  )
    fail(
      'inline Call HTTP owner must retain its dynamic project and mandatory flag without a job-level runner report',
    );
  const steps = jobSteps(jobs, name);
  const required = (command) => {
    const matches = steps.filter(
      (step) => normalizedShellCommand(step.run) === command,
    );
    if (
      matches.length !== 1 ||
      matches[0].if !== undefined ||
      matches[0]['continue-on-error'] !== undefined
    )
      fail(`inline Call HTTP owner must require exactly one ${command}`);
    return steps.indexOf(matches[0]);
  };
  const install = required('pnpm install --frozen-lockfile');
  const build = required('pnpm build');
  const start = required(
    'docker compose up -d --wait --wait-timeout 120 postgres redis',
  );
  const command = [
    'set -euo pipefail',
    'mkdir -p "$RUNNER_TEMP/inline-workflow-call-http"',
    'test "$(docker compose port postgres 5432)" = "127.0.0.1:$POSTGRES_PORT"',
    'test "$(docker compose port redis 6379)" = "127.0.0.1:$REDIS_PORT"',
    INLINE_CALL_HTTP_COMMAND,
    INLINE_CALL_HTTP_VALIDATE_COMMAND,
  ].join(' ');
  const qualification = required(command);
  if (!(install < build && build < start && start < qualification))
    fail(
      'inline Call HTTP qualification must follow frozen installation, build and bounded services',
    );
  const selected = steps[qualification];
  if (
    selected.env?.INLINE_WORKFLOW_CALL_GATE_REPORT !==
    '${{ runner.temp }}/inline-workflow-call-http/report.json'
  )
    fail(
      'inline Call HTTP qualification must own its exact runner report path',
    );
  for (const [key, value] of Object.entries({
    ...CURATED_TEMPLATE_DATABASE_URLS,
    DATABASE_OPERATOR_URL:
      'postgresql://pertexo_operator:pertexo-local-operator@127.0.0.1:5432/pertexo',
  }))
    if (
      (selected.env?.[key] ?? job.env?.[key] ?? workflow.env?.[key]) !== value
    )
      fail(`inline Call HTTP owner must use standard ${key}`);
  const cleanup = steps.filter(
    (step) =>
      step.if === 'always()' &&
      step['continue-on-error'] === undefined &&
      normalizedShellCommand(step.run) ===
        'timeout 120 docker compose down -v --remove-orphans',
  );
  const upload = steps.filter(
    (step) =>
      step.if === 'always()' &&
      step['continue-on-error'] === undefined &&
      step.uses?.startsWith('actions/upload-artifact@') &&
      step.with?.path === '${{ runner.temp }}/inline-workflow-call-http' &&
      step.with?.['if-no-files-found'] === 'error',
  );
  if (
    cleanup.length !== 1 ||
    upload.length !== 1 ||
    steps.indexOf(cleanup[0]) <= qualification ||
    steps.indexOf(upload[0]) <= qualification
  )
    fail(
      'inline Call HTTP owner must retain bounded always-cleanup and required report upload',
    );
}

function requiredWorkflowOrganizationFixture(qualification, command) {
  if (
    qualification.env?.DATABASE_MAINTENANCE_URL !==
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@127.0.0.1:5432/pertexo'
  )
    fail(
      'workflow-organization owner must pin explicit DATABASE_MAINTENANCE_URL',
    );
  requiredFailClosedCommand(
    qualification,
    WORKFLOW_ORGANIZATION_QUALIFICATION_COMMAND,
    'workflow-organization qualification',
  );
  if (!command.includes('export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn'))
    fail(
      'workflow-organization owner must construct its explicit JSON ownership manifest',
    );
  for (const witness of [
    'postgres_id=$(docker inspect --format \'{{.Id}}\' "$(docker compose ps -q postgres)")',
    'redis_id=$(docker inspect --format \'{{.Id}}\' "$(docker compose ps -q redis)")',
    'test "$(docker compose port postgres 5432)" = "127.0.0.1:$POSTGRES_PORT"',
    'test "$(docker compose port redis 6379)" = "127.0.0.1:$REDIS_PORT"',
    '--arg project "$COMPOSE_PROJECT_NAME" --arg postgres "$postgres_id" --arg redis "$redis_id"',
    '--argjson postgresPort "$POSTGRES_PORT" --argjson redisPort "$REDIS_PORT"',
    "'{project:$project,postgres:{id:$postgres,port:$postgresPort},redis:{id:$redis,port:$redisPort}}'",
  ])
    if (!command.includes(witness))
      fail(
        `workflow-organization owner is missing exact fixture witness: ${witness}`,
      );
}

function requiredFeatureQualificationOwner(jobs, profile) {
  const gateMinimums = profile.gates.map(({ id, minimumTests }) => ({
    id,
    minimumTests,
  }));
  if (JSON.stringify(gateMinimums) !== JSON.stringify(profile.counts))
    fail(
      `${profile.label} owner must retain all four exact no-skip gate minima`,
    );
  const job = jobs[profile.job];
  if (job === undefined)
    fail(`${profile.label} fixtures require one dedicated owner`);
  if (job.if !== undefined || job['continue-on-error'] === true)
    fail(`${profile.label} owner must be required`);
  if (
    job.env?.COMPOSE_PROJECT_NAME !==
    'pertexo-ci-${{ github.run_id }}-${{ github.run_attempt }}-' + profile.job
  )
    fail(`${profile.label} owner must use its unique Compose project`);

  const steps = jobSteps(jobs, profile.job);
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
    `${profile.label} owner must check out source exactly once`,
  );
  if (checkout.with?.['fetch-depth'] !== 0)
    fail(`${profile.label} owner requires full Git history`);
  const node = requiredStep(
    (step) => step.uses?.startsWith('actions/setup-node@'),
    `${profile.label} owner must set up Node exactly once`,
  );
  if (node.with?.['node-version'] !== 24)
    fail(`${profile.label} owner must use Node 24`);
  const pnpm = requiredStep(
    (step) => step.uses?.startsWith('pnpm/action-setup@'),
    `${profile.label} owner must set up pnpm exactly once`,
  );
  if (pnpm.with?.version !== '11.22.0')
    fail(`${profile.label} owner must pin pnpm 11.22.0`);
  requiredStep(
    (step) =>
      normalizedShellCommand(step.run) === 'pnpm install --frozen-lockfile',
    `${profile.label} owner must install the frozen dependency graph exactly once`,
  );
  const build = requiredStep(
    (step) => normalizedShellCommand(step.run) === 'pnpm build',
    `${profile.label} owner must build the workspace exactly once`,
  );
  const browser = requiredStep(
    (step) =>
      normalizedShellCommand(step.run) ===
      'pnpm --filter @pertexo/web exec playwright install --with-deps chromium',
    `${profile.label} owner must install Playwright Chromium exactly once`,
  );
  const start = requiredStep(
    (step) =>
      normalizedShellCommand(step.run) ===
      'docker compose up -d --wait postgres redis',
    `${profile.label} owner must create PostgreSQL and Redis exactly once`,
  );
  const qualification = requiredStep(
    (step) => normalizedShellCommand(step.run).endsWith(profile.command),
    `${profile.label} owner must invoke the source-bound qualification command exactly once`,
  );
  const preparation = requiredStep(
    (step) =>
      step.run?.includes(
        'node infrastructure/testing/prepare-curated-cutover-cache.mjs',
      ),
    `${profile.label} cache preparation must run exactly once`,
  );
  if (steps.indexOf(preparation) >= steps.indexOf(qualification))
    fail(`${profile.label} cache preparation must precede qualification`);
  if (profile.job === WORKFLOW_ORGANIZATION_JOB)
    requiredFailClosedCommand(
      preparation,
      'node infrastructure/testing/prepare-curated-cutover-cache.mjs',
      'workflow-organization cache preparation',
    );
  for (const witness of [
    'export PNPM_CONFIG_STORE_DIR="$(pnpm store path --silent)"',
    'export PNPM_CONFIG_CACHE_DIR="$RUNNER_TEMP/curated-cutover-pnpm-cache"',
    'PNPM_CONFIG_STORE_DIR=%s',
    'PNPM_CONFIG_CACHE_DIR=%s',
    '>> "$GITHUB_ENV"',
  ])
    if (!preparation.run.includes(witness))
      fail(
        `${profile.label} cache preparation must share explicit canonical store and task-owned metadata paths`,
      );
  if (
    steps.indexOf(qualification) <= steps.indexOf(build) ||
    steps.indexOf(qualification) <= steps.indexOf(browser) ||
    steps.indexOf(qualification) <= steps.indexOf(start)
  )
    fail(
      `${profile.label} qualification must follow browser and service setup`,
    );
  if (qualification.env?.EDITOR_BROWSER_OWNED_FIXTURE !== 'true')
    fail(`${profile.label} owner must require the canonical owned fixture`);
  for (const [name, value] of Object.entries(CURATED_TEMPLATE_DATABASE_URLS))
    if (qualification.env?.[name] !== value)
      fail(`${profile.label} owner must pin explicit ${name}`);
  const command = normalizedShellCommand(qualification.run);
  if (profile.job === WORKFLOW_ORGANIZATION_JOB)
    requiredWorkflowOrganizationFixture(qualification, command);
  for (const witness of [
    'docker inspect --format',
    'docker compose ps -q postgres',
    'docker compose ps -q redis',
    'EDITOR_BROWSER_OWNERSHIP_MANIFEST',
    '127.0.0.1:$POSTGRES_PORT',
    '127.0.0.1:$REDIS_PORT',
    profile.command,
  ])
    if (!command.includes(witness))
      fail(
        `${profile.label} owner is missing source or ownership witness: ${witness}`,
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
    fail(`${profile.label} owner must retain one required post-run cleanup`);
  const upload = steps.filter(
    (step) =>
      step.if === 'always()' &&
      step['continue-on-error'] !== true &&
      step.uses?.startsWith('actions/upload-artifact@') &&
      step.with?.path === profile.uploadDirectory &&
      step.with?.['if-no-files-found'] === 'error',
  );
  if (
    upload.length !== 1 ||
    steps.indexOf(upload[0]) <= steps.indexOf(qualification)
  )
    fail(
      `${profile.label} owner must upload the complete qualification directory`,
    );
}

function ownedOrganizationTestFiles(...ids) {
  return WORKFLOW_ORGANIZATION_GATES.filter((gate) =>
    ids.includes(gate.id),
  ).flatMap((gate) =>
    gate.command.filter((argument) => argument.startsWith('test/')),
  );
}

function requiredOrdinaryDraftFixtureOwner(step, command) {
  if (
    step.env?.EDITOR_BROWSER_OWNED_FIXTURE !== 'true' ||
    step.if !== undefined ||
    step['continue-on-error'] === true
  )
    fail(
      'ordinary draft integration must require unconditional owned fixtures',
    );
  const manifest = 'export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn';
  if (!command.startsWith('set -euo pipefail ') || !command.includes(manifest))
    fail(
      'ordinary draft integration must fail closed and construct its manifest',
    );
  for (const witness of [
    'postgres_id=$(docker inspect --format \'{{.Id}}\' "$(docker compose ps -q postgres)")',
    'redis_id=$(docker inspect --format \'{{.Id}}\' "$(docker compose ps -q redis)")',
    '--arg project "$COMPOSE_PROJECT_NAME" --arg postgres "$postgres_id" --arg redis "$redis_id"',
    '--argjson postgresPort "$POSTGRES_PORT" --argjson redisPort "$REDIS_PORT"',
    "'{project:$project,postgres:{id:$postgres,port:$postgresPort},redis:{id:$redis,port:$redisPort}}'",
  ])
    if (!command.includes(witness))
      fail('ordinary draft integration is missing its exact fixture witness');
  if (command.indexOf(manifest) > command.indexOf('pnpm --filter'))
    fail('ordinary draft integration must attest ownership before its suites');
}

function requiredFeatureOrdinaryExclusions(jobs) {
  const steps = jobSteps(jobs, 'integration');
  const commandFor = (report) => {
    const output = `--outputFile=../../${report}`;
    const matches = steps.filter((step) =>
      normalizedShellCommand(step.run).includes(output),
    );
    if (matches.length !== 1)
      fail(`curated-template routing requires one ordinary ${report} owner`);
    const command = normalizedShellCommand(matches[0].run);
    requiredOrdinaryDraftFixtureOwner(matches[0], command);
    return command;
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
    ...ownedOrganizationTestFiles('organization-api', 'organization-browser'),
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
      ...ownedOrganizationTestFiles('organization-database'),
    ])
  )
    fail(
      'ordinary database integration must exclude only its dedicated opt-in owners',
    );
}

export function validateCiGatePolicy({ packageManifest, workflow }) {
  const scripts = packageScripts(packageManifest);
  const jobs = workflowJobs(workflow);
  requiredInlineCallHttpOwner(workflow, jobs);
  requiredFeatureQualificationOwner(jobs, {
    job: CURATED_TEMPLATE_JOB,
    label: 'curated-template',
    gates: CURATED_TEMPLATE_GATES,
    counts: [
      { id: 'origin-guard', minimumTests: 2340 },
      { id: 'origin-boundary', minimumTests: 16 },
      { id: 'curated-browser', minimumTests: 1 },
      { id: 'compiled-cutover', minimumTests: 10 },
    ],
    command: CURATED_TEMPLATE_QUALIFICATION_COMMAND,
    uploadDirectory: CURATED_TEMPLATE_UPLOAD_DIRECTORY,
  });
  requiredFeatureQualificationOwner(jobs, {
    job: WORKFLOW_ORGANIZATION_JOB,
    label: 'workflow-organization',
    gates: WORKFLOW_ORGANIZATION_GATES,
    counts: [
      { id: 'organization-database', minimumTests: 95 },
      { id: 'organization-api', minimumTests: 20 },
      { id: 'organization-process', minimumTests: 6 },
      { id: 'organization-browser', minimumTests: 4 },
    ],
    command: WORKFLOW_ORGANIZATION_QUALIFICATION_COMMAND,
    uploadDirectory: WORKFLOW_ORGANIZATION_UPLOAD_DIRECTORY,
  });
  requiredFeatureOrdinaryExclusions(jobs);
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
    ...CI_QUALITY_SCRIPTS,
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
    const direct = steps.flatMap(ciStepScripts);
    for (const name of direct)
      if (typeof scripts[name] !== 'string')
        fail(`${jobName} job invokes unknown package script ${name}`);
    directByJob.set(jobName, direct);
  }

  const qualitySteps = jobSteps(jobs, 'quality');
  const qualityScripts = qualitySteps.flatMap(ciStepScripts);
  if (jobs.quality['timeout-minutes'] !== 15)
    fail('quality job must retain its 15-minute deadline');
  requireExactlyOnce(
    qualityScripts,
    [
      'ci:gates:check',
      'build',
      ...REQUIRED_ORDINARY_CI_GATES,
      ...CI_QUALITY_SCRIPTS,
    ],
    'quality job',
  );
  if (
    qualityScripts.indexOf('built-exports:check') <=
    qualityScripts.indexOf('build')
  )
    fail('quality job must build before validating built exports');
  for (const name of [...CI_QUALITY_SCRIPTS, ...REQUIRED_ORDINARY_CI_GATES]) {
    if (qualityScripts.indexOf(name) <= qualityScripts.indexOf('build'))
      fail(`quality job must build before ${name}`);
    const step = qualitySteps.find((candidate) =>
      ciStepScripts(candidate).includes(name),
    );
    if (
      step.if !== undefined ||
      (step['continue-on-error'] !== undefined &&
        step['continue-on-error'] !== false)
    )
      fail(`quality gate ${name} must run unconditionally and fail closed`);
  }
  const joinedIndex = qualitySteps.findIndex((step) =>
    normalizedShellCommand(step.run).includes(
      'node infrastructure/quality/run-ci-quality.mjs',
    ),
  );
  if (
    qualitySteps.filter((step) =>
      normalizedShellCommand(step.run).includes(
        'node infrastructure/quality/run-ci-quality.mjs',
      ),
    ).length !== 1
  )
    fail('quality job must retain exactly one literal joined runner');
  for (const name of ['architecture:check', 'built-exports:check'])
    if (
      qualitySteps.findIndex((step) => directPnpmScript(step) === name) <=
      joinedIndex
    )
      fail(`quality job must join both lanes before ${name}`);
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
  requiredQualityOwner(workflow, jobs.quality, qualitySteps);

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
