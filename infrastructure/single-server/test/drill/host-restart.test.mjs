import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createClient } from './support/client.mjs';
import { PUBLIC_HOSTS } from './support/overlay.mjs';
import { docker, must, mustDocker, waitFor } from './support/process.mjs';
import {
  createWorkspace,
  edge,
  node,
  publishWorkflow,
  readRun,
  startRun,
  waitForEndedRun,
} from './support/product.mjs';
import { closeInternet, openInternet } from './support/public-internet.mjs';
import {
  compose,
  createOwner,
  createPublicServer,
  sql,
} from './support/public-server.mjs';
import {
  destroyServer,
  joinPrivateNetwork,
  project,
} from './support/server.mjs';
import { createReport, tail } from './support/simulation-report.mjs';

// The whole server goes down in the middle of work: first an orderly restart
// of every container, then a power cut that kills Docker and every process at
// once. Runs that were waiting, running a step or just accepted must each end
// the way the engine's rules say, once, with nothing written twice. Rerun on a
// Linux machine with Docker and sudo:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/host-restart.test.mjs

const person = {
  email: `restart-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-9',
  name: 'Restart Owner',
};
// Long enough to be mid-step when the host goes down.
const BUSY_STEP_MILLIS = 8_000;
const record = createReport();

describe('a host restart in the middle of work', () => {
  let internet;
  let server;
  let client;
  let workspaceId;
  let waiting;
  let busy;

  before(async () => {
    internet = await openInternet();
    server = await createPublicServer(internet);
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    await joinPrivateNetwork();
    // Through the host's own published port: the outside link does not survive a power cut.
    client = createClient({
      origin: `https://${PUBLIC_HOSTS.app}`,
      connect: { host: '127.0.0.1', port: 443 },
      ca: internet.root,
    });
    await createOwner(server, client, person);
    workspaceId = await createWorkspace(client);
    // A file holding what the step before it produced.
    const writeFile = (after) =>
      node(
        'file',
        'core.create_file',
        { format: 'json' },
        { data: { kind: 'node_output', nodeId: after, path: '$' } },
      );
    waiting = await publishWorkflow(client, workspaceId, {
      name: 'Wait, then write',
      nodes: [
        node('start', 'core.manual'),
        node('wait', 'core.wait', { durationSeconds: 20 }),
        writeFile('wait'),
      ],
      edges: [edge('first', 'start', 'wait'), edge('second', 'wait', 'file')],
    });
    busy = await publishWorkflow(client, workspaceId, {
      name: 'Work, then write',
      nodes: [
        node('start', 'core.manual'),
        node('code', 'core.code', {
          code: `const end = Date.now() + ${BUSY_STEP_MILLIS}; while (Date.now() < end) {} return { worked: true };`,
          // Past the 5-second default, so the step has room to finish when retried.
          timeoutSeconds: 20,
        }),
        writeFile('code'),
      ],
      edges: [edge('first', 'start', 'code'), edge('second', 'code', 'file')],
    });
  });
  after(async () => {
    if (process.env.DRILL_KEEP === 'true') return;
    await destroyServer();
    await closeInternet();
  });

  const counts = async () => ({
    runs: Number(await sql(server, 'select count(*) from app.workflow_runs')),
    files: Number(
      await sql(
        server,
        "select count(*) from app.artifacts where status = 'available'",
      ),
    ),
  });
  /** Starts runs and waits until each is where the outage should catch it. */
  const startWork = async () => {
    const runs = [
      ...(await Promise.all(
        [1, 2].map(() => startRun(client, waiting, { kind: 'waiting' })),
      )),
      await startRun(client, busy, { kind: 'busy' }),
    ];
    await waitFor(
      async () => {
        const read = await readRun(client, workspaceId, runs[2]);
        return read.nodes?.some(
          (step) => step.nodeId === 'code' && step.status === 'running',
        );
      },
      { what: 'the busy step to be running', timeout: 60_000, every: 250 },
    );
    return runs;
  };
  /** Waits for every run to end and describes how each did, step by step. */
  const outcomes = async (runs) => {
    const ended = [];
    for (const runId of runs) {
      const run = await waitForEndedRun(client, workspaceId, runId, 600_000);
      ended.push({
        status: run.run.status,
        steps: Object.fromEntries(
          run.nodes.map((step) => [
            step.nodeId,
            `${step.status} attempt ${step.currentAttemptNumber}${step.safeErrorCode ? ` ${step.safeErrorCode}` : ''}`,
          ]),
        ),
      });
    }
    return ended;
  };
  const serving = () =>
    waitFor(async () => (await client.get('/v1/workspaces')).status === 200, {
      what: 'the app to serve again',
      timeout: 600_000,
      every: 2_000,
    });

  /** Each run ends once, every succeeded run wrote exactly one file. */
  const assertNothingDuplicated = async (before, runs, ended) => {
    const after = await counts();
    assert.equal(
      after.runs - before.runs,
      runs.length,
      'no run was added or lost',
    );
    const succeeded = ended.filter((run) => run.status === 'succeeded').length;
    assert.equal(
      after.files - before.files,
      succeeded,
      'one file per succeeded run',
    );
    for (const run of ended)
      assert.ok(
        run.status === 'succeeded' ||
          Object.values(run.steps).some((step) => / \S+\.\S+$/u.test(step)),
        `a run that did not succeed says why: ${JSON.stringify(run)}`,
      );
  };

  it('finishes interrupted work once after every container restarts', async () => {
    const before = await counts();
    const runs = await startWork();
    const restarted = Date.now();
    await compose(server, ['restart']);
    await serving();
    const servingAfter = Math.round((Date.now() - restarted) / 1_000);
    const ended = await outcomes(runs);
    record('compose restart', {
      secondsUntilServing: servingAfter,
      runs: ended,
      counts: await counts(),
    });
    await assertNothingDuplicated(before, runs, ended);
    for (const run of ended.slice(0, 2))
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
  });

  it('finishes interrupted work once after a power cut', async () => {
    const before = await counts();
    const runs = await startWork();
    const containers = (
      await mustDocker([
        'ps',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ])
    ).split('\n');
    const pids = await Promise.all(
      containers.map((container) =>
        mustDocker(['inspect', '--format', '{{.State.Pid}}', container]),
      ),
    );
    const cut = Date.now();
    // Docker, containerd and every container's processes die together, as in a power cut.
    await must('sudo', [
      'sh',
      '-c',
      `kill -9 $(pidof dockerd) $(pidof containerd) ${pids.join(' ')}`,
    ]);
    await waitFor(
      async () =>
        (await docker(['info', '--format', '{{.ServerVersion}}'])).status === 0,
      {
        what: 'Docker to come back',
        timeout: 180_000,
        every: 2_000,
      },
    );
    // The operator's shell on the server is not a service: it needs starting again.
    await docker(['start', `${project}-control`]);
    await joinPrivateNetwork().catch(() => undefined);
    await serving();
    const servingAfter = Math.round((Date.now() - cut) / 1_000);
    const ended = await outcomes(runs);
    const check = await server.script('check.sh', [], {
      env: { ALERT_DISK_PERCENT: '100' },
    });
    record('power cut', {
      secondsUntilServing: servingAfter,
      runs: ended,
      counts: await counts(),
      checkStatus: check.status,
      checkOutput: tail(check.stdout + check.stderr, 6),
    });
    await assertNothingDuplicated(before, runs, ended);
    for (const run of ended.slice(0, 2))
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
  });
});
