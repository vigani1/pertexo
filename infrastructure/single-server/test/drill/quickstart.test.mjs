import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe } from 'node:test';
import { it } from '../support/it.mjs';
import { createClient } from './support/client.mjs';
import {
  removeReleaseTags,
  requireImages,
  tagRelease,
} from './support/images.mjs';
import { docker, run, waitFor } from './support/process.mjs';
import {
  createWorkspace,
  downloadFile,
  publishWebhookWorkflow,
  sendWebhook,
  signIn,
  signUp,
  uploadFile,
  waitForSucceededRun,
} from './support/product.mjs';

// ops-10, docs-deps-product-06: the five-minute evaluation. Runs the README's command as
// written, from a checkout, with nothing else set up: no settings file, DNS or mail.
// The three variables below only let it run beside other things on a shared machine.
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const project = process.env.DRILL_QUICKSTART_PROJECT ?? 'pertexo-b1-quickstart';
const port = Number(process.env.DRILL_QUICKSTART_PORT ?? 64488);
const tag = 'drill-quickstart';
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  QUICKSTART_PORT: String(port),
  PERTEXO_VERSION: tag,
};
const composeFile = 'infrastructure/quickstart/compose.yaml';
const person = {
  email: `quick-${randomUUID().slice(0, 8)}@example.test`,
  password: 'correct-horse-battery-staple-2',
  name: 'Quick Person',
};
const file = randomBytes(1_024);

const documentedCommand = () => {
  const readme = readFileSync(`${repositoryRoot}README.md`, 'utf8');
  const start = readme.search(/^## .*(try|quick)/imu);
  assert.ok(start >= 0, 'a README section for the quick try');
  const block = /```(?:sh|bash)\n([\s\S]*?)```/u.exec(readme.slice(start));
  assert.ok(block, 'a command block');
  return block[1].trim();
};
const shell = (command) =>
  run('sh', ['-c', command], { cwd: repositoryRoot, env: environment });
const compose = (...args) =>
  run('docker', ['compose', '-f', composeFile, ...args], {
    cwd: repositoryRoot,
    env: environment,
  });

describe('the one-command quick try', () => {
  const client = createClient({ origin: `http://127.0.0.1:${port}` });
  let workspaceId;
  let artifactId;

  before(async () => {
    await requireImages();
    await tagRelease(tag);
  });
  after(async () => {
    await compose('down', '--volumes', '--remove-orphans');
    await removeReleaseTags([tag]);
    await docker(['network', 'rm', `${project}_default`]);
  });

  it.fails(
    'starts from the documented command and serves the app',
    async () => {
      const started = await shell(documentedCommand());
      assert.equal(started.status, 0, started.stdout + started.stderr);
      const page = await client.get('/');
      assert.equal(page.status, 200);
      assert.match(page.text, /<html/iu);
    },
  );

  it.fails('lets someone in with no mail relay', async () => {
    assert.equal((await signUp(client, person)).status, 200);
    let response = await signIn(client, person);
    if (response.status !== 200) {
      // A mail link printed to the logs is the other allowed way in.
      const logs = await compose('logs', '--no-log-prefix');
      const link = /https?:\/\/\S*verify\S*/u
        .exec(logs.stdout)?.[0]
        .replace(/["\\].*$/u, '');
      assert.ok(link, 'a verification link in the logs');
      const opened = await client.get(link);
      assert.ok(opened.status < 400, opened.text);
      response = await signIn(client, person);
    }
    assert.equal(response.status, 200, response.text);
  });

  it.fails(
    'runs a published workflow from a webhook through a Code step',
    async () => {
      workspaceId = await createWorkspace(client);
      const key = await publishWebhookWorkflow(client, workspaceId);
      await waitForSucceededRun(
        client,
        workspaceId,
        await sendWebhook(client, key),
      );
    },
  );

  it.fails('stores and returns a file on the one address', async () => {
    artifactId = await uploadFile(client, workspaceId, file);
    assert.deepEqual(await downloadFile(client, workspaceId, artifactId), file);
  });

  it.fails(
    'keeps its generated secrets and data across a restart',
    async () => {
      assert.equal((await compose('down')).status, 0);
      assert.equal((await shell(documentedCommand())).status, 0);
      await waitFor(
        async () => (await client.get('/v1/workspaces')).status === 200,
        { what: 'the old session to work', timeout: 60_000 },
      );
      assert.deepEqual(
        await downloadFile(client, workspaceId, artifactId),
        file,
      );
    },
  );
});
