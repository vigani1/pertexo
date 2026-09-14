import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_DURATION_SECONDS = 1_800;
const MAX_REQUESTS_PER_SECOND = 1_000;
const MAX_IN_FLIGHT = 2_000;
const MAX_PROBLEM_BYTES = 16_384;
const MAX_EXPECTED_STATUS_COUNT = 20;
const MAX_EXPECTED_PROBLEM_CODE_COUNT = 20;
const MAX_PROBLEM_CODE_LENGTH = 128;
const MAX_HEADER_NAME_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 1_024;
const MINIMUM_SECRET_LENGTH = 16;
const MAXIMUM_SECRET_LENGTH = 8_192;
const RESPONSE_DEADLINE_MILLISECONDS = 30_000;
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

function safeInteger(value, name, minimum, maximum) {
  const parsed = finiteNumber(value, name, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) fail(`${name} must be a safe integer`);
  return parsed;
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
    value.expectedStatuses.length > MAX_EXPECTED_STATUS_COUNT ||
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
    value.expectedProblemCodes.length > MAX_EXPECTED_PROBLEM_CODE_COUNT ||
    value.expectedProblemCodes.some(
      (code) =>
        typeof code !== 'string' ||
        code.length > MAX_PROBLEM_CODE_LENGTH ||
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

function validHeaderValue(value) {
  if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_LENGTH)
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code !== 9 && (code < 32 || code > 126)) return false;
  }
  return !/\$\{(?!requestId\})/u.test(value);
}

function assertProfileHeaders(headers) {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers))
    fail('headers are invalid or contain authentication material');
  for (const [name, value] of Object.entries(headers)) {
    const nameIsSafe =
      name.length >= 1 &&
      name.length <= MAX_HEADER_NAME_LENGTH &&
      /^[a-z0-9-]+$/u.test(name) &&
      !/authorization|cookie|csrf|signature|token|secret/iu.test(name);
    if (!nameIsSafe || !validHeaderValue(value))
      fail('headers are invalid or contain authentication material');
  }
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
  assertProfileHeaders(value.headers);
  const objectives = value.objectives;
  if (
    typeof objectives !== 'object' ||
    objectives === null ||
    Array.isArray(objectives)
  )
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
    // Fractional rates and durations intentionally retain floor(rate * duration).
    durationSeconds: finiteNumber(
      value.durationSeconds,
      'durationSeconds',
      1,
      MAX_DURATION_SECONDS,
    ),
    headers: Object.freeze({ ...value.headers }),
    maxInFlight: safeInteger(
      value.maxInFlight,
      'maxInFlight',
      1,
      MAX_IN_FLIGHT,
    ),
    method: value.method,
    name: value.name,
    objectives: Object.freeze({
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
    }),
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
    value.length < MINIMUM_SECRET_LENGTH ||
    value.length > MAXIMUM_SECRET_LENGTH ||
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

export function resolveExerciseTarget(baseUrl, path) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol))
    fail('base URL must use HTTP or HTTPS');
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\')
  )
    fail('target must be an absolute same-origin path');
  const target = new URL(path, base);
  if (target.origin !== base.origin)
    fail('target must be an absolute same-origin path');
  return target;
}

export async function loadExerciseInputs(
  profilePath,
  environment = process.env,
) {
  const profileBytes = await readFile(profilePath);
  const profile = parseProfile(JSON.parse(profileBytes.toString('utf8')));
  const baseUrl = environment.PERTEXO_EXERCISE_BASE_URL;
  if (baseUrl === undefined) fail('PERTEXO_EXERCISE_BASE_URL is required');
  const target = resolveExerciseTarget(
    baseUrl,
    environment[profile.pathEnvironment],
  );
  const bodyFile = environment[profile.bodyFileEnvironment];
  if (bodyFile === undefined)
    fail(`${profile.bodyFileEnvironment} is required`);
  const body = await readFile(resolve(bodyFile), 'utf8');
  JSON.parse(body);
  return Object.freeze({
    authentication: loadAuthentication(profile.authentication, environment),
    body,
    profile,
    profileDigest: sha256(profileBytes),
    target,
  });
}

