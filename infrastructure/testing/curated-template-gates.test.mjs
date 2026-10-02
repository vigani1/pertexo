import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CURATED_TEMPLATE_GATES,
  assertCuratedQualification,
  validateCuratedQualificationDirectory,
} from './curated-template-gates.mjs';

function fixture() {
  const source = {
    head: 'a'.repeat(40),
    fingerprint: 'b'.repeat(64),
    dirty: false,
  };
  return {
    version: 1,
    outcome: 'passed',
    source: { started: source, completed: { ...source } },
    gates: CURATED_TEMPLATE_GATES.map((gate) => ({
      id: gate.id,
      minimumTests: gate.minimumTests,
      command: gate.command,
      status: 'passed',
      report: `${gate.id}.json`,
      reportSha256: 'c'.repeat(64),
      counts: {
        success: true,
        numTotalTests: gate.minimumTests,
        numPassedTests: gate.minimumTests,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
      },
      result: { passed: gate.minimumTests, total: gate.minimumTests },
    })),
  };
}

test('curated qualification requires exactly all four strict source-bound gates', () => {
  assert.deepEqual(
    CURATED_TEMPLATE_GATES.map(({ minimumTests }) => minimumTests),
    [2340, 16, 1, 10],
  );
  assert.doesNotThrow(() => assertCuratedQualification(fixture()));
  const mutations = [
    (m) => {
      m.outcome = 'running';
    },
    (m) => {
      m.source.started.dirty = true;
    },
    (m) => {
      m.source.completed.head = 'd'.repeat(40);
    },
    (m) => {
      m.source.completed.fingerprint = 'd'.repeat(64);
    },
    (m) => {
      m.gates.pop();
    },
    (m) => {
      m.gates[0].minimumTests = 1;
    },
    (m) => {
      m.gates[0].command = ['node', 'fake'];
    },
    (m) => {
      m.gates[0].report = '../escape.json';
    },
    (m) => {
      m.gates[0].counts.numPassedTests--;
      m.gates[0].counts.numPendingTests++;
    },
    (m) => {
      m.gates[0].counts.numFailedTests++;
    },
    (m) => {
      m.gates[0].result.passed--;
    },
  ];
  for (const mutation of mutations) {
    const manifest = fixture();
    mutation(manifest);
    assert.throws(() => assertCuratedQualification(manifest));
  }
});

test('curated evidence revalidates actual report bytes and rejects another source', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-curated-evidence-unit-'),
  );
  try {
    const manifest = fixture();
    for (const gate of manifest.gates) {
      const bytes = JSON.stringify(gate.counts);
      gate.reportSha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(path.join(directory, gate.report), bytes);
    }
    await writeFile(
      path.join(directory, 'qualification.json'),
      JSON.stringify(manifest),
    );
    await validateCuratedQualificationDirectory(
      directory,
      manifest.source.started,
    );
    await assert.rejects(
      validateCuratedQualificationDirectory(directory, {
        ...manifest.source.started,
        head: 'd'.repeat(40),
      }),
      /different qualification source/u,
    );
    await writeFile(path.join(directory, manifest.gates[0].report), '{}');
    await assert.rejects(
      validateCuratedQualificationDirectory(directory),
      /report changed/u,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
