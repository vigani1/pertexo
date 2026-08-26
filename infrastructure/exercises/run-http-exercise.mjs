/* global AbortSignal, URL, fetch, process, setTimeout */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_DURATION_SECONDS = 1_800;
const MAX_REQUESTS_PER_SECOND = 1_000;
const MAX_IN_FLIGHT = 2_000;

function fail(message) {
  throw new Error(`Exercise configuration error: ${message}`);
}

function finiteNumber(value, name, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(`${name} must be finite`);
  if (value < minimum || value > maximum)
    fail(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function parseProfile(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('profile must be an object');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (
    typeof value.name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.name)
  )
    fail('name is invalid');
  if (value.method !== 'POST') fail('only POST exercises are supported');
  if (
    typeof value.pathEnvironment !== 'string' ||
    !/^PERTEXO_[A-Z0-9_]+$/u.test(value.pathEnvironment)
  )
    fail('pathEnvironment is invalid');
  if (
    typeof value.bodyFileEnvironment !== 'string' ||
    !/^PERTEXO_[A-Z0-9_]+$/u.test(value.bodyFileEnvironment)
  )
    fail('bodyFileEnvironment is invalid');
  const objectives = value.objectives;
  if (typeof objectives !== 'object' || objectives === null)
    fail('objectives are required');
  return Object.freeze({
    bodyFileEnvironment: value.bodyFileEnvironment,
    durationSeconds: finiteNumber(
      value.durationSeconds,
      'durationSeconds',
      1,
      MAX_DURATION_SECONDS,
    ),
    headers: value.headers ?? {},
    maxInFlight: finiteNumber(
      value.maxInFlight,
      'maxInFlight',
      1,
      MAX_IN_FLIGHT,
    ),
    method: value.method,
    name: value.name,
    objectives: {
      maximumP95Milliseconds: finiteNumber(
        objectives.maximumP95Milliseconds,
        'maximumP95Milliseconds',
        1,
        60_000,
      ),
      maximumServerErrorRatio: finiteNumber(
        objectives.maximumServerErrorRatio,
        'maximumServerErrorRatio',
        0,
        1,
      ),
      minimumAchievedRateRatio: finiteNumber(
        objectives.minimumAchievedRateRatio,
        'minimumAchievedRateRatio',
        0.01,
        1,
      ),
    },
    pathEnvironment: value.pathEnvironment,
    requestsPerSecond: finiteNumber(
      value.requestsPerSecond,
      'requestsPerSecond',
      1,
      MAX_REQUESTS_PER_SECOND,
    ),
    schemaVersion: 1,
  });
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function loadInputs(profilePath) {
  const profileBytes = await readFile(profilePath);
  const profile = parseProfile(JSON.parse(profileBytes.toString('utf8')));
  const baseUrl = process.env.PERTEXO_EXERCISE_BASE_URL;
  if (baseUrl === undefined) fail('PERTEXO_EXERCISE_BASE_URL is required');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    fail('base URL must use HTTP or HTTPS');
  const path = process.env[profile.pathEnvironment];
  if (path === undefined || !path.startsWith('/'))
    fail(`${profile.pathEnvironment} must be an absolute path`);
  const bodyFile = process.env[profile.bodyFileEnvironment];
  if (bodyFile === undefined)
    fail(`${profile.bodyFileEnvironment} is required`);
  const body = await readFile(resolve(bodyFile), 'utf8');
  JSON.parse(body);
  const authorization = process.env.PERTEXO_EXERCISE_AUTHORIZATION;
  if (authorization === undefined || authorization.length > 8_192)
    fail('PERTEXO_EXERCISE_AUTHORIZATION is required and bounded');
  return {
    authorization,
    body,
    profile,
    profileDigest: sha256(profileBytes),
    target: new URL(path, base),
  };
}

async function run(inputs) {
  const scheduled = Math.floor(
    inputs.profile.durationSeconds * inputs.profile.requestsPerSecond,
  );
  const intervalMilliseconds = 1_000 / inputs.profile.requestsPerSecond;
  const latencies = [];
  const statusClasses = {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    transport_error: 0,
  };
  let inFlight = 0;
  let skippedForConcurrency = 0;
  const pending = new Set();
  const startedAt = performance.now();

  for (let index = 0; index < scheduled; index += 1) {
    const dueAt = startedAt + index * intervalMilliseconds;
    const delay = dueAt - performance.now();
    if (delay > 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    if (inFlight >= inputs.profile.maxInFlight) {
      skippedForConcurrency += 1;
      continue;
    }
    inFlight += 1;
    const requestId = randomUUID();
    const requestStartedAt = performance.now();
    const operation = fetch(inputs.target, {
      body: inputs.body,
      headers: {
        ...Object.fromEntries(
          Object.entries(inputs.profile.headers).map(([name, value]) => [
            name,
            String(value).replaceAll('${requestId}', requestId),
          ]),
        ),
        authorization: inputs.authorization,
      },
      method: inputs.profile.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
      .then(async (response) => {
        await response.body?.cancel();
        statusClasses[`${Math.floor(response.status / 100)}xx`] += 1;
      })
      .catch(() => {
        statusClasses.transport_error += 1;
      })
      .finally(() => {
        latencies.push(performance.now() - requestStartedAt);
        inFlight -= 1;
        pending.delete(operation);
      });
    pending.add(operation);
  }
  await Promise.all(pending);
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  latencies.sort((left, right) => left - right);
  const completed = latencies.length;
  const serverFailures = statusClasses['5xx'] + statusClasses.transport_error;
  const achievedRequestsPerSecond = completed / elapsedSeconds;
  const achievedRateRatio =
    achievedRequestsPerSecond / inputs.profile.requestsPerSecond;
  const serverErrorRatio = completed === 0 ? 1 : serverFailures / completed;
  const p95Milliseconds = quantile(latencies, 0.95);
  const checks = {
    achievedRate:
      achievedRateRatio >= inputs.profile.objectives.minimumAchievedRateRatio,
    p95Latency:
      p95Milliseconds !== null &&
      p95Milliseconds <= inputs.profile.objectives.maximumP95Milliseconds,
    serverErrorRatio:
      serverErrorRatio <= inputs.profile.objectives.maximumServerErrorRatio,
  };
  return {
    achievedRateRatio,
    achievedRequestsPerSecond,
    bodyDigest: sha256(inputs.body),
    checks,
    completed,
    durationSeconds: elapsedSeconds,
    finishedAt: new Date().toISOString(),
    latencyMilliseconds: {
      p50: quantile(latencies, 0.5),
      p95: p95Milliseconds,
      p99: quantile(latencies, 0.99),
    },
    passed: Object.values(checks).every(Boolean),
    profileDigest: inputs.profileDigest,
    profileName: inputs.profile.name,
    scheduled,
    schemaVersion: 1,
    serverErrorRatio,
    skippedForConcurrency,
    startedAt: new Date(Date.now() - elapsedSeconds * 1_000).toISOString(),
    statusClasses,
    target: {
      origin: inputs.target.origin,
      pathDigest: sha256(inputs.target.pathname),
    },
  };
}

async function main() {
  const profilePath = process.argv[2];
  const outputPath = process.argv[3];
  if (profilePath === undefined || outputPath === undefined)
    fail('usage: run-http-exercise.mjs PROFILE OUTPUT');
  const evidence = await run(await loadInputs(resolve(profilePath)));
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(
    resolve(outputPath),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    `${evidence.passed ? 'PASS' : 'FAIL'} ${evidence.profileName}: ${evidence.completed}/${evidence.scheduled}, p95=${String(evidence.latencyMilliseconds.p95)}ms\n`,
  );
  if (!evidence.passed) process.exitCode = 1;
}

await main();
