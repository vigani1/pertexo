import assert from 'node:assert/strict';
import test from 'node:test';

import { unresolvedDistReferences } from './validate-dist-references.mjs';

const sources = new Set([
  'packages/secrets/src/outbound-http/redaction/stream-redaction.ts',
  'apps/worker/src/mail/invitation-delivery.ts',
  'packages/database/src/migrate.ts',
]);
const exists = (absolute) =>
  [...sources].some((source) => absolute.endsWith(`/${source}`));

test('accepts a built-file path whose source exists', () => {
  assert.deepEqual(
    unresolvedDistReferences(
      'packages/secrets/test/outbound-http/work.test.ts',
      "new URL('../../dist/outbound-http/redaction/stream-redaction.js', import.meta.url)",
      exists,
    ),
    [],
  );
  assert.deepEqual(
    unresolvedDistReferences(
      'apps/api/test/browser/workflow-organization/mail.ts',
      "'../../../../worker/dist/mail/invitation-delivery.js'",
      exists,
    ),
    [],
  );
  assert.deepEqual(
    unresolvedDistReferences(
      'compose.yaml',
      'command: node packages/database/dist/migrate.js',
      exists,
    ),
    [],
  );
});

test('refuses a built-file path left behind by a move', () => {
  const [finding] = unresolvedDistReferences(
    'packages/secrets/test/outbound-http/work.test.ts',
    "new URL('../../dist/outbound-http/stream-redaction.js', import.meta.url)",
    exists,
  );
  assert.match(
    finding,
    /packages\/secrets\/src\/outbound-http\/stream-redaction\.ts doesn't exist/u,
  );
});

test('ignores package specifiers that only contain a dist segment', () => {
  assert.deepEqual(
    unresolvedDistReferences(
      'packages/contracts/test/schema.test.ts',
      "import Ajv from 'ajv/dist/2020.js';",
      exists,
    ),
    [],
  );
});

const entries = (workspace) =>
  workspace === 'packages/artifact-store'
    ? ['packages/artifact-store/dist/server.js']
    : [];
const withConfig = (absolute) =>
  exists(absolute) ||
  absolute.endsWith('/packages/artifact-store/src/config.ts') ||
  absolute.endsWith('/packages/artifact-store/src/server.ts');

test('a host-mounted script may load only entry points or named internals', () => {
  const script = 'infrastructure/single-server/backup/stores.mjs';
  assert.deepEqual(
    unresolvedDistReferences(
      script,
      "import { parse } from '../../../packages/artifact-store/dist/server.js';",
      withConfig,
      entries,
    ),
    [],
  );
  assert.match(
    unresolvedDistReferences(
      script,
      "import { parse } from '../../../packages/artifact-store/dist/config.js';",
      withConfig,
      entries,
    ).join(),
    /internal file that can move between releases/u,
  );
  assert.deepEqual(
    unresolvedDistReferences(
      'infrastructure/single-server/backup/qualify.mjs',
      "import { parse } from '../../../packages/artifact-store/dist/config.js';",
      withConfig,
      entries,
    ),
    [],
  );
});

test('reads workflow, shell and Markdown paths from the repository root', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    'infrastructure/scripts/run.sh',
    'docs/operations/deploying.md',
  ]) {
    assert.deepEqual(
      unresolvedDistReferences(
        file,
        "import('./packages/database/dist/migrate.js')",
        exists,
      ),
      [],
    );
    const [finding] = unresolvedDistReferences(
      file,
      "import('./packages/database/dist/migrations.js')",
      exists,
    );
    assert.match(
      finding,
      /packages\/database\/src\/migrations\.ts doesn't exist/u,
    );
  }
});

test('reads /workspace paths as the repository root inside the image', () => {
  const [finding] = unresolvedDistReferences(
    '.github/workflows/ci.yml',
    "Cannot find module '/workspace/packages/database/dist/migrations.js'",
    exists,
  );
  assert.match(
    finding,
    /packages\/database\/src\/migrations\.ts doesn't exist/u,
  );
  assert.deepEqual(
    unresolvedDistReferences(
      'Dockerfile',
      'RUN node /workspace/packages/database/dist/migrate.js',
      exists,
    ),
    [],
  );
});

test('allows an older release path only where it is listed', () => {
  assert.deepEqual(
    unresolvedDistReferences(
      'docs/operations/upgrading.md',
      'await import("./packages/database/dist/migrations.js")',
      exists,
    ),
    [],
  );
  assert.equal(
    unresolvedDistReferences(
      'docs/operations/other.md',
      'await import("./packages/database/dist/migrations.js")',
      exists,
    ).length,
    1,
  );
});
