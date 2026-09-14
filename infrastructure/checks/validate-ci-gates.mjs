import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

export const REQUIRED_ORDINARY_CI_GATES = Object.freeze([
  'architecture:check',
  'built-exports:check',
  'quality:local:check',
]);

export const DELIBERATE_ORDINARY_CI_EXCLUSIONS = Object.freeze({
  'mutation:check': 'integration',
  'quality:local': null,
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

export function validateCiGatePolicy({ packageManifest, workflow }) {
  const scripts = packageScripts(packageManifest);
  const jobs = workflowJobs(workflow);
  for (const name of [
    'build',
    'check',
    'ci:gates:check',
    'mutation:check',
    'performance:local:check',
    'quality:local',
    'quality:local:check',
    'quality:local:contracts',
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
