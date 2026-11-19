import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PUBLIC_HOSTS } from './support/overlay.mjs';
import { mustDocker, waitFor } from './support/process.mjs';
import {
  createWorkspace,
  publishCodeWorkflow,
  signIn,
  startRun,
  waitForEndedRun,
} from './support/product.mjs';
import { closeInternet, openInternet } from './support/public-internet.mjs';
import {
  compose,
  createOwner,
  createPublicServer,
  linksIn,
  mailbox,
  publicClient,
  setRelayFaults,
  setSettings,
  sql,
  waitForMail,
} from './support/public-server.mjs';
import { destroyServer, joinPrivateNetwork } from './support/server.mjs';
import { createReport, tail } from './support/simulation-report.mjs';

// System mail through a real SMTP relay that needs a login and STARTTLS, on a
// server with public names: every kind of mail Pertexo sends, the links in it,
// and what people and the operator see when the relay refuses, stalls or speaks
// another TLS mode. Rerun on a Linux machine with Docker and sudo:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/system-mail.test.mjs

const app = `https://${PUBLIC_HOSTS.app}`;
const owner = {
  email: `mail-owner-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-6',
  name: 'Mail Owner',
};
const NO_FAULTS = Object.fromEntries(
  ['Sender', 'Recipient', 'Authentication'].map((trigger) => [
    trigger,
    { ErrorCode: 451, Probability: 0 },
  ]),
);
const record = createReport();

describe('system mail through a real relay', () => {
  let internet;
  let server;
  let client;
  let workspaceId;

  before(async () => {
    internet = await openInternet();
    server = await createPublicServer(internet);
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    await joinPrivateNetwork();
    client = publicClient(internet);
    await createOwner(server, client, owner);
    workspaceId = await createWorkspace(client);
  });
  after(async () => {
    if (process.env.DRILL_KEEP === 'true') return;
    await destroyServer();
    await closeInternet();
  });

  const requestReset = () =>
    client.post('/v1/auth/request-password-reset', {
      email: owner.email,
      redirectTo: `${app}/reset-password`,
    });
  const deliveries = async () =>
    (
      await sql(
        server,
        "select purpose || ' ' || status || ' ' || attempt_count || ' ' || coalesce(failure_code, '-') from app.system_mail_deliveries order by created_at",
      )
    )
      .split('\n')
      .filter(Boolean);
  /** Waits until the newest reset mail has a final outcome: nothing more will be sent. */
  const settled = () =>
    waitFor(
      async () =>
        ['submitted', 'failed', 'reconciliation_required', 'expired'].includes(
          await sql(
            server,
            "select status from app.system_mail_deliveries where purpose = 'password_reset' order by created_at desc limit 1",
          ),
        ),
      { what: 'the reset mail to settle', timeout: 600_000, every: 2_000 },
    );
  const workerSays = async (since) =>
    (
      await compose(server, [
        'logs',
        '--no-log-prefix',
        '--since',
        since,
        'worker',
      ])
    )
      .split('\n')
      // Account mail logs as system_mail.*; invitations fail through their queue job.
      .filter((line) => /system_mail\.|invitation|deliver/iu.test(line))
      // The worker's log lines are already redacted; keep what the operator reads.
      .map((line) => line.slice(0, 700));
  const messagesTo = async (address) =>
    (await mailbox(server)).messages.filter((message) =>
      message.To.some((to) => to.Address === address),
    );
  const headerSummary = (mail) =>
    Object.fromEntries(
      [
        'From',
        'Reply-To',
        'Message-Id',
        'Date',
        'List-Unsubscribe',
        'Auto-Submitted',
      ]
        .map((name) => [
          name,
          Object.entries(mail.headers).find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
          )?.[1]?.[0],
        ])
        .filter(([, value]) => value !== undefined),
    );

  it('mails a password reset whose link works on the public HTTPS name', async () => {
    const asked = await requestReset();
    assert.equal(asked.status, 200, asked.text);
    const mail = await waitForMail(server, owner.email, /reset|password/iu);
    const link = linksIn(mail).find((url) => url.includes('reset-password'));
    record('password reset', {
      links: linksIn(mail),
      headers: headerSummary(mail),
    });
    assert.ok(link?.startsWith(`${app}/`), link);
    const opened = await client.get(link);
    const landing = opened.headers.location ?? '';
    record('password reset', {
      linkStatus: opened.status,
      landing: landing.replace(/token=[^&]+/u, 'token=<token>'),
    });
    assert.ok([302, 303, 307].includes(opened.status), opened.text);
    assert.ok(landing.startsWith(`${app}/reset-password`), landing);
    const token = new URL(landing).searchParams.get('token');
    owner.password = 'correct-horse-battery-staple-7';
    const reset = await client.post(
      '/v1/auth/account-security/password/reset',
      {
        newPassword: owner.password,
        token,
      },
    );
    assert.equal(reset.status, 200, reset.text);
    assert.equal((await signIn(client, owner)).status, 200);
    assert.match(headerSummary(mail).From ?? '', /security@drill\.test/u);
  });

  it('mails an invitation whose link opens on the public HTTPS name', async () => {
    const invitee = `invitee-${randomUUID().slice(0, 8)}@drill.test`;
    const invited = await client.post(
      `/v1/workspaces/${workspaceId}/invitations`,
      {
        email: invitee,
        role: 'builder',
      },
    );
    assert.ok(invited.status < 300, invited.text);
    const mail = await waitForMail(server, invitee, /invit|join/iu);
    const link = linksIn(mail).find((url) => url.includes(PUBLIC_HOSTS.app));
    const opened = await internet.request({ url: link });
    const listed = await client.get(
      `/v1/workspaces/${workspaceId}/invitations`,
    );
    record('invitation', {
      links: linksIn(mail),
      headers: headerSummary(mail),
      linkStatus: opened.status,
      deliveryStatus: listed.json.items.map((item) => item.deliveryStatus),
    });
    assert.ok(link?.startsWith(`${app}/`), link);
    assert.equal(opened.status, 200);
    assert.match(headerSummary(mail).From ?? '', /invites@drill\.test/u);
  });

  it("mails a failure alert through the server's own mail, linking to the run", async () => {
    const members = await client.get(`/v1/workspaces/${workspaceId}/members`);
    const me = members.json.items.find(
      (member) => member.email === owner.email,
    );
    const destination = await client.post(
      `/v1/workspaces/${workspaceId}/failure-notification-destinations`,
      { kind: 'system_mail', memberId: me.userId },
    );
    assert.equal(destination.status, 201, destination.text);
    const workflow = await publishCodeWorkflow(client, workspaceId, {
      code: "throw new Error('the simulated step failed');",
    });
    const policy = await client.put(`${workflow}/failure-notification-policy`, {
      destinationId: destination.json.id,
    });
    assert.equal(policy.status, 204, policy.text);
    const runId = await startRun(client, workflow);
    const ended = await waitForEndedRun(client, workspaceId, runId);
    assert.equal(ended.run.status, 'failed');
    const mail = await waitForMail(server, owner.email, /fail/iu, 120_000);
    record('failure alert', {
      subject: mail.Subject,
      links: linksIn(mail),
      headers: headerSummary(mail),
    });
    assert.ok(
      linksIn(mail).some(
        (url) => url.startsWith(`${app}/`) && url.includes(runId),
      ),
      mail.Text,
    );
  });

  it('tells the operator, not the person, when the relay refuses a recipient', async () => {
    const since = new Date().toISOString();
    const before = (await messagesTo(owner.email)).length;
    await setRelayFaults(server, {
      ...NO_FAULTS,
      Recipient: { ErrorCode: 550, Probability: 100 },
    });
    try {
      const asked = await requestReset();
      assert.equal(asked.status, 200, asked.text);
      const failed = await waitFor(
        async () =>
          (await deliveries()).find((row) =>
            /password_reset failed/u.test(row),
          ),
        {
          what: 'the refused reset to be recorded',
          timeout: 120_000,
          every: 2_000,
        },
      ).catch(() => undefined);
      record('relay refuses', {
        deliveries: await deliveries(),
        worker: await workerSays(since),
      });
      assert.ok(failed, 'a failed delivery with a reason');
      assert.match(failed, /delivery\.recipient/u);
      assert.equal((await messagesTo(owner.email)).length, before);
    } finally {
      await setRelayFaults(server, NO_FAULTS);
    }
  });

  it('retries a temporary refusal and delivers once the relay accepts again', async () => {
    const since = new Date().toISOString();
    const before = (await messagesTo(owner.email)).length;
    await setRelayFaults(server, {
      ...NO_FAULTS,
      Recipient: { ErrorCode: 451, Probability: 100 },
    });
    let restored = false;
    try {
      assert.equal((await requestReset()).status, 200);
      await waitFor(
        async () =>
          (await workerSays(since)).some((line) =>
            JSON.stringify(line).includes('delivery_failed'),
          ),
        {
          what: 'the worker to meet the refusal',
          timeout: 120_000,
          every: 2_000,
        },
      );
      await setRelayFaults(server, NO_FAULTS);
      restored = true;
      const started = Date.now();
      await waitFor(
        async () => (await messagesTo(owner.email)).length > before,
        {
          what: 'the retried mail',
          timeout: 600_000,
          every: 5_000,
        },
      );
      record('relay refuses for a while', {
        secondsToDeliverAfterRecovery: Math.round(
          (Date.now() - started) / 1_000,
        ),
        deliveries: (await deliveries()).slice(-3),
        worker: await workerSays(since),
      });
      // Delivered once: once the queue settles, no retry sends it again.
      await settled();
      assert.equal((await messagesTo(owner.email)).length, before + 1);
    } finally {
      if (!restored) await setRelayFaults(server, NO_FAULTS);
    }
  });

  // Reset requests are rate-limited per person, so the last two use invitations:
  // each goes to a new address, and the owner sees its delivery status.
  const invite = async () => {
    const email = `invitee-${randomUUID().slice(0, 8)}@drill.test`;
    const invited = await client.post(
      `/v1/workspaces/${workspaceId}/invitations`,
      {
        email,
        role: 'viewer',
      },
    );
    assert.ok(invited.status < 300, invited.text);
    return email;
  };
  const invitationStatus = async (email) =>
    (
      await client.get(`/v1/workspaces/${workspaceId}/invitations`)
    ).json.items.find((item) => item.email === email)?.deliveryStatus;
  const relayHealthy = async () =>
    waitFor(
      async () =>
        (await mustDocker([
          'inspect',
          '--format',
          '{{.State.Health.Status}}',
          await server.containerOf('drill-mail'),
        ])) === 'healthy',
      { what: 'the relay to be healthy', timeout: 120_000, every: 2_000 },
    );

  it('retries after the relay stops answering, and delivers once', async () => {
    const since = new Date().toISOString();
    const relay = await server.containerOf('drill-mail');
    await mustDocker(['pause', relay]);
    let paused = true;
    let invitee;
    try {
      invitee = await invite();
      await waitFor(
        async () =>
          (await workerSays(since)).some((line) =>
            /fail|timeout|unknown/iu.test(JSON.stringify(line)),
          ),
        {
          what: 'the worker to give up on the silent relay',
          timeout: 300_000,
          every: 5_000,
        },
      ).catch(() => undefined);
      const whilePaused = {
        worker: await workerSays(since),
        ownerSees: await invitationStatus(invitee),
      };
      await mustDocker(['unpause', relay]);
      paused = false;
      await relayHealthy();
      const started = Date.now();
      const settledStatus = await waitFor(
        async () => {
          const status = await invitationStatus(invitee);
          return ['submitted', 'failed', 'unknown'].includes(status) && status;
        },
        { what: 'the invitation to settle', timeout: 600_000, every: 5_000 },
      );
      const delivered = (await messagesTo(invitee)).length;
      record('relay stalls', {
        whilePaused,
        settledStatus,
        delivered,
        secondsToSettleAfterRecovery: Math.round(
          (Date.now() - started) / 1_000,
        ),
      });
      assert.ok(
        whilePaused.worker.length > 0,
        'the operator can see the stalled relay',
      );
      // Delivered once, or honestly unconfirmed: never twice.
      assert.ok(delivered <= 1, `${delivered} copies`);
      assert.ok(
        delivered === 1 || settledStatus === 'unknown',
        JSON.stringify({ delivered, settledStatus }),
      );
    } finally {
      if (paused) await mustDocker(['unpause', relay]);
    }
  });

  it('names the TLS mismatch when the relay is set to the wrong TLS mode', async () => {
    await relayHealthy();
    await setSettings(server, { SYSTEM_MAIL_SMTP_TLS: 'implicit' });
    const release = await server.current();
    try {
      const deployed = await server.script('deploy.sh', [release]);
      assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
      const since = new Date().toISOString();
      const invitee = await invite();
      const said = await waitFor(
        async () => {
          const lines = await workerSays(since);
          return (
            lines.some((line) =>
              JSON.stringify(line).includes('delivery_failed'),
            ) && lines
          );
        },
        {
          what: 'the worker to report the mismatch',
          timeout: 180_000,
          every: 3_000,
        },
      );
      record('wrong TLS mode', {
        deployOutput: tail(deployed.stdout, 3),
        worker: said,
        ownerSees: await invitationStatus(invitee),
      });
      assert.ok(
        said.some((line) => /tls|network|timeout/iu.test(JSON.stringify(line))),
        JSON.stringify(said),
      );
    } finally {
      await setSettings(server, { SYSTEM_MAIL_SMTP_TLS: 'starttls' });
      const restored = await server.script('deploy.sh', [release]);
      assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    }
  });
});
