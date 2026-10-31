import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe } from 'node:test';
import { it } from '../support/it.mjs';
import { createClient } from './support/client.mjs';
import { PUBLIC_HOSTS } from './support/overlay.mjs';
import { mustDocker, waitFor } from './support/process.mjs';
import {
  downloadFile,
  createWorkspace,
  publishWebhookWorkflow,
  sendWebhook,
  signIn,
  signUp,
  uploadFile,
  waitForSucceededRun,
} from './support/product.mjs';
import {
  configure,
  createBackupBucket,
  joinPrivateNetwork,
  killLikeTheKernel,
  leavePrivateNetwork,
  createServer,
  destroyServer,
  httpsPort,
  withApiMovedDuring,
} from './support/server.mjs';

// The operator's whole life with the single-server stack, in order: install, first
// account, real work, backups, an upgrade, alerts, a crash, then a wipe and restore.
// Everything goes through the real scripts and the real proxy; see overlay.mjs for
// the few things a drill must swap. Steps build on each other, so run the whole file:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/stack.test.mjs
// Set DRILL_KEEP=true to leave the stack up after a run, for debugging.

const person = {
  email: `first-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-1',
  name: 'First Person',
};
const file = randomBytes(2_048);

describe('the single-server stack, through its real scripts', () => {
  let server;
  let client;
  let workspaceId;
  let webhook;
  let artifactId;
  let verificationLink;
  let backup;
  let waitingRunId;

  const app = () =>
    createClient({
      origin: `https://${PUBLIC_HOSTS.app}`,
      connect: { host: '127.0.0.1', port: httpsPort },
      ca: server.ca,
    });
  const compose = async (args, options) => {
    const result = await server.composeFor(
      await server.current(),
      args,
      options,
    );
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const postgres = (sql, role = 'superuser') =>
    compose([
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      role === 'app'
        ? `PGPASSWORD="$POSTGRES_APP_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_APP_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "${sql}"`
        : `PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "${sql}"`,
    ]);
  const mailpit = async (path) =>
    JSON.parse(
      await mustDocker([
        'exec',
        await server.containerOf('drill-mail'),
        'wget',
        '-qO-',
        `http://127.0.0.1:8025/api/v1/${path}`,
      ]),
    );
  const restartCount = async (service) =>
    Number(
      await mustDocker([
        'inspect',
        '--format',
        '{{.RestartCount}}',
        await server.containerOf(service),
      ]),
    );
  const healthy = (service) =>
    waitFor(
      async () =>
        (await mustDocker([
          'inspect',
          '--format',
          '{{.State.Health.Status}}',
          await server.containerOf(service),
        ])) === 'healthy',
      { what: `${service} to be healthy`, timeout: 180_000 },
    );
  const signedInStatus = async () =>
    (await client.get('/v1/workspaces')).status;
  const receivedAlerts = async () =>
    (await mustDocker(['logs', await server.containerOf('drill-alerts')]))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const check = (env = {}) => server.script('check.sh', [], { env });
  /** Runs the health check and returns only the alerts it just sent. */
  const checkAndCollect = async (env) => {
    const before = (await receivedAlerts()).length;
    const result = await check(env);
    const alerts = (await receivedAlerts())
      .slice(before)
      .filter((request) => request.url.startsWith('/alert'));
    return { ...result, alerts };
  };
  const readiness = () =>
    compose([
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      "fetch('http://127.0.0.1:3000/health/ready').then((r) => console.log(r.status))",
    ]);
  const countRows = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          'users',
          'workspaces',
          'workflow_runs',
          'workflow_triggers',
          'artifacts',
        ].map(async (table) => [
          table,
          (await postgres(`select count(*) from app.${table}`)).trim(),
        ]),
      ),
    );
  before(async () => {
    server = await createServer();
    await configure(server);
  });
  after(async () => {
    if (process.env.DRILL_KEEP !== 'true') await destroyServer();
  });

  // Found by this drill: a server login with the scripts' umask 077 extracts releases
  // that Postgres can't read, so it crash-loops on its first start. Docker Desktop's
  // file sharing hides this; a real Linux disk doesn't.
  it('deploy.sh installs a fresh server as the non-root login the runbook asks for', async () => {
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    assert.match(deployed.stdout, /Healthy release/u);
    assert.equal(await server.current(), server.releases.first);
  });

  it('the release is serving and recorded', async () => {
    assert.equal(await server.current(), server.releases.first);
    await createBackupBucket(server);
    await joinPrivateNetwork();
    client = app();
  });

  it('serves the app over HTTPS through the proxy', async () => {
    const page = await client.get('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /<html/iu);
  });

  it('lets the first person sign up', async () => {
    const response = await signUp(client, person);
    assert.equal(response.status, 200, response.text);
  });

  // ops-02: the worker used to die on the frozen SMTP login, sending no mail.
  it('delivers the verification mail through a relay that needs a login', async () => {
    const message = await waitFor(
      async () =>
        (await mailpit('messages')).messages.find((candidate) =>
          candidate.To.some((to) => to.Address === person.email),
        ),
      { what: 'the verification mail', timeout: 30_000 },
    );
    const full = await mailpit(`message/${message.ID}`);
    verificationLink = /https:\/\/\S+verify\S*/u.exec(full.Text)?.[0];
    assert.ok(verificationLink, full.Text);
  });

  // ops-02
  it('keeps the worker running through a sign-up', async () => {
    assert.equal(await restartCount('worker'), 0);
  });

  it('lets the first person sign in once their address is verified', async () => {
    await healthy('worker');
    const opened = await client.get(verificationLink);
    assert.ok(opened.status < 400, opened.text);
    const response = await signIn(client, person);
    assert.equal(response.status, 200, response.text);
    assert.equal(await signedInStatus(), 200);
  });

  it('runs a published workflow from a webhook through a Code step', async () => {
    workspaceId = await createWorkspace(client);
    webhook = await publishWebhookWorkflow(client, workspaceId);
    const runId = await sendWebhook(client, webhook);
    await waitForSucceededRun(client, workspaceId, runId);
  });

  it('takes a file through its presigned address and gives the same bytes back', async () => {
    artifactId = await uploadFile(client, workspaceId, file);
    assert.deepEqual(await downloadFile(client, workspaceId, artifactId), file);
  });

  // ops-01: nginx used to keep the API's old address while health checks passed.
  it('still answers signed-in requests right after a redeploy', async () => {
    const redeployed = await withApiMovedDuring(server, () =>
      server.script('deploy.sh', [server.releases.first]),
    );
    assert.equal(redeployed.status, 0, redeployed.stderr);
    assert.ok(redeployed.apiMoved);
    assert.equal(await signedInStatus(), 200);
  });

  // ops-01
  it('has no 502 once a restarted API is healthy again', async () => {
    await withApiMovedDuring(server, async () => {
      await compose(['stop', 'api']);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await compose(['up', '-d', '--no-deps', '--wait', 'api']);
      return {};
    });
    await waitFor(async () => (await signedInStatus()) === 200, {
      what: 'nginx to find the restarted API',
      timeout: 15_000,
    });
  });

  it('backup.sh completes a recovery point', async () => {
    backup = await withApiMovedDuring(server, () => server.script('backup.sh'));
    assert.equal(backup.status, 0, backup.stdout + backup.stderr);
    assert.ok(backup.apiMoved);
    assert.match(backup.stdout, /Completed recovery point: \S+/u);
  });

  // ops-01: the night the first backup ran, every signed-in user used to get a 502.
  it('still answers signed-in requests right after a backup', async () => {
    assert.equal(await signedInStatus(), 200);
  });

  // ops-07
  it('tells the dead-man switch about a completed backup', async () => {
    const pings = (await receivedAlerts()).filter((request) =>
      request.url.startsWith('/heartbeat'),
    );
    assert.equal(pings.length, 1);
    assert.equal(pings[0].url, '/heartbeat');
  });

  // ops-07: a backup that fails quietly for 14 days is how data gets lost.
  it('tells the dead-man switch about a failed backup, and keeps serving', async () => {
    await compose(['stop', 'drill-backup-proxy']);
    try {
      const failed = await server.script('backup.sh');
      assert.notEqual(failed.status, 0);
      assert.equal(await signedInStatus(), 200);
      assert.ok(
        (await receivedAlerts()).some(
          (request) => request.url === '/heartbeat/fail',
        ),
      );
    } finally {
      await compose(['up', '-d', '--no-deps', 'drill-backup-proxy']);
    }
  });

  // ops-07
  it('check.sh stays quiet on a healthy server', async () => {
    // How full this machine's disk happens to be isn't what this checks.
    const result = await checkAndCollect({ ALERT_DISK_PERCENT: '100' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.alerts, []);
  });

  // ops-07
  it('check.sh alerts the operator when the disk is nearly full', async () => {
    const result = await checkAndCollect({ ALERT_DISK_PERCENT: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.alerts.map((alert) => alert.body).join(), /disk/iu);
  });

  // ops-07
  it('check.sh alerts the operator when the last backup is too old', async () => {
    const result = await checkAndCollect({ ALERT_BACKUP_MAX_AGE_HOURS: '0' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.alerts.map((alert) => alert.body).join(), /backup/iu);
  });

  // ops-07: readiness only reads, so green health covered a Postgres refusing writes.
  it('readiness and check.sh notice a database that refuses writes', async () => {
    await postgres('alter system set default_transaction_read_only = on');
    await postgres('select pg_reload_conf()');
    try {
      await waitFor(async () => (await readiness()).trim() === '503', {
        what: 'readiness to fail',
        timeout: 15_000,
      });
      const result = await checkAndCollect();
      assert.equal(result.status, 1);
      assert.match(
        result.alerts.map((alert) => alert.body).join(),
        /ready|write/iu,
      );
    } finally {
      await compose([
        'exec',
        '-T',
        '-e',
        'PGOPTIONS=-c default_transaction_read_only=off',
        'postgres',
        'sh',
        '-c',
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "alter system reset default_transaction_read_only"',
      ]);
      await postgres('select pg_reload_conf()');
    }
  });

  // ops-07
  it('check.sh alerts the operator about work nobody is picking up', async () => {
    await compose(['stop', 'worker']);
    waitingRunId = await sendWebhook(client, webhook);
    try {
      const result = await checkAndCollect({ ALERT_STUCK_MINUTES: '0' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.alerts.map((alert) => alert.body).join(), /stuck/iu);
    } finally {
      await compose(['up', '-d', '--no-deps', '--wait', 'worker']);
    }
  });

  it('finishes the work that waited while the worker was down', async () => {
    await waitForSucceededRun(client, workspaceId, waitingRunId);
  });

  // ops-07: today's deploy calls this release healthy, because web's health check
  // only fetches its own front page.
  it('deploy.sh refuses a release whose app can not reach the API', async () => {
    const attempted = await server.script('deploy.sh', [
      server.releases.broken,
    ]);
    assert.notEqual(attempted.status, 0, attempted.stdout);
    assert.equal(await server.current(), server.releases.first);
    assert.equal(await signedInStatus(), 200);
  });

  it('upgrades to a newer release and keeps the session and the data', async () => {
    const upgraded = await server.script('deploy.sh', [
      server.releases.repaired,
    ]);
    assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
    assert.equal(await server.current(), server.releases.repaired);
    assert.equal(await signedInStatus(), 200);
    assert.deepEqual(await downloadFile(client, workspaceId, artifactId), file);
  });

  // ops-09, docs-deps-product-17
  it('deploy.sh takes "latest" and installs the newest release tag', async () => {
    await server.mustExec(`
set -e
cd repository
git tag v0.0.9 ${server.releases.first}
git tag v0.0.10 ${server.releases.repaired}
git push --quiet origin v0.0.9 v0.0.10
git tag -d v0.0.9 v0.0.10 >/dev/null
`);
    const updated = await server.script('deploy.sh', ['latest']);
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.equal(await server.current(), server.releases.repaired);
  });

  it('brings a SIGKILLed worker back, and new work still runs', async () => {
    const before = await restartCount('worker');
    await killLikeTheKernel(await server.containerOf('worker'));
    await waitFor(async () => (await restartCount('worker')) > before, {
      what: 'the worker to restart',
    });
    await healthy('worker');
    const runId = await sendWebhook(client, webhook);
    await waitForSucceededRun(client, workspaceId, runId);
  });

  it('backs up, loses the whole server, and restores everything', async () => {
    const release = await server.current();
    const finalBackup = await server.script('backup.sh');
    assert.equal(
      finalBackup.status,
      0,
      finalBackup.stdout + finalBackup.stderr,
    );
    const point = /Completed recovery point: (\S+)/u.exec(
      finalBackup.stdout,
    )[1];
    assert.equal(await signedInStatus(), 200);
    const rowsBefore = await countRows();

    await leavePrivateNetwork();
    const wiped = await server.composeFor(release, [
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
    assert.equal(wiped.status, 0, wiped.stderr);
    await server.mustExec('rm -rf state/* state/.[!.]*');

    const restored = await server.script('restore.sh', [point, release]);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /Restored/u);
    const serving = await server.composeFor(release, [
      'ps',
      '--services',
      '--status',
      'running',
    ]);
    assert.doesNotMatch(serving.stdout, /^(api|worker|web|proxy)$/mu);

    const resumed = await server.script('deploy.sh', [release]);
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.deepEqual(await countRows(), rowsBefore);
  });

  it('after the restore, the old session, webhook and file all still work', async () => {
    assert.equal(await signedInStatus(), 200);
    assert.deepEqual(await downloadFile(client, workspaceId, artifactId), file);
    const runId = await sendWebhook(client, webhook);
    await waitForSucceededRun(client, workspaceId, runId);
    assert.equal(
      (await postgres('select count(*) from app.workflow_runs', 'app')).trim(),
      '0',
      'the app role sees no rows outside a workspace',
    );
  });
});