function evidenceBytes(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

async function removeOwnedFile(path, unlinkFile = unlink) {
  try {
    await unlinkFile(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function reserveEvidenceDestination(
  outputPath,
  startedEvidence,
  filesystem = { mkdir, open, rename, unlink },
) {
  const path = resolve(outputPath);
  await filesystem.mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await filesystem.open(path, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(evidenceBytes(startedEvidence));
    await handle.sync();
  } catch (error) {
    try {
      await handle?.close();
    } finally {
      if (handle !== undefined) await removeOwnedFile(path, filesystem.unlink);
    }
    throw error;
  }
  await handle.close();

  let finalized = false;
  return Object.freeze({
    path,
    async finalize(evidence) {
      if (finalized) throw new Error('Exercise evidence is already finalized');
      const temporaryPath = resolve(
        dirname(path),
        `.${basename(path)}.${startedEvidence.runId}.finalizing`,
      );
      let temporary;
      try {
        temporary = await filesystem.open(temporaryPath, 'wx', 0o600);
        await temporary.chmod(0o600);
        await temporary.writeFile(evidenceBytes(evidence));
        await temporary.sync();
        await temporary.close();
        temporary = undefined;
        await filesystem.rename(temporaryPath, path);
        finalized = true;
      } catch (error) {
        try {
          await temporary?.close();
        } finally {
          await removeOwnedFile(temporaryPath, filesystem.unlink);
        }
        throw error;
      }
    },
  });
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    let timeout;
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolveSleep();
    };
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      rejectSleep(signal?.reason);
    };
    timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
  });
}

function createRuntime(overrides = {}) {
  return {
    createDeadlineSignal:
      overrides.createDeadlineSignal ??
      ((signal) =>
        AbortSignal.any([
          signal,
          AbortSignal.timeout(RESPONSE_DEADLINE_MILLISECONDS),
        ])),
    fetch: overrides.fetch ?? fetch,
    monotonicNow: overrides.monotonicNow ?? (() => performance.now()),
    randomUUID: overrides.randomUUID ?? randomUUID,
    sleep: overrides.sleep ?? defaultSleep,
    wallNow: overrides.wallNow ?? (() => Date.now()),
  };
}

async function readProblemCode(response) {
  if (
    !response.headers.get('content-type')?.includes('application/problem+json')
  ) {
    try {
      await response.body?.cancel();
      return { code: undefined, diagnostic: undefined };
    } catch {
      return { code: undefined, diagnostic: 'body_cancel_error' };
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined)
    return { code: undefined, diagnostic: 'body_unavailable' };
  const chunks = [];
  let bytes = 0;
  let diagnostic;
  try {
    while (bytes <= MAX_PROBLEM_BYTES) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes <= MAX_PROBLEM_BYTES) chunks.push(result.value);
    }
    if (bytes > MAX_PROBLEM_BYTES) diagnostic = 'body_too_large';
  } catch {
    diagnostic = 'body_read_error';
  }
  try {
    await reader.cancel();
  } catch {
    diagnostic ??= 'body_cancel_error';
  }
  if (diagnostic !== undefined) return { code: undefined, diagnostic };
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const code =
      typeof value?.code === 'string' &&
      value.code.length <= MAX_PROBLEM_CODE_LENGTH &&
      PROBLEM_CODE.test(value.code)
        ? value.code
        : undefined;
    return {
      code,
      diagnostic: code === undefined ? 'body_invalid' : undefined,
    };
  } catch {
    return { code: undefined, diagnostic: 'body_invalid' };
  }
}

