import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CURATED_TEMPLATE_GATES,
  assertCuratedQualification,
} from './curated-template-gates.mjs';
import {
  WORKFLOW_ORGANIZATION_GATES,
  assertWorkflowOrganizationQualification,
  validateWorkflowOrganizationQualificationDirectory,
} from './workflow-organization-gates.mjs';

function manifestFor(gates = WORKFLOW_ORGANIZATION_GATES) {
  const started = {
    head: 'a'.repeat(40),
    fingerprint: 'b'.repeat(64),
    dirty: false,
  };
  return {
    version: 1,
    outcome: 'passed',
    source: { started, completed: { ...started } },
    gates: gates.map(({ id, minimumTests, command }) => ({
      id,
      minimumTests,
      command: [...command],
      status: 'passed',
      report: `${id}.json`,
      reportSha256: 'c'.repeat(64),
      counts: {
        success: true,
        numTotalTests: minimumTests,
        numPassedTests: minimumTests,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
      },
      result: { passed: minimumTests, total: minimumTests },
    })),
  };
}

test('registry freezes exact DB95/API20/process6/browser4 commands and opt-in flags', () => {
  assert.deepEqual(
    WORKFLOW_ORGANIZATION_GATES.map(({ id, minimumTests }) => [
      id,
      minimumTests,
    ]),
    [
      ['organization-database', 95],
      ['organization-api', 20],
      ['organization-process', 6],
      ['organization-browser', 4],
    ],
  );
  const [database, api, processGate, browser] = WORKFLOW_ORGANIZATION_GATES;
  assert.deepEqual(database.command.slice(8), [
    'test/workflow-organization.integration.test.ts',
    'test/workflow-organization-read.integration.test.ts',
    'test/workflow-organization-readiness.integration.test.ts',
    'test/workflow-organization-maintenance-plans.integration.test.ts',
    'test/workflow-folders-batch.integration.test.ts',
    'test/workflow-organization-adapters.integration.test.ts',
    'test/workflow-tags.integration.test.ts',
  ]);
  assert.deepEqual(api.command.slice(8), [
    'test/workflow-authoring/organization.integration.test.ts',
    'test/workflow-authoring/favorite-persistence.integration.test.ts',
    'test/workflow-authoring/folders-bulk.integration.test.ts',
  ]);
  assert.deepEqual(processGate.command, [
    'node',
    '--test',
    '--test-reporter=./infrastructure/testing/curated-cutover-gate-reporter.mjs',
    'infrastructure/testing/organization-process.integration.test.mjs',
    'infrastructure/testing/organization-process-owner.test.mjs',
  ]);
  assert.deepEqual(browser.command.slice(8), [
    'test/workflow-organization-browser.integration.test.ts',
  ]);
  assert.deepEqual(database.environment, {
    F07_ORGANIZATION_OWNED_FIXTURE: 'true',
  });
  assert.deepEqual(api.environment, database.environment);
  assert.deepEqual(processGate.environment, {
    F07_PROCESS_OWNED_QUALIFICATION: 'true',
  });
  assert.deepEqual(browser.environment, {
    F07_ORGANIZATION_OWNED_FIXTURE: 'true',
    F07_ORGANIZATION_BROWSER_INTEGRATION: 'true',
  });
  assert.ok(Object.isFrozen(WORKFLOW_ORGANIZATION_GATES));
  for (const gate of WORKFLOW_ORGANIZATION_GATES) {
    assert.ok(Object.isFrozen(gate));
    assert.ok(Object.isFrozen(gate.command));
    assert.ok(Object.isFrozen(gate.environment));
    assert.throws(() => gate.command.push('extra'), TypeError);
    assert.throws(() => {
      gate.environment.BYPASS = 'true';
    }, TypeError);
  }
  const manifest = manifestFor();
  assert.equal(assertWorkflowOrganizationQualification(manifest), manifest);
});

