import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '@pertexo/workflow-engine/server';

const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
const publishedChecksums: Readonly<Record<string, string>> = {
  'webhook-validation-routing':
    'wf:sha256:v2:eda03fb1d1045dfaf856fd6b6bc074bdea724256a60dbd9fa800b58ac4157d98',
  'schedule-bounded-batch':
    'wf:sha256:v2:a5d3aa59e7f92da90225392f8aab5a3da390bce72e580946a7774e02c2827070',
  'controlled-http-notification':
    'wf:sha256:v2:021265844da90acb81c0cadd710dd2a94bcfc4a152b5251f7820e0eb23890a78',
  'first-run-greeting':
    'wf:sha256:v2:7c7adc253058e103e6a5a58c1b5bd00e8ec8fe0c4fbb3be4fc06db29e7293103',
};

it.each(CURATED_WORKFLOW_TEMPLATES)(
  'keeps the published executable identity of $templateId',
  ({ templateId, manifest }) => {
    const compiled = buildWorkflowExecutable({
      graph: manifest.graph,
      catalog,
    });
    const checksum = publishedChecksums[templateId];
    expect(compiled.checksum).toBe(checksum);
    expect(
      verifyWorkflowExecutable({
        catalog,
        checksum,
        envelope: JSON.parse(JSON.stringify(compiled.envelope)),
      }),
    ).toEqual(compiled);
  },
);

it('verifies the stored pre-v2 executable with the platform catalog', () => {
  const stored = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/core/test/fixtures/legacy-workflow-executable.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { envelope: unknown; checksum: string };
  expect(verifyWorkflowExecutable({ ...stored, catalog })).toEqual(stored);
});
