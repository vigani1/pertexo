import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const workflowDirectory = new URL('.github/workflows/', root);
const workflows = (
  await Promise.all(
    (await readdir(workflowDirectory)).map((name) =>
      readFile(new URL(name, workflowDirectory), 'utf8'),
    ),
  )
).join('\n');
const policy = await read('SECURITY.md');
const imageProcedure = await read('docs/ci-image-update-procedure.md');

/** A check the policy may name, and what its existence looks like in CI. */
const CHECKS = [
  {
    claim: /dependency review/iu,
    evidence: /actions\/dependency-review-action@/u,
  },
  { claim: /dependency audit/iu, evidence: /pnpm security:audit/u },
  { claim: /CodeQL/u, evidence: /github\/codeql-action\/analyze@/u },
  {
    claim: /image scan/iu,
    evidence:
      /aquasecurity\/trivy-action@|anchore\/scan-action@|docker\/scout-action@|\btrivy image\b|\bgrype\b/u,
  },
];

function untrueClaims(text) {
  return CHECKS.filter(
    ({ claim, evidence }) => claim.test(text) && !evidence.test(workflows),
  ).map(({ claim }) => claim.source);
}

test('SECURITY.md names no check CI does not run', () => {
  assert.deepEqual(untrueClaims(policy), []);
});

test('the image update procedure asks for no scan CI does not run', () => {
  assert.deepEqual(untrueClaims(imageProcedure), []);
});
