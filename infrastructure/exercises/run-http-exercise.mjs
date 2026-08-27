/* global AbortSignal, Buffer, URL, fetch, process, setTimeout */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_DURATION_SECONDS = 1_800;
const MAX_REQUESTS_PER_SECOND = 1_000;
const MAX_IN_FLIGHT = 2_000;
const MAX_PROBLEM_BYTES = 16_384;
const ENVIRONMENT_NAME = /^PERTEXO_[A-Z0-9_]+$/u;
const PROBLEM_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

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

function environmentName(value, name) {
  if (typeof value !== 'string' || !ENVIRONMENT_NAME.test(value))
    fail(`${name} is invalid`);
  return value;
}

function parseResponsePolicy(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('responsePolicy is required');
  if (
    Object.keys(value).some(
      (key) => !['expectedProblemCodes', 'expectedStatuses'].includes(key),
    )
  )
    fail('responsePolicy contains an unknown field');
  if (
    !Array.isArray(value.expectedStatuses) ||
    value.expectedStatuses.length < 1 ||
    value.expectedStatuses.length > 20 ||
    value.expectedStatuses.some(
      (status) => !Number.isInteger(status) || status < 200 || status > 599,
    ) ||
    new Set(value.expectedStatuses).size !== value.expectedStatuses.length
  )
    fail('responsePolicy.expectedStatuses is invalid');
  if (
    value.expectedStatuses.includes(401) ||
    value.expectedStatuses.includes(403)
  )
    fail('authentication and authorization failures cannot be expected');
  if (
    !Array.isArray(value.expectedProblemCodes) ||
    value.expectedProblemCodes.length > 20 ||
    value.expectedProblemCodes.some(
      (code) =>
        typeof code !== 'string' ||
        code.length > 128 ||
        !PROBLEM_CODE.test(code),
    ) ||
    new Set(value.expectedProblemCodes).size !==
      value.expectedProblemCodes.length
  )
    fail('responsePolicy.expectedProblemCodes is invalid');
  if (
    value.expectedStatuses.includes(429) &&
    !value.expectedProblemCodes.some((code) => code.endsWith('.rate_limited'))
  )
    fail('status 429 requires an expected rate-limit problem code');
  return Object.freeze({
    expectedProblemCodes: Object.freeze([...value.expectedProblemCodes]),
    expectedStatuses: Object.freeze([...value.expectedStatuses]),
  });
}

