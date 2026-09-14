import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadAuthentication,
  parseProfile,
  requestAuthenticationHeaders,
  reserveEvidenceDestination,
  executeHttpExercise,
  resolveExerciseTarget,
  responseMatchesPolicy,
  runHttpExercise,
} from './run-http-exercise.mjs';

const profile = {
  schemaVersion: 1,
  name: 'test-profile',
  scenario: 'steady-run-start',
  durationSeconds: 1,
  requestsPerSecond: 1,
  maxInFlight: 1,
  method: 'POST',
  authentication: 'session-cookie',
  pathEnvironment: 'PERTEXO_EXERCISE_PATH',
  bodyFileEnvironment: 'PERTEXO_EXERCISE_BODY_FILE',
  headers: { 'content-type': 'application/json' },
  responsePolicy: { expectedStatuses: [202], expectedProblemCodes: [] },
  objectives: {
    minimumAchievedRateRatio: 0.98,
    maximumServerErrorRatio: 0,
    maximumP95Milliseconds: 500,
  },
};

function parsedProfile(overrides = {}) {
  return parseProfile({ ...profile, ...overrides });
}

function inputs(profileOverrides = {}) {
  return {
    authentication: {
      kind: 'session-cookie',
      csrfToken: 'csrf-token-value-1',
      sessionToken: 'session-token-value',
    },
    body: '{"safe":true}',
    profile: parsedProfile(profileOverrides),
    profileDigest: 'a'.repeat(64),
    target: new URL('https://api.example.test/private/path?ignored=true'),
  };
}

function response(status = 202, body) {
  return {
    body: body ?? { cancel: () => Promise.resolve() },
    headers: new Headers(),
    status,
  };
}

function immediateRuntime(fetchImplementation, clock = { now: 0 }) {
  return {
    createDeadlineSignal: (signal) => signal,
    fetch: fetchImplementation,
    monotonicNow: () => clock.now,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    sleep: (milliseconds) => {
      clock.now += milliseconds;
      return Promise.resolve();
    },
    wallNow: () => 1_750_000_000_000 + clock.now,
  };
}

async function exerciseFiles(t, profileValue = profile) {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-http-exercise-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const profilePath = join(directory, 'profile.json');
  const bodyPath = join(directory, 'body.json');
  const outputPath = join(directory, 'result.json');
  await writeFile(profilePath, JSON.stringify(profileValue));
  await writeFile(bodyPath, '{"fixture":true}');
  return {
    directory,
    environment: {
      PERTEXO_EXERCISE_BASE_URL: 'https://api.example.test',
      PERTEXO_EXERCISE_BODY_FILE: bodyPath,
      PERTEXO_EXERCISE_CSRF_TOKEN: 'csrf-token-value-1',
      PERTEXO_EXERCISE_PATH: '/private/run?key=not-evidence',
      PERTEXO_EXERCISE_SESSION_COOKIE: 'session-token-value',
    },
    outputPath,
    profilePath,
  };
}

test('session authentication emits the product cookie and double-submit token', () => {
  const authentication = loadAuthentication('session-cookie', {
    PERTEXO_EXERCISE_SESSION_COOKIE: 'session-token-value',
    PERTEXO_EXERCISE_CSRF_TOKEN: 'csrf-token-value-1',
  });
  assert.deepEqual(requestAuthenticationHeaders(authentication, '{}'), {
    cookie:
      'pertexo_session=session-token-value; pertexo_csrf=csrf-token-value-1',
    'x-csrf-token': 'csrf-token-value-1',
  });
});

test('webhook authentication signs each raw body with its supplied timestamp', () => {
  const secret = Buffer.alloc(32, 7);
  const authentication = loadAuthentication('webhook-hmac', {
    PERTEXO_EXERCISE_WEBHOOK_SIGNING_SECRET: secret.toString('base64url'),
  });
  const headers = requestAuthenticationHeaders(
    authentication,
    '{"ok":true}',
    1_750_000_000_999,
  );
  const expected = createHmac('sha256', secret)
    .update('1750000000', 'ascii')
    .update('.')
    .update('{"ok":true}')
    .digest('hex');
  assert.deepEqual(headers, {
    'x-pertexo-signature': `v1=${expected}`,
    'x-pertexo-timestamp': '1750000000',
  });
});

test('response policy rejects authentication and unintended throttling responses', () => {
  const policy = parseProfile(profile).responsePolicy;
  assert.equal(responseMatchesPolicy(202, undefined, policy), true);
  assert.equal(
    responseMatchesPolicy(401, 'auth.unauthenticated', policy),
    false,
  );
  assert.equal(responseMatchesPolicy(403, 'auth.forbidden', policy), false);
  assert.equal(
    responseMatchesPolicy(429, 'workspace.quota_exceeded', policy),
    false,
  );
});