const mutations = {
  'wrong schema version': (m) => {
    m.version = 2;
  },
  'failed outcome': (m) => {
    m.outcome = 'failed';
  },
  'dirty start': (m) => {
    m.source.started.dirty = true;
  },
  'dirty completion': (m) => {
    m.source.completed.dirty = true;
  },
  'missing completion': (m) => {
    delete m.source.completed;
  },
  'malformed source head': (m) => {
    m.source.started.head = 'a'.repeat(39);
  },
  'malformed source fingerprint': (m) => {
    m.source.started.fingerprint = 'b'.repeat(63);
  },
  'changed source head': (m) => {
    m.source.completed.head = 'd'.repeat(40);
  },
  'changed source fingerprint': (m) => {
    m.source.completed.fingerprint = 'd'.repeat(64);
  },
  'missing gate': (m) => {
    m.gates.pop();
  },
  'extra gate': (m) => {
    m.gates.push(m.gates[0]);
  },
  'duplicate gate': (m) => {
    m.gates[1] = m.gates[0];
  },
  'reordered gates': (m) => {
    m.gates.reverse();
  },
  'running gate': (m) => {
    m.gates[0].status = 'running';
  },
  'changed minimum': (m) => {
    m.gates[0].minimumTests = 1;
  },
  'substituted command': (m) => {
    m.gates[0].command = ['node', 'fake'];
  },
  'omitted suite': (m) => {
    m.gates[0].command.pop();
  },
  'escaped report path': (m) => {
    m.gates[0].report = '../organization-database.json';
  },
  'malformed report hash': (m) => {
    m.gates[0].reportSha256 = 'c'.repeat(63);
  },
  'false success': (m) => {
    m.gates[0].counts.success = false;
  },
  'failed tests': (m) => {
    m.gates[0].counts.numFailedTests = 1;
  },
  'skipped tests': (m) => {
    m.gates[0].counts.numPendingTests = 1;
    m.gates[0].counts.numPassedTests--;
  },
  'todo tests': (m) => {
    m.gates[0].counts.numTodoTests = 1;
  },
  'missing passing count': (m) => {
    delete m.gates[0].counts.numPassedTests;
  },
  'fractional count': (m) => {
    m.gates[0].counts.numTotalTests = 94.5;
  },
  'unsafe count': (m) => {
    m.gates[0].counts.numTotalTests = Number.MAX_SAFE_INTEGER + 1;
  },
  'too few tests': (m) => {
    m.gates[0].counts.numPassedTests--;
    m.gates[0].counts.numTotalTests--;
  },
  'extra passing test': (m) => {
    m.gates[0].counts.numPassedTests++;
    m.gates[0].counts.numTotalTests++;
  },
  'inconsistent result': (m) => {
    m.gates[0].result.passed--;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`F07 evidence rejects ${name}`, () => {
    const manifest = manifestFor();
    mutate(manifest);
    assert.throws(() => assertWorkflowOrganizationQualification(manifest));
  });

test('common extraction preserves F06 minimum counts and exact existing errors', () => {
  const manifest = manifestFor(CURATED_TEMPLATE_GATES);
  manifest.gates[0].counts.numTotalTests++;
  manifest.gates[0].counts.numPassedTests++;
  manifest.gates[0].result.total++;
  manifest.gates[0].result.passed++;
  assert.equal(assertCuratedQualification(manifest), manifest);
  assert.throws(() => assertCuratedQualification({}), {
    message:
      'Curated qualification requires stable clean source-bound passing evidence',
  });
  manifest.gates.pop();
  assert.throws(() => assertCuratedQualification(manifest), {
    message: 'Curated qualification requires all four owned gates',
  });
});

test('F07 directory validates report bytes/counts and exact expected source', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-f07-gates-unit-'),
  );
  const manifest = manifestFor();
  const persist = () =>
    writeFile(
      path.join(directory, 'qualification.json'),
      JSON.stringify(manifest),
    );
  try {
    for (const gate of manifest.gates) {
      const bytes = JSON.stringify(gate.counts);
      gate.reportSha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(path.join(directory, gate.report), bytes);
    }
    await persist();
    assert.deepEqual(
      await validateWorkflowOrganizationQualificationDirectory(
        directory,
        manifest.source.started,
      ),
      manifest,
    );
    for (const field of ['head', 'fingerprint'])
      await assert.rejects(
        validateWorkflowOrganizationQualificationDirectory(directory, {
          ...manifest.source.started,
          [field]: 'd'.repeat(field === 'head' ? 40 : 64),
        }),
        /different qualification source/u,
      );
    const gate = manifest.gates[0];
    const bytes = ` ${JSON.stringify(gate.counts)}`;
    await writeFile(path.join(directory, gate.report), bytes);
    await assert.rejects(
      validateWorkflowOrganizationQualificationDirectory(directory),
      /report changed/u,
    );
    // Matching byte hash cannot hide a report inconsistent with manifest counts.
    const substituted = JSON.stringify({ ...gate.counts, numPassedTests: 0 });
    await writeFile(path.join(directory, gate.report), substituted);
    gate.reportSha256 = createHash('sha256').update(substituted).digest('hex');
    await persist();
    await assert.rejects(
      validateWorkflowOrganizationQualificationDirectory(directory),
      /report changed/u,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
