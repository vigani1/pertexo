import { open, unlink } from 'node:fs/promises';
import { PERTEXO_HOST_RELEASE } from '@pertexo/node-sdk/server';
import { AutomationCommandError } from '../commands/automation-command.errors.js';
import {
  CONFORMANCE_FILE,
  SYNTHETIC_CREDENTIAL_PREFIX,
  type ConformanceExample,
} from './conformance.schemas.js';

export const INTEGRATION_FILE = 'integration.json';
const SCAFFOLD_JSON_INDENT = 2;

export async function initIntegration() {
  const release = {
    format: 1,
    publisher: 'example',
    integration: 'posts',
    version: '1.0.0',
    hostRelease: { min: PERTEXO_HOST_RELEASE, below: nextMajorRelease() },
    presentation: {
      name: 'Example Posts',
      description: 'Read posts by ID.',
      icon: 'globe',
    },
    origin: 'https://example-posts.provider.test',
    connection: {
      fields: { apiKey: { label: 'API key', kind: 'secret' } },
      auth: { kind: 'named_header', field: 'apiKey', name: 'X-API-Key' },
      test: { method: 'GET', path: '/posts/1' },
    },
    actions: [
      {
        key: 'getpost',
        name: 'Get post',
        description: 'Read one post by ID.',
        input: { id: { type: 'integer', required: true } },
        output: { title: { type: 'string', required: true } },
        method: 'GET',
        path: '/posts/{id}',
        projection: { title: '/title' },
        sideEffect: 'safe',
        connection: 'connection',
      },
    ],
  };
  const example: ConformanceExample = {
    operation: 'getpost',
    input: { id: 1 },
    request: {
      method: 'GET',
      path: '/posts/1',
      headers: { 'x-api-key': `${SYNTHETIC_CREDENTIAL_PREFIX}apiKey` },
    },
    response: { status: 200, body: { title: 'Hello' } },
    output: { title: 'Hello' },
  };
  const readme = `# Example Posts

Set your publisher and integration slugs, version, HTTPS origin and recipes in
\`${INTEGRATION_FILE}\`. Document which endpoints receive credentials and workflow data
in this README.

Update \`${CONFORMANCE_FILE}\` with an example for each recipe you want to check.
Each example describes the operation key, inputs, expected request, provider
response and expected step output. Request paths include any query string.
Expected headers use lowercase names. The CLI supplies \`${SYNTHETIC_CREDENTIAL_PREFIX}<fieldName>\`
for each credential field. Use sample data throughout.

Run \`pertexo integration check\` from this folder. Publish \`${INTEGRATION_FILE}\`
and its SHA-256 as release assets.
`;
  const files = Object.entries({
    [INTEGRATION_FILE]: formatJson(release),
    [CONFORMANCE_FILE]: formatJson([example]),
    'README.md': readme,
  });
  const written: string[] = [];
  let currentFile = INTEGRATION_FILE;
  try {
    for (const [file, contents] of files) {
      currentFile = file;
      const handle = await open(file, 'wx');
      written.push(file);
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
    }
  } catch (cause) {
    await Promise.allSettled(written.map((file) => unlink(file)));
    const exists =
      cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
    throw new AutomationCommandError(
      'cli.integration_init_failed',
      exists
        ? `${currentFile} already exists. Use an empty author folder.`
        : `Could not write ${currentFile}.`,
      undefined,
      exists ? { status: 409 } : {},
    );
  }
  return { files: written };
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, SCAFFOLD_JSON_INDENT)}\n`;
}

function nextMajorRelease(): string {
  const [major] = PERTEXO_HOST_RELEASE.split('.');
  return `${String(Number(major) + 1)}.0.0`;
}