test('profiles cannot declare authentication failures as expected', () => {
  assert.throws(
    () =>
      parseProfile({
        ...profile,
        responsePolicy: { expectedStatuses: [401], expectedProblemCodes: [] },
      }),
    /authentication and authorization failures/u,
  );
});

test('profile validation preserves response-policy and header failure order', () => {
  assert.throws(
    () =>
      parseProfile({
        ...profile,
        headers: { authorization: 'secret' },
        responsePolicy: {
          expectedStatuses: [401],
          expectedProblemCodes: [],
        },
      }),
    /headers are invalid/u,
  );
  assert.throws(
    () =>
      parseProfile({
        ...profile,
        responsePolicy: {
          expectedStatuses: [401],
          expectedProblemCodes: ['not a problem code'],
        },
      }),
    /authentication and authorization failures/u,
  );
});

test('an intentional rate-limit policy must name its stable problem code', () => {
  assert.throws(
    () =>
      parseProfile({
        ...profile,
        responsePolicy: { expectedStatuses: [429], expectedProblemCodes: [] },
      }),
    /rate-limit problem code/u,
  );
  const parsed = parseProfile({
    ...profile,
    responsePolicy: {
      expectedStatuses: [429],
      expectedProblemCodes: ['webhook.rate_limited'],
    },
  });
  assert.equal(
    responseMatchesPolicy(429, 'webhook.rate_limited', parsed.responsePolicy),
    true,
  );
});

test('resolves only same-origin absolute exercise paths', () => {
  assert.equal(
    resolveExerciseTarget('https://api.example.test/base', '/v1/runs?dry=true')
      .href,
    'https://api.example.test/v1/runs?dry=true',
  );
  assert.equal(
    resolveExerciseTarget('http://127.0.0.1:3000', '/hooks/key').href,
    'http://127.0.0.1:3000/hooks/key',
  );
});

test('rejects network paths, backslashes, cross-origin resolution, and non-path input', () => {
  for (const target of [
    '//another.example/path',
    '///another.example/path',
    '/safe\\@another.example/path',
    'relative/path',
    42,
  ])
    assert.throws(
      () => resolveExerciseTarget('https://api.example.test', target),
      /absolute same-origin path/u,
    );
});

test('requires safe integer concurrency and prevalidates HTTP field-value bytes', () => {
  for (const maxInFlight of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => parsedProfile({ maxInFlight }),
      /maxInFlight must be a safe integer|between 1 and 2000/u,
    );
  }
  for (const value of ['line\nbreak', 'nul\0byte', 'snowman ☃']) {
    assert.throws(
      () => parsedProfile({ headers: { 'x-fixture': value } }),
      /headers are invalid/u,
    );
  }
  assert.equal(
    parsedProfile({
      durationSeconds: 1.5,
      headers: { 'x-fixture': 'request-${requestId}\tvalue' },
      requestsPerSecond: 2.5,
    }).durationSeconds,
    1.5,
  );
});

test('schedules the exact floored request count with one outcome per attempt', async () => {
  const evidence = await runHttpExercise(
    inputs({ durationSeconds: 1.5, maxInFlight: 3, requestsPerSecond: 2.5 }),
    {
      runtime: immediateRuntime(async () => response()),
    },
  );

  assert.equal(evidence.scheduled, 3);
  assert.equal(evidence.attempted, 3);
  assert.equal(evidence.completed, 3);
  assert.deepEqual(evidence.statusClasses, {
    '2xx': 3,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    transport_error: 0,
  });
  assert.equal(
    Object.values(evidence.statusClasses).reduce((sum, count) => sum + count),
    evidence.completed,
  );
});

test('enforces the live concurrency cap and reconciles skipped slots', async () => {
  const releases = [];
  let live = 0;
  let maximumLive = 0;
  const clock = { now: 0 };
  const fetchImplementation = () => {
    live += 1;
    maximumLive = Math.max(maximumLive, live);
    return new Promise((resolveFetch) => {
      releases.push(() => {
        live -= 1;
        resolveFetch(response());
      });
    });
  };
  const runPromise = runHttpExercise(
    inputs({ durationSeconds: 1, maxInFlight: 2, requestsPerSecond: 5 }),
    { runtime: immediateRuntime(fetchImplementation, clock) },
  );
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  for (const release of releases) release();
  const evidence = await runPromise;

  assert.equal(maximumLive, 2);
  assert.equal(evidence.completed, 2);
  assert.equal(evidence.skippedForConcurrency, 3);
  assert.equal(
    evidence.completed +
      evidence.skippedForConcurrency +
      evidence.skippedForScheduleDelay,
    evidence.scheduled,
  );
});