export function parseProfile(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('profile must be an object');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  const allowedKeys = new Set([
    'authentication',
    'bodyFileEnvironment',
    'durationSeconds',
    'headers',
    'maxInFlight',
    'method',
    'name',
    'objectives',
    'pathEnvironment',
    'requestsPerSecond',
    'responsePolicy',
    'scenario',
    'schemaVersion',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    fail('profile contains an unknown field');
  if (
    typeof value.name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.name)
  )
    fail('name is invalid');
  if (value.method !== 'POST') fail('only POST exercises are supported');
  if (!['session-cookie', 'webhook-hmac'].includes(value.authentication))
    fail('authentication must be session-cookie or webhook-hmac');
  if (
    typeof value.scenario !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.scenario)
  )
    fail('scenario is invalid');
  if (
    typeof value.headers !== 'object' ||
    value.headers === null ||
    Array.isArray(value.headers) ||
    Object.entries(value.headers).some(
      ([name, headerValue]) =>
        !/^[a-z0-9-]{1,64}$/u.test(name) ||
        /authorization|cookie|csrf|signature|token|secret/iu.test(name) ||
        typeof headerValue !== 'string' ||
        headerValue.length > 1_024 ||
        /\$\{(?!requestId\})/u.test(headerValue),
    )
  )
    fail('headers are invalid or contain authentication material');
  const objectives = value.objectives;
  if (typeof objectives !== 'object' || objectives === null)
    fail('objectives are required');
  if (
    Object.keys(objectives).some(
      (key) =>
        ![
          'maximumP95Milliseconds',
          'maximumServerErrorRatio',
          'minimumAchievedRateRatio',
        ].includes(key),
    )
  )
    fail('objectives contains an unknown field');
  return Object.freeze({
    authentication: value.authentication,
    bodyFileEnvironment: environmentName(
      value.bodyFileEnvironment,
      'bodyFileEnvironment',
    ),
    durationSeconds: finiteNumber(
      value.durationSeconds,
      'durationSeconds',
      1,
      MAX_DURATION_SECONDS,
    ),
    headers: Object.freeze({ ...value.headers }),
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
    pathEnvironment: environmentName(value.pathEnvironment, 'pathEnvironment'),
    requestsPerSecond: finiteNumber(
      value.requestsPerSecond,
      'requestsPerSecond',
      1,
      MAX_REQUESTS_PER_SECOND,
    ),
    responsePolicy: parseResponsePolicy(value.responsePolicy),
    scenario: value.scenario,
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

function requiredSecret(environment, name) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 8_192 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    fail(`${name} is required and bounded`);
  return value;
}

export function loadAuthentication(authentication, environment = process.env) {
  if (authentication === 'session-cookie') {
    return Object.freeze({
      kind: authentication,
      csrfToken: requiredSecret(environment, 'PERTEXO_EXERCISE_CSRF_TOKEN'),
      sessionToken: requiredSecret(
        environment,
        'PERTEXO_EXERCISE_SESSION_COOKIE',
      ),
    });
  }
  if (authentication !== 'webhook-hmac') fail('authentication is invalid');
  const encoded = requiredSecret(
    environment,
    'PERTEXO_EXERCISE_WEBHOOK_SIGNING_SECRET',
  );
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.byteLength !== 32 || secret.toString('base64url') !== encoded)
    fail(
      'PERTEXO_EXERCISE_WEBHOOK_SIGNING_SECRET must be a canonical 32-byte base64url value',
    );
  return Object.freeze({ kind: authentication, secret });
}

export function requestAuthenticationHeaders(
  authentication,
  body,
  now = Date.now(),
) {
  if (authentication.kind === 'session-cookie') {
    return {
      cookie: `pertexo_session=${encodeURIComponent(authentication.sessionToken)}; pertexo_csrf=${encodeURIComponent(authentication.csrfToken)}`,
      'x-csrf-token': authentication.csrfToken,
    };
  }
  const timestamp = String(Math.floor(now / 1_000));
  const signature = createHmac('sha256', authentication.secret)
    .update(timestamp, 'ascii')
    .update('.')
    .update(body)
    .digest('hex');
  return {
    'x-pertexo-signature': `v1=${signature}`,
    'x-pertexo-timestamp': timestamp,
  };
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
  return {
    authentication: loadAuthentication(profile.authentication),
    body,
    profile,
    profileDigest: sha256(profileBytes),
    target: new URL(path, base),
  };
}

async function problemCode(response) {
  if (
    !response.headers.get('content-type')?.includes('application/problem+json')
  )
    return undefined;
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks = [];
  let bytes = 0;
  while (bytes <= MAX_PROBLEM_BYTES) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    chunks.push(result.value);
  }
  await reader.cancel();
  if (bytes > MAX_PROBLEM_BYTES) return undefined;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof value?.code === 'string' &&
      value.code.length <= 128 &&
      PROBLEM_CODE.test(value.code)
      ? value.code
      : undefined;
  } catch {
    return undefined;
  }
}

export function responseMatchesPolicy(status, code, policy) {
  if (!policy.expectedStatuses.includes(status)) return false;
  if (status < 400) return true;
  return code !== undefined && policy.expectedProblemCodes.includes(code);
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
  const statusCodes = {};
  const problemCodes = {};
  let unexpectedResponses = 0;
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
        ...requestAuthenticationHeaders(inputs.authentication, inputs.body),
      },
      method: inputs.profile.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
      .then(async (response) => {
        statusClasses[`${Math.floor(response.status / 100)}xx`] += 1;
        statusCodes[response.status] = (statusCodes[response.status] ?? 0) + 1;
        const code =
          response.status >= 400 ? await problemCode(response) : undefined;
        if (code !== undefined) {
          const evidenceCode =
            inputs.profile.responsePolicy.expectedProblemCodes.includes(code)
              ? code
              : 'unexpected';
          problemCodes[evidenceCode] = (problemCodes[evidenceCode] ?? 0) + 1;
        }
        if (
          !responseMatchesPolicy(
            response.status,
            code,
            inputs.profile.responsePolicy,
          )
        )
          unexpectedResponses += 1;
        if (response.body?.locked !== true) await response.body?.cancel();
      })
      .catch(() => {
        statusClasses.transport_error += 1;
        unexpectedResponses += 1;
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
    responsePolicy: unexpectedResponses === 0,
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
    problemCodes,
    profileDigest: inputs.profileDigest,
    profileName: inputs.profile.name,
    scheduled,
    schemaVersion: 1,
    serverErrorRatio,
    skippedForConcurrency,
    startedAt: new Date(Date.now() - elapsedSeconds * 1_000).toISOString(),
    statusClasses,
    statusCodes,
    target: {
      origin: inputs.target.origin,
      pathDigest: sha256(inputs.target.pathname),
    },
    unexpectedResponses,
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

if (import.meta.main) await main();
