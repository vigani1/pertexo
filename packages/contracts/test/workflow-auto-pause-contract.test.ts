import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  autoPauseThresholdSchema,
  workflowAutoPauseCommandResponseSchema,
  workflowAutoPauseSettingsRequestSchema,
  workflowAutoPauseSettingsSchema,
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
  workflowPauseConflictProblemSchema,
  workflowPauseRevisionSchema,
  workflowResumeRequestSchema,
  workspaceAutoPauseSettingsRequestSchema,
} from '../src/workflow-authoring.js';
import { API_PROBLEM_MANIFEST } from '../src/errors/api-problem.js';

const settings = {
  enabled: true,
  thresholdOverride: null,
  workspaceThreshold: 10,
  effectiveThreshold: 10,
  settingsRevision: 1,
  pauseState: 'none',
  pauseRevision: '9007199254740993',
  pausedAt: null,
  pauseReason: null,
  pausedFailures: null,
  pausedLastRunId: null,
} as const;

describe('automatic workflow pause contracts', () => {
  it('matches bigint ordering at every decimal-prefix boundary in runtime and generated clients', () => {
    const maximum = '9223372036854775807';
    const validate = new Ajv2020({ strict: false }).compile(
      workflowAuthoringClientContract.schemas.WorkflowResumeRequest,
    );
    for (let index = 0; index < maximum.length; index++) {
      for (let digit = 0; digit <= 9; digit++) {
        for (const suffixDigit of ['0', '9']) {
          const revision = `${maximum.slice(0, index)}${String(digit)}${suffixDigit.repeat(maximum.length - index - 1)}`;
          const expected =
            !revision.startsWith('0') && BigInt(revision) <= BigInt(maximum);
          expect(workflowPauseRevisionSchema.safeParse(revision).success).toBe(
            expected,
          );
          expect(validate({ expectedPauseRevision: revision })).toBe(expected);
        }
      }
    }
  });
  it('preserves bigint revisions without number coercion in runtime and generated clients', () => {
    const projection =
      workflowAuthoringClientContract.schemas.WorkflowResumeRequest;
    const validate = new Ajv2020({ strict: false }).compile(projection);
    for (const revision of ['1', '9007199254740993', '9223372036854775807']) {
      expect(workflowPauseRevisionSchema.parse(revision)).toBe(revision);
      expect(validate({ expectedPauseRevision: revision })).toBe(true);
    }
    for (const revision of [
      0,
      1,
      '0',
      '01',
      '-1',
      '1.0',
      '1e3',
      '9223372036854775808',
      '9999999999999999999',
      '10000000000000000000',
    ]) {
      expect(
        workflowResumeRequestSchema.safeParse({
          expectedPauseRevision: revision,
        }).success,
      ).toBe(false);
      expect(validate({ expectedPauseRevision: revision })).toBe(false);
    }
  });

  it('bounds thresholds and rejects speculative warnings or unsafe revisions', () => {
    for (const threshold of [3, 10, 100])
      expect(autoPauseThresholdSchema.parse(threshold)).toBe(threshold);
    for (const threshold of [2, 101, 3.5, '10'])
      expect(autoPauseThresholdSchema.safeParse(threshold).success).toBe(false);
    expect(
      workflowAutoPauseSettingsRequestSchema.parse({
        enabled: false,
        thresholdOverride: null,
        expectedSettingsRevision: 1,
      }),
    ).toEqual({
      enabled: false,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
    });
    expect(
      workflowAutoPauseSettingsRequestSchema.safeParse({
        enabled: true,
        thresholdOverride: 10,
        expectedSettingsRevision: 1,
        warnBeforePause: true,
      }).success,
    ).toBe(false);
    for (const expectedRevision of [0, -1, '1', Number.MAX_SAFE_INTEGER + 1])
      expect(
        workspaceAutoPauseSettingsRequestSchema.safeParse({
          threshold: 10,
          expectedRevision,
        }).success,
      ).toBe(false);
  });

  it('returns an independent operational snapshot and replay flag', () => {
    expect(workflowAutoPauseSettingsSchema.parse(settings)).toEqual(settings);
    expect(
      workflowAutoPauseCommandResponseSchema.parse({
        settings,
        replayed: true,
      }),
    ).toEqual({ settings, replayed: true });
    expect(
      workflowAutoPauseSettingsSchema.safeParse({
        ...settings,
        lifecycleRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      workflowAutoPauseSettingsSchema.parse({
        ...settings,
        pauseState: 'paused',
        pausedAt: '2026-09-30T08:00:00.000Z',
        pauseReason: 'consecutive_failures',
        pausedFailures: 10,
        pausedLastRunId: '11111111-1111-4111-8111-111111111111',
      }).pauseState,
    ).toBe('paused');
  });

  it('documents authenticated idempotent controls without draft ETags', () => {
    const paths = workflowAuthoringOpenApiDocument.paths;
    const operations = [
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/auto-pause']
        .put,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/resume'].post,
      paths['/v1/workspaces/{workspaceId}/auto-pause'].put,
    ];
    for (const operation of operations) {
      expect(operation.security).toEqual([{ cookieSession: [] }]);
      const names = operation.parameters.map(({ name }) => name);
      expect(names).toContain('x-csrf-token');
      expect(names).toContain('Idempotency-Key');
      expect(names).not.toContain('If-Match');
      expect(operation.responses).toHaveProperty('200');
      expect(operation.responses).toHaveProperty('409');
      expect(operation.requestBody).toHaveProperty('required', true);
    }
    expect(operations[2]?.description).toContain('owner only');
    expect(
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/auto-pause']
        .get.description,
    ).toContain('workflow:read');
  });

  it('registers typed conflicts without leaking other revision domains', () => {
    const problem = {
      type: 'urn:pertexo:problem:workflow.pause_conflict',
      title: 'Workflow pause conflict',
      status: 409,
      code: 'workflow.pause_conflict',
      requestId: 'request-56',
      currentPauseRevision: '9223372036854775807',
    };
    expect(workflowPauseConflictProblemSchema.parse(problem)).toEqual(problem);
    expect(
      workflowPauseConflictProblemSchema.safeParse({
        ...problem,
        currentEtag: 'draft',
      }).success,
    ).toBe(false);
    for (const code of [
      'workflow.pause_conflict',
      'workflow.auto_pause_settings_conflict',
      'workspace.auto_pause_settings_conflict',
    ] as const)
      expect(API_PROBLEM_MANIFEST[code].status).toBe(409);
  });
});