test('skips delayed open-loop slots instead of emitting a catch-up burst', async () => {
  const clock = { now: 0 };
  let calls = 0;
  const runtime = immediateRuntime(async () => {
    calls += 1;
    return response();
  }, clock);
  runtime.sleep = (milliseconds) => {
    clock.now += milliseconds + 400;
    return Promise.resolve();
  };
  const evidence = await runHttpExercise(
    inputs({ durationSeconds: 1, maxInFlight: 3, requestsPerSecond: 3 }),
    { runtime },
  );

  assert.equal(calls, 2);
  assert.equal(evidence.skippedForScheduleDelay, 1);
  assert.equal(evidence.scheduled, 3);
});

test('uses actual elapsed time for achieved rate and handles empty results', async () => {
  const clock = { now: 0 };
  const runtime = immediateRuntime(async () => response(), clock);
  runtime.monotonicNow = () => {
    const value = clock.now;
    clock.now += 100;
    return value;
  };
  const evidence = await runHttpExercise(inputs(), { runtime });
  assert.equal(evidence.completed, 1);
  assert.equal(evidence.durationSeconds, 0.5);
  assert.equal(evidence.achievedRequestsPerSecond, 2);

  const controller = new AbortController();
  controller.abort();
  const empty = await runHttpExercise(inputs(), {
    runtime: immediateRuntime(async () => response()),
    signal: controller.signal,
  });
  assert.equal(empty.completed, 0);
  assert.equal(empty.achievedRequestsPerSecond, 0);
  assert.equal(empty.serverErrorRatio, 1);
  assert.equal(empty.latencyMilliseconds.p95, null);
  assert.equal(empty.status, 'interrupted');
  assert.equal(empty.operatorCleanupRequired, true);
});

test('passes a request deadline signal without following redirects', async () => {
  const parent = new AbortController().signal;
  const deadline = AbortSignal.abort(new Error('fixture deadline'));
  let observed;
  await runHttpExercise(inputs(), {
    runtime: {
      ...immediateRuntime(async (_target, options) => {
        observed = options;
        throw options.signal.reason;
      }),
      createDeadlineSignal(signal) {
        assert.equal(signal, parent);
        return deadline;
      },
    },
    signal: parent,
  });
  assert.equal(observed.redirect, 'manual');
  assert.equal(observed.signal, deadline);
});

test('keeps HTTP outcome primary when problem body reading or cancellation fails', async () => {
  const body = {
    getReader() {
      return {
        cancel: () => Promise.reject(new Error('cancel failed')),
        read: () => Promise.reject(new Error('read failed')),
      };
    },
  };
  const failureResponse = response(503, body);
  failureResponse.headers = new Headers({
    'content-type': 'application/problem+json',
  });
  const evidence = await runHttpExercise(inputs(), {
    runtime: immediateRuntime(async () => failureResponse),
  });

  assert.equal(evidence.statusClasses['5xx'], 1);
  assert.equal(evidence.statusClasses.transport_error, 0);
  assert.equal(evidence.bodyDiagnostics.body_read_error, 1);
  assert.equal(evidence.unexpectedResponses, 1);
  assert.equal(evidence.serverErrorRatio, 1);
});

test('reconciles successful, HTTP-failure, and network-failure attempts once each', async () => {
  const outcomes = [response(202), response(503), new Error('network failed')];
  const evidence = await runHttpExercise(
    inputs({ durationSeconds: 1, maxInFlight: 3, requestsPerSecond: 3 }),
    {
      runtime: immediateRuntime(async () => {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }),
    },
  );

  assert.equal(evidence.completed, 3);
  assert.equal(evidence.statusClasses['2xx'], 1);
  assert.equal(evidence.statusClasses['5xx'], 1);
  assert.equal(evidence.statusClasses.transport_error, 1);
  assert.equal(evidence.unexpectedResponses, 2);
  assert.equal(evidence.serverErrorRatio, 2 / 3);
  assert.ok(evidence.serverErrorRatio <= 1);
});

