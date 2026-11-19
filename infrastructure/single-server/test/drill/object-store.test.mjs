import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { must, mustDocker } from './support/process.mjs';
import {
  createWorkspace,
  downloadFile,
  edge,
  node,
  publishWorkflow,
  readStepResult,
  startRun,
  uploadFile,
  waitForEndedRun,
} from './support/product.mjs';
import { closeInternet, openInternet } from './support/public-internet.mjs';
import {
  compose,
  createOwner,
  createPublicServer,
  publicClient,
  sql,
} from './support/public-server.mjs';
import {
  createBackupBucket,
  destroyServer,
  joinPrivateNetwork,
  leavePrivateNetwork,
} from './support/server.mjs';
import { createReport, tail } from './support/simulation-report.mjs';

// The S3 store under a real server: files at the size limit through the public
// files name, then the store slow, down and full while people upload and runs
// write files, then a backup restored onto a fresh server. Nothing may be lost
// or half-written. The store gets a small disk of its own so it fills for real.
// Rerun on a Linux machine with Docker and sudo:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/object-store.test.mjs

// The documented ceiling for one file (ARTIFACT_OBJECT_MAX_BYTES).
const FILE_LIMIT = 10 * 1024 * 1024;
const DISK = '/mnt/pertexo-sim-files';
const DISK_IMAGE = '/var/tmp/pertexo-sim-files.img';
const DISK_MEGABYTES = 1_024;
const person = {
  email: `files-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-8',
  name: 'Files Owner',
};
const record = createReport();
const sudo = (...args) => must('sudo', args);

async function createDisk() {
  await removeDisk();
  await sudo('fallocate', '-l', `${DISK_MEGABYTES}M`, DISK_IMAGE);
  await sudo('mkfs.ext4', '-q', '-F', DISK_IMAGE);
  await sudo('mkdir', '-p', DISK);
  await sudo('mount', '-o', 'loop', DISK_IMAGE, DISK);
  await sudo('chmod', '777', DISK);
}
async function removeDisk() {
  await sudo('umount', DISK).catch(() => undefined);
  await sudo('rm', '-f', DISK_IMAGE);
}

describe('the S3 file store under a real server', () => {
  let internet;
  let server;
  let client;
  let workspaceId;
  let fileWorkflow;
  const kept = new Map();

  before(async () => {
    await createDisk();
    internet = await openInternet();
    server = await createPublicServer(internet, { storageDirectory: DISK });
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    await joinPrivateNetwork();
    await createBackupBucket(server);
    client = publicClient(internet);
    await createOwner(server, client, person);
    workspaceId = await createWorkspace(client);
    fileWorkflow = await publishWorkflow(client, workspaceId, {
      name: 'Write a file',
      nodes: [
        node('start', 'core.manual'),
        node(
          'file',
          'core.create_file',
          { format: 'json' },
          { data: { kind: 'node_output', nodeId: 'start', path: '$' } },
        ),
      ],
      edges: [edge('first', 'start', 'file')],
    });
  });
  after(async () => {
    if (process.env.DRILL_KEEP === 'true') return;
    await destroyServer();
    await closeInternet();
    await removeDisk();
  });

  const storage = () => server.containerOf('storage');
  const keep = async (name, bytes) => {
    const id = await uploadFile(client, workspaceId, bytes);
    kept.set(name, { id, bytes });
    return id;
  };
  /** Runs the file-writing workflow and says how it ended, as its owner sees it. */
  const writeFile = async (bytes, timeout = 300_000) => {
    const runId = await startRun(client, fileWorkflow, {
      padding: 'x'.repeat(bytes),
    });
    const ended = await waitForEndedRun(client, workspaceId, runId, timeout);
    const step = ended.nodes.find((candidate) => candidate.nodeId === 'file');
    const { output } = await readStepResult(client, workspaceId, runId, step);
    return {
      runId,
      status: ended.run.status,
      attempts: step.currentAttemptNumber,
      safeErrorCode: step.safeErrorCode ?? null,
      errorSummary: step.errorSummary ?? null,
      artifactId:
        output?.value?.file?.artifactId ?? output?.value?.file?.id ?? null,
    };
  };
  /** Every file the database calls available really is there, byte for byte. */
  const everyAvailableFileIsWhole = async () => {
    const rows = (
      await sql(
        server,
        `select id || ' ' || sha256 || ' ' || byte_length from app.artifacts where status = 'available' and workspace_id = '${workspaceId}'`,
      )
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '));
    for (const [id, sha256, length] of rows) {
      const bytes = await downloadFile(client, workspaceId, id);
      assert.equal(bytes.length, Number(length), id);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        sha256,
        id,
      );
    }
    return rows.length;
  };
  const pending = async () =>
    Number(
      await sql(
        server,
        "select count(*) from app.artifacts where status = 'pending'",
      ),
    );
  /** Tries an upload the way a browser does, and reports where it stopped. */
  const tryUpload = async (bytes) => {
    const artifacts = `/v1/workspaces/${workspaceId}/artifacts`;
    const begun = await client.post(`${artifacts}/uploads`, {
      byteLength: bytes.length,
      mediaType: 'text/plain',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (begun.status !== 201) return { begin: begun.status, text: begun.text };
    const { artifact, upload } = begun.json;
    const stored = await client
      .anonymous(upload.method, upload.url, bytes, upload.headers)
      .catch((error) => ({ status: error.message }));
    const finalized = await client.post(
      `${artifacts}/${artifact.id}/finalize`,
      {},
    );
    return {
      artifactId: artifact.id,
      begin: begun.status,
      store: stored.status,
      finalize: finalized.status,
      finalizeProblem: finalized.json?.type ?? finalized.text?.slice(0, 200),
    };
  };

  it('takes a file at the size limit through the public files name, and refuses a larger one', async () => {
    const largest = randomBytes(FILE_LIMIT);
    const started = Date.now();
    const id = await keep('largest', largest);
    const uploadSeconds = (Date.now() - started) / 1_000;
    assert.deepEqual(await downloadFile(client, workspaceId, id), largest);
    const larger = await client.post(
      `/v1/workspaces/${workspaceId}/artifacts/uploads`,
      {
        byteLength: FILE_LIMIT + 1,
        mediaType: 'text/plain',
        sha256: createHash('sha256')
          .update(Buffer.alloc(FILE_LIMIT + 1))
          .digest('hex'),
      },
    );
    record('size limit', {
      uploadSeconds,
      largerStatus: larger.status,
      largerProblem: larger.json?.type,
    });
    assert.equal(larger.status, 413, larger.text);
  });

  it('writes a file from a run that its owner can download', async () => {
    const written = await writeFile(1_000);
    record('run writes a file', written);
    assert.equal(written.status, 'succeeded', JSON.stringify(written));
    assert.ok(written.artifactId, JSON.stringify(written));
  });

  it('keeps working while the store answers slowly', async () => {
    const pid = await mustDocker([
      'inspect',
      '--format',
      '{{.State.Pid}}',
      await storage(),
    ]);
    await sudo(
      'nsenter',
      '--target',
      pid,
      '--net',
      'tc',
      'qdisc',
      'add',
      'dev',
      'eth0',
      'root',
      'netem',
      'delay',
      '1500ms',
    );
    try {
      const started = Date.now();
      const id = await keep('while slow', randomBytes(1024 * 1024));
      const uploadSeconds = (Date.now() - started) / 1_000;
      const written = await writeFile(1_000);
      record('store slow', { uploadSeconds, run: written });
      assert.ok(id);
      assert.equal(written.status, 'succeeded', JSON.stringify(written));
    } finally {
      await sudo(
        'nsenter',
        '--target',
        pid,
        '--net',
        'tc',
        'qdisc',
        'del',
        'dev',
        'eth0',
        'root',
      );
    }
  });

  it('fails clearly while the store is down, loses nothing, and recovers', async () => {
    const pendingBefore = await pending();
    await compose(server, ['stop', 'storage']);
    let upload;
    let download;
    let written;
    try {
      upload = await tryUpload(randomBytes(64 * 1024));
      download = await client
        .get(
          `/v1/workspaces/${workspaceId}/artifacts/${kept.get('largest').id}/download`,
        )
        .then(async (link) =>
          link.status === 200
            ? (await client.anonymous('GET', link.json.url)).status
            : link.status,
        );
      written = await writeFile(1_000, 240_000).catch((error) => ({
        error: error.message,
      }));
    } finally {
      await compose(server, ['up', '-d', '--no-deps', '--wait', 'storage']);
    }
    record('store down', { upload, download, run: written });
    assert.notEqual(upload.store, 200);
    assert.notEqual(upload.finalize, 200, JSON.stringify(upload));
    assert.notEqual(
      upload.finalize,
      500,
      'a store outage is not an unexpected error',
    );
    assert.ok(
      written.status === 'failed'
        ? written.safeErrorCode
        : written.status === 'succeeded',
      JSON.stringify(written),
    );
    assert.ok(
      (await pending()) >= pendingBefore,
      'the refused upload stays pending, never available',
    );
    // It comes back: uploads and runs work again.
    await keep('after outage', randomBytes(64 * 1024));
    assert.equal((await writeFile(1_000)).status, 'succeeded');
    await everyAvailableFileIsWhole();
  });

  it('fails clearly while the store is full, loses nothing, and recovers', async () => {
    const free = async () =>
      Number(
        (await must('df', ['-B1', '--output=avail', DISK])).split('\n').at(-1),
      );
    const fill = async (name, leave) =>
      sudo(
        'fallocate',
        '-l',
        String(Math.max(0, (await free()) - leave)),
        `${DISK}/${name}`,
      );
    let upload;
    let written;
    try {
      // Room for a little, not for a whole file at the limit: it fills partway through.
      await fill('filler', 4 * 1024 * 1024);
      upload = await tryUpload(randomBytes(FILE_LIMIT));
      await fill('filler-rest', 0);
      written = await writeFile(1_000, 240_000).catch((error) => ({
        error: error.message,
      }));
      record('store full', {
        upload,
        run: written,
        storageLog: tail(
          await compose(server, [
            'logs',
            '--no-log-prefix',
            '--tail',
            '40',
            'storage',
          ]),
          6,
        ),
      });
    } finally {
      await sudo('rm', '-f', `${DISK}/filler`, `${DISK}/filler-rest`);
    }
    assert.notEqual(upload.finalize, 200, JSON.stringify(upload));
    assert.notEqual(
      upload.finalize,
      500,
      'a full store is not an unexpected error',
    );
    assert.ok(
      written.status === 'failed'
        ? written.safeErrorCode
        : written.status === 'succeeded',
      JSON.stringify(written),
    );
    await keep('after full', randomBytes(FILE_LIMIT));
    assert.equal((await writeFile(1_000)).status, 'succeeded');
    const whole = await everyAvailableFileIsWhole();
    record('store full', { availableFilesChecked: whole });
  });

  it('restores every file onto a fresh server from a backup', async () => {
    const release = await server.current();
    const backup = await server.script('backup.sh');
    assert.equal(backup.status, 0, backup.stdout + backup.stderr);
    const point = /Completed recovery point: (\S+)/u.exec(backup.stdout)[1];
    const files = Number(
      await sql(
        server,
        "select count(*) from app.artifacts where status = 'available'",
      ),
    );

    await leavePrivateNetwork();
    const wiped = await server.composeFor(release, [
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
    assert.equal(wiped.status, 0, wiped.stderr);
    await sudo('find', DISK, '-mindepth', '1', '-delete');
    const outside = await server.composeFor(release, [
      'up',
      '-d',
      'drill-backup-proxy',
    ]);
    assert.equal(outside.status, 0, outside.stderr);
    await server.mustExec('rm -rf state/* state/.[!.]*');
    const restored = await server.script('restore.sh', [point, release]);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const resumed = await server.script('deploy.sh', [release]);
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    await joinPrivateNetwork();

    for (const [name, { id, bytes }] of kept)
      assert.deepEqual(
        await downloadFile(client, workspaceId, id),
        bytes,
        name,
      );
    const whole = await everyAvailableFileIsWhole();
    record('backup and restore', {
      recoveryPoint: point,
      filesBefore: files,
      filesRestored: whole,
    });
    assert.equal(whole, files);
  });
});