export function responseMatchesPolicy(status, code, policy) {
  if (!policy.expectedStatuses.includes(status)) return false;
  if (status < 400) return true;
  return code !== undefined && policy.expectedProblemCodes.includes(code);
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function publicRunIdentity(inputs, runId, startedWallTime) {
  return {
    bodyDigest: sha256(inputs.body),
    profileDigest: inputs.profileDigest,
    profileName: inputs.profile.name,
    runId,
    schemaVersion: 2,
    startedAt: new Date(startedWallTime).toISOString(),
    target: {
      origin: inputs.target.origin,
      pathDigest: sha256(inputs.target.pathname),
    },
  };
}

function summarizeRun(state, inputs, identity, elapsedMilliseconds) {
  state.latencies.sort((left, right) => left - right);
  const completed = state.latencies.length;
  const elapsedSeconds = elapsedMilliseconds / 1_000;
  const achievedRequestsPerSecond =
    elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
  const achievedRateRatio =
    achievedRequestsPerSecond / inputs.profile.requestsPerSecond;
  const serverFailures =
    state.statusClasses['5xx'] + state.statusClasses.transport_error;
  const serverErrorRatio = completed === 0 ? 1 : serverFailures / completed;
  const p95Milliseconds = quantile(state.latencies, 0.95);
  const checks = {
    achievedRate:
      achievedRateRatio >= inputs.profile.objectives.minimumAchievedRateRatio,
    p95Latency:
      p95Milliseconds !== null &&
      p95Milliseconds <= inputs.profile.objectives.maximumP95Milliseconds,
    responsePolicy: state.unexpectedResponses === 0,
    serverErrorRatio:
      serverErrorRatio <= inputs.profile.objectives.maximumServerErrorRatio,
  };
  const interrupted = state.interruption !== undefined;
  return {
    ...identity.public,
    achievedRateRatio,
    achievedRequestsPerSecond,
    attempted: completed,
    bodyDiagnostics: state.bodyDiagnostics,
    checks,
    completed,
    durationSeconds: elapsedSeconds,
    finishedAt: new Date(
      identity.startedWallTime + elapsedMilliseconds,
    ).toISOString(),
    interruption: state.interruption,
    latencyMilliseconds: {
      p50: quantile(state.latencies, 0.5),
      p95: p95Milliseconds,
      p99: quantile(state.latencies, 0.99),
    },
    operatorCleanupRequired: interrupted,
    passed: !interrupted && Object.values(checks).every(Boolean),
    problemCodes: state.problemCodes,
    scheduled: state.scheduled,
    schemaVersion: 2,
    serverErrorRatio,
    skippedForConcurrency: state.skippedForConcurrency,
    skippedForScheduleDelay: state.skippedForScheduleDelay,
    status: interrupted ? 'interrupted' : 'completed',
    statusClasses: state.statusClasses,
    statusCodes: state.statusCodes,
    unexpectedResponses: state.unexpectedResponses,
  };
}

async function performAttempt(inputs, runtime, signal, state) {
  const requestId = runtime.randomUUID();
  const requestStartedAt = runtime.monotonicNow();
  try {
    const response = await runtime.fetch(inputs.target, {
      body: inputs.body,
      headers: {
        ...Object.fromEntries(
          Object.entries(inputs.profile.headers).map(([name, value]) => [
            name,
            value.replaceAll('${requestId}', requestId),
          ]),
        ),
        ...requestAuthenticationHeaders(
          inputs.authentication,
          inputs.body,
          runtime.wallNow(),
        ),
      },
      method: inputs.profile.method,
      redirect: 'manual',
      signal: runtime.createDeadlineSignal(signal),
    });
    increment(state.statusClasses, `${Math.floor(response.status / 100)}xx`);
    increment(state.statusCodes, response.status);
    const problem =
      response.status >= 400
        ? await readProblemCode(response)
        : { code: undefined, diagnostic: undefined };
    if (problem.diagnostic !== undefined)
      increment(state.bodyDiagnostics, problem.diagnostic);
    if (problem.code !== undefined) {
      const evidenceCode =
        inputs.profile.responsePolicy.expectedProblemCodes.includes(
          problem.code,
        )
          ? problem.code
          : 'unexpected';
      increment(state.problemCodes, evidenceCode);
    }
    if (
      !responseMatchesPolicy(
        response.status,
        problem.code,
        inputs.profile.responsePolicy,
      )
    )
      state.unexpectedResponses += 1;
    if (response.status < 400) {
      try {
        await response.body?.cancel();
      } catch {
        increment(state.bodyDiagnostics, 'body_cancel_error');
      }
    }
  } catch {
    state.statusClasses.transport_error += 1;
    state.unexpectedResponses += 1;
  } finally {
    state.latencies.push(runtime.monotonicNow() - requestStartedAt);
  }
}

export async function runHttpExercise(inputs, options = {}) {
  const runtime = createRuntime(options.runtime);
  const signal = options.signal ?? new AbortController().signal;
  const scheduled = Math.floor(
    inputs.profile.durationSeconds * inputs.profile.requestsPerSecond,
  );
  const intervalMilliseconds = 1_000 / inputs.profile.requestsPerSecond;
  const startedMonotonic = runtime.monotonicNow();
  const startedWallTime = options.startedWallTime ?? runtime.wallNow();
  const runId = options.runId ?? runtime.randomUUID();
  const identity = {
    public: publicRunIdentity(inputs, runId, startedWallTime),
    startedWallTime,
  };
  const state = {
    bodyDiagnostics: {},
    interruption: undefined,
    latencies: [],
    problemCodes: {},
    scheduled,
    skippedForConcurrency: 0,
    skippedForScheduleDelay: 0,
    statusClasses: {
      '2xx': 0,
      '3xx': 0,
      '4xx': 0,
      '5xx': 0,
      transport_error: 0,
    },
    statusCodes: {},
    unexpectedResponses: 0,
  };
  const pending = new Set();

  for (let index = 0; index < scheduled; index += 1) {
    if (signal.aborted) {
      state.interruption = 'aborted';
      break;
    }
    const dueAt = startedMonotonic + index * intervalMilliseconds;
    const delay = dueAt - runtime.monotonicNow();
    if (delay > 0) {
      try {
        await runtime.sleep(delay, signal);
      } catch {
        state.interruption = signal.aborted ? 'aborted' : 'scheduler_error';
        break;
      }
    }
    if (signal.aborted) {
      state.interruption = 'aborted';
      break;
    }
    if (runtime.monotonicNow() >= dueAt + intervalMilliseconds) {
      state.skippedForScheduleDelay += 1;
      continue;
    }
    if (pending.size >= inputs.profile.maxInFlight) {
      state.skippedForConcurrency += 1;
      continue;
    }
    const operation = performAttempt(inputs, runtime, signal, state).finally(
      () => {
        pending.delete(operation);
      },
    );
    pending.add(operation);
  }
  await Promise.all(pending);
  return summarizeRun(
    state,
    inputs,
    identity,
    Math.max(0, runtime.monotonicNow() - startedMonotonic),
  );
}

export async function executeHttpExercise({
  environment = process.env,
  outputPath,
  profilePath,
  runtime,
  signal,
}) {
  const inputs = await loadExerciseInputs(resolve(profilePath), environment);
  const selectedRuntime = createRuntime(runtime);
  const runId = selectedRuntime.randomUUID();
  const startedWallTime = selectedRuntime.wallNow();
  const identity = publicRunIdentity(inputs, runId, startedWallTime);
  const destination = await reserveEvidenceDestination(outputPath, {
    ...identity,
    operatorCleanupRequired: true,
    status: 'started',
  });
  const evidence = await runHttpExercise(inputs, {
    runId,
    runtime: selectedRuntime,
    signal,
    startedWallTime,
  });
  await destination.finalize(evidence);
  return evidence;
}

async function main() {
  const profilePath = process.argv[2];
  const outputPath = process.argv[3];
  if (profilePath === undefined || outputPath === undefined)
    fail('usage: run-http-exercise.mjs PROFILE OUTPUT');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('operator interruption'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const evidence = await executeHttpExercise({
      outputPath,
      profilePath,
      signal: controller.signal,
    });
    process.stdout.write(
      `${evidence.passed ? 'PASS' : 'FAIL'} ${evidence.profileName}: ${evidence.completed}/${evidence.scheduled}, p95=${String(evidence.latencyMilliseconds.p95)}ms, status=${evidence.status}\n`,
    );
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (import.meta.main) await main();