test('bounds streamed problem bodies independently of the HTTP outcome', async () => {
  let readCount = 0;
  const chunks = [new Uint8Array(10_000), new Uint8Array(10_000)];
  const failureResponse = response(429, {
    getReader() {
      return {
        cancel: () => Promise.resolve(),
        read: () => {
          const value = chunks[readCount];
          readCount += 1;
          return Promise.resolve(
            value === undefined ? { done: true } : { done: false, value },
          );
        },
      };
    },
  });
  failureResponse.headers = new Headers({
    'content-type': 'application/problem+json',
  });
  const evidence = await runHttpExercise(inputs(), {
    runtime: immediateRuntime(async () => failureResponse),
  });
  assert.equal(readCount, 2);
  assert.equal(evidence.bodyDiagnostics.body_too_large, 1);
  assert.equal(evidence.statusClasses['4xx'], 1);
  assert.equal(evidence.statusClasses.transport_error, 0);
});

test('reserves evidence before requests and cannot overwrite an existing result', async (t) => {
  const files = await exerciseFiles(t);
  await writeFile(files.outputPath, 'unrelated evidence');
  let requests = 0;
  await assert.rejects(
    executeHttpExercise({
      ...files,
      runtime: immediateRuntime(async () => {
        requests += 1;
        return response();
      }),
    }),
    /EEXIST/u,
  );
  assert.equal(requests, 0);
  assert.equal(await readFile(files.outputPath, 'utf8'), 'unrelated evidence');
});

test('a failed initial evidence write removes only its newly opened reservation', async () => {
  const outputPath = '/private/fixture/result.json';
  const removed = [];
  const close = test.mock.fn();
  await assert.rejects(
    reserveEvidenceDestination(
      outputPath,
      { runId: 'fixture-run', schemaVersion: 2, status: 'started' },
      {
        mkdir: test.mock.fn(),
        open: test.mock.fn(() =>
          Promise.resolve({
            chmod: test.mock.fn(),
            close,
            sync: test.mock.fn(),
            writeFile: test.mock.fn(() =>
              Promise.reject(new Error('fixture disk failure')),
            ),
          }),
        ),
        rename: test.mock.fn(),
        unlink: test.mock.fn((path) => {
          removed.push(path);
          return Promise.resolve();
        }),
      },
    ),
    /fixture disk failure/u,
  );
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(removed, [outputPath]);
});

test('an invalid or denied destination starts no request and creates no completed evidence', async (t) => {
  const invalid = await exerciseFiles(t, { ...profile, maxInFlight: 1.5 });
  let requests = 0;
  await assert.rejects(
    executeHttpExercise({
      ...invalid,
      runtime: immediateRuntime(async () => {
        requests += 1;
        return response();
      }),
    }),
    /safe integer/u,
  );
  await assert.rejects(readFile(invalid.outputPath), /ENOENT/u);

  const denied = await exerciseFiles(t);
  const blockingFile = join(denied.directory, 'not-a-directory');
  await writeFile(blockingFile, 'fixture');
  await assert.rejects(
    executeHttpExercise({
      ...denied,
      outputPath: join(blockingFile, 'result.json'),
      runtime: immediateRuntime(async () => {
        requests += 1;
        return response();
      }),
    }),
    /ENOTDIR|EEXIST/u,
  );
  assert.equal(requests, 0);
});

test('atomically finalizes mode-0600 evidence without secrets, bodies, or raw paths', async (t) => {
  const files = await exerciseFiles(t);
  const evidence = await executeHttpExercise({
    ...files,
    runtime: immediateRuntime(async () => response()),
  });
  const storedText = await readFile(files.outputPath, 'utf8');
  const stored = JSON.parse(storedText);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.runId, evidence.runId);
  assert.equal((await stat(files.outputPath)).mode & 0o777, 0o600);
  for (const secret of [
    'session-token-value',
    'csrf-token-value-1',
    '{"fixture":true}',
    '/private/run',
    'not-evidence',
  ])
    assert.equal(storedText.includes(secret), false);
});

test('an interrupted run retains reconciled counts and requires operator cleanup', async (t) => {
  const files = await exerciseFiles(t, {
    ...profile,
    durationSeconds: 2,
    requestsPerSecond: 2,
  });
  const controller = new AbortController();
  let calls = 0;
  const runtime = immediateRuntime(async () => {
    calls += 1;
    controller.abort(new Error('fixture stop'));
    return response();
  });
  const evidence = await executeHttpExercise({
    ...files,
    runtime,
    signal: controller.signal,
  });
  const stored = JSON.parse(await readFile(files.outputPath, 'utf8'));

  assert.equal(calls, 1);
  assert.equal(evidence.completed, 1);
  assert.equal(stored.status, 'interrupted');
  assert.equal(stored.operatorCleanupRequired, true);
  assert.equal(stored.passed, false);
  assert.equal(
    Object.values(stored.statusClasses).reduce((sum, count) => sum + count),
    stored.completed,
  );
});
