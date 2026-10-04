import { createAuthoringJobRuntime } from '@pertexo/workflow-model/authoring-validation';
import { createRegistryRelease } from '@pertexo/node-sdk';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { describe, expect, it } from 'vitest';
import {
  createCallableTargetAssessor,
  createCallableTargetWorkerAdapter,
} from '../src/compilation/callable-target-assessment-adapter.js';
import {
  CALLABLE_TARGET_ASSESSMENT_PURPOSE,
  parseCallableTargetAssessmentReport,
  type CallableTargetAssessmentSnapshot,
} from '../src/compilation/callable-target-assessment-contracts.js';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '../src/compilation/executable-v3.js';
import { graph, nodeRelease } from './executable-workflow.fixtures.js';
import {
  createCallableTargetWorkerAdapter as compiledAdapter,
  createCallableTargetAssessor as compiledAssessor,
} from '../dist/index.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const workflowId = '00000000-0000-4000-8000-000000000002';
const versionId = '00000000-0000-4000-8000-000000000003';
const descriptor = { type: 'object', properties: {}, required: [] } as const;
const declaration = {
  schemaVersion: 1,
  input: descriptor,
  result: descriptor,
  resultSelector: { kind: 'literal', value: {} },
} as const;
function fixture(callable = true): CallableTargetAssessmentSnapshot {
  const release = composeExecutableCompatibilityReleaseV3(nodeRelease());
  const source = {
    ...graph(),
    schemaVersion: 2,
    ...(callable ? { callable: declaration } : {}),
  };
  const compiled = buildWorkflowExecutableV3({ graph: source, release });
  const releaseSnapshot = {
    epoch: release.epoch,
    fingerprint: release.fingerprint,
    releaseJson: JSON.stringify(release),
  };
  return {
    purpose: CALLABLE_TARGET_ASSESSMENT_PURPOSE,
    version: 1,
    workspaceId,
    currentRelease: releaseSnapshot,
    entries: [
      {
        workflowId,
        versionId,
        sourceJson: JSON.stringify(source),
        executableJson: JSON.stringify(compiled.envelope),
        checksum: compiled.checksum,
        callableContractIdentity: callable
          ? workflowCallableContractIdentityV1(declaration)
          : null,
        admissionRelease: releaseSnapshot,
      },
    ],
  };
}
async function assess(snapshot: CallableTargetAssessmentSnapshot) {
  const jobs = createAuthoringJobRuntime({
    callableTargetAdapter: createCallableTargetWorkerAdapter(),
  });
  try {
    const report = await createCallableTargetAssessor(
      jobs.callableTargets,
    ).assess(snapshot);
    expect(jobs.diagnostics()).toMatchObject({ active: 0, queued: 0 });
    return report;
  } finally {
    await jobs.shutdown();
  }
}
describe('fixed compiled callable target assessment (synthetic, non-runtime)', () => {
  it('exposes the factory through the actual compiled public package entry', async () => {
    const jobs = createAuthoringJobRuntime({
      callableTargetAdapter: compiledAdapter(),
    });
    try {
      expect(
        await compiledAssessor(jobs.callableTargets).assess(fixture()),
      ).toMatchObject({ status: 'verified', workspaceId });
    } finally {
      await jobs.shutdown();
    }
  });
  it('uses the emitted real V3 builder/verifier and returns only bound descriptors/pin', async () => {
    const snapshot = fixture();
    const report = await assess(snapshot);
    expect(report).toMatchObject({
      status: 'verified',
      workspaceId,
      entries: [
        {
          workflowId,
          versionId,
          checksum: snapshot.entries[0]?.checksum,
          pin: {
            workflowId,
            versionId,
            callableContractIdentity:
              snapshot.entries[0]?.callableContractIdentity,
          },
          contract: { input: descriptor, result: descriptor },
        },
      ],
      counters: { uniqueVersions: 1, nodeVisits: 9 },
    });
    expect(JSON.stringify(report)).not.toContain('resultSelector');
    expect(JSON.stringify(report)).not.toContain('sourceJson');
  });
  it('retains verified noncallable facts without inventing a pin', async () => {
    expect(await assess(fixture(false))).toMatchObject({
      status: 'verified',
      entries: [{ pin: null, contract: null }],
    });
  });
  it.each(['checksum', 'source', 'envelope', 'contract', 'provenance'])(
    'keeps %s contradiction an operational failure',
    async (kind) => {
      const snapshot = fixture();
      const entry = snapshot.entries[0];
      if (entry === undefined) throw new Error('fixture missing');
      const changed =
        kind === 'checksum'
          ? { ...entry, checksum: `wf:v3:sha256:${'0'.repeat(64)}` }
          : kind === 'source'
            ? {
                ...entry,
                sourceJson: JSON.stringify({
                  ...JSON.parse(entry.sourceJson),
                  callable: {
                    ...declaration,
                    resultSelector: {
                      kind: 'literal',
                      value: { changed: true },
                    },
                  },
                }),
              }
            : kind === 'envelope'
              ? { ...entry, executableJson: '{}' }
              : kind === 'contract'
                ? {
                    ...entry,
                    callableContractIdentity: `callable:v1:sha256:${'0'.repeat(64)}`,
                  }
                : {
                    ...entry,
                    admissionRelease: { ...entry.admissionRelease, epoch: 2 },
                  };
      await expect(
        assess({ ...snapshot, entries: [changed] }),
      ).rejects.toMatchObject({ code: 'executable_invalid' });
    },
  );
  it('rejects unknown protocol/version/purpose and non-closed report frames', () => {
    const adapter = createCallableTargetWorkerAdapter();
    for (const reply of [
      { kind: 'ready' },
      {
        kind: 'ready',
        purpose: CALLABLE_TARGET_ASSESSMENT_PURPOSE,
        version: 2,
      },
      { kind: 'ready', purpose: 'arbitrary', version: 1 },
      { kind: 'result', id: 1, report: {}, extra: true },
      { kind: 'started', id: 0 },
    ])
      expect(() => adapter.decodeReply(reply)).toThrow();
    expect(
      adapter.decodeReply({
        kind: 'ready',
        purpose: CALLABLE_TARGET_ASSESSMENT_PURPOSE,
        version: 1,
      }),
    ).toEqual({ kind: 'ready' });
  });
  it('refuses oversized payload before worker creation, duplicate identities and unknown request keys', () => {
    const snapshot = fixture();
    const entry = snapshot.entries[0];
    if (entry === undefined) throw new Error('fixture missing');
    const adapter = createCallableTargetWorkerAdapter();
    expect(() =>
      adapter.prepare({
        ...snapshot,
        entries: [{ ...entry, sourceJson: 'x'.repeat(1_048_577) }],
      }),
    ).toThrow(expect.objectContaining({ reason: 'payload_limit' }));
    expect(() =>
      adapter.prepare({ ...snapshot, entries: [entry, entry] }),
    ).toThrow();
    expect(() =>
      adapter.prepare({ ...snapshot, workerPath: '/tmp/arbitrary.js' }),
    ).toThrow();
  });
  it('binds reply membership, workspace and all four pin fields', async () => {
    const snapshot = fixture();
    const report = await assess(snapshot);
    if (report.status !== 'verified')
      throw new Error('expected verified fixture');
    for (const altered of [
      { ...report, entries: [] },
      { ...report, entries: [...report.entries, ...report.entries] },
      { ...report, workspaceId: workflowId },
      {
        ...report,
        entries: report.entries.map((entry) => ({
          ...entry,
          pin: { ...entry.pin, workflowId: workspaceId },
        })),
      },
    ])
      expect(() =>
        parseCallableTargetAssessmentReport(altered, snapshot),
      ).toThrow();
    expect(() =>
      parseCallableTargetAssessmentReport(
        { status: 'operational_failure', reason: 'secret stack' },
        snapshot,
      ),
    ).toThrow();
  });
  it('reports whole batch aggregate member exhaustion, not an eligible prefix', async () => {
    const snapshot = fixture();
    const entry = snapshot.entries[0];
    if (entry === undefined) throw new Error('fixture missing');
    const payload = JSON.stringify({
      values: Array.from({ length: 10_001 }, () => 0),
    });
    expect(
      await assess({
        ...snapshot,
        entries: [{ ...entry, sourceJson: payload }],
      }),
    ).toEqual({ status: 'budget_exhausted' });
  });
  it('never fabricates support when the fixed slot is missing', async () => {
    await expect(
      createCallableTargetAssessor(undefined).assess(fixture()),
    ).rejects.toMatchObject({ reason: 'not_configured' });
  });
  it('verifies a retained admission release against a supported newer current release', async () => {
    const snapshot = fixture();
    const current = composeExecutableCompatibilityReleaseV3(
      nodeRelease({ epoch: 2, unrelated: true }),
    );
    expect(
      await assess({
        ...snapshot,
        currentRelease: {
          epoch: current.epoch,
          fingerprint: current.fingerprint,
          releaseJson: JSON.stringify(current),
        },
      }),
    ).toMatchObject({
      status: 'verified',
      entries: [{ checksum: snapshot.entries[0]?.checksum }],
    });
  });
  it('does not message-classify current verifier failures as eligibility refusal', async () => {
    const snapshot = fixture();
    const current = composeExecutableCompatibilityReleaseV3(
      nodeRelease({ epoch: 2, executorLifecycle: 'retirement_blocked' }),
    );
    await expect(
      assess({
        ...snapshot,
        currentRelease: {
          epoch: current.epoch,
          fingerprint: current.fingerprint,
          releaseJson: JSON.stringify(current),
        },
      }),
    ).rejects.toMatchObject({ code: 'executable_invalid' });
  });
  it('classifies missing current native policies as unavailable only after historical immutable checks', async () => {
    const snapshot = fixture();
    const current = createRegistryRelease({
      epoch: 2,
      definitions: [],
      executors: [],
      policies: [],
    });
    const request = {
      ...snapshot,
      currentRelease: {
        epoch: current.epoch,
        fingerprint: current.fingerprint,
        releaseJson: JSON.stringify(current),
      },
    };
    expect(await assess(request)).toEqual({
      status: 'unavailable',
      reason: 'compatibility_support_unavailable',
    });
    const entry = request.entries[0];
    if (entry === undefined) throw new Error('fixture missing');
    await expect(
      assess({ ...request, entries: [{ ...entry, executableJson: '{}' }] }),
    ).rejects.toMatchObject({ code: 'executable_invalid' });
  });
  it('preserves the exact pre-aborted cancellation reason, even without a slot', async () => {
    const cancellation = new Error('owned cancellation');
    await expect(
      createCallableTargetAssessor(undefined).assess(fixture(), {
        signal: AbortSignal.abort(cancellation),
      }),
    ).rejects.toBe(cancellation);
  });
  it('bounds release bytes before JSON parsing and never invokes request getters', () => {
    const adapter = createCallableTargetWorkerAdapter();
    const snapshot = fixture();
    expect(() =>
      adapter.prepare({
        ...snapshot,
        currentRelease: {
          ...snapshot.currentRelease,
          releaseJson: 'x'.repeat(2_097_153),
        },
      }),
    ).toThrow(expect.objectContaining({ reason: 'payload_limit' }));
    let accessed = false;
    const hostile = Object.defineProperty({ ...snapshot }, 'entries', {
      enumerable: true,
      get: () => {
        accessed = true;
        return snapshot.entries;
      },
    });
    expect(() => adapter.prepare(hostile)).toThrow();
    expect(accessed).toBe(false);
  });
});
