import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  workflowConcurrencySettingsSchema,
  workflowConcurrencySettingsRequestSchema,
} from '../src/index.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/server.js';
import { workflowRunAdmissionBlockersSchema } from '../src/schemas/workflow-runs.js';
import { API_PROBLEM_MANIFEST } from '../src/errors/api-problem.js';

describe('workflow queue-only concurrency contracts', () => {
  it('bounds strict requests identically in runtime and generated clients', () => {
    const validate = new Ajv2020({ strict: false }).compile(
      workflowAuthoringClientContract.schemas
        .WorkflowConcurrencySettingsRequest,
    );
    for (const limit of [null, 1, 10_000]) {
      expect(
        workflowConcurrencySettingsRequestSchema.parse({
          limit,
          expectedRevision: 1,
        }),
      ).toEqual({ limit, expectedRevision: 1 });
      expect(validate({ limit, expectedRevision: 1 })).toBe(true);
    }
    for (const request of [
      { limit: 0, expectedRevision: 1 },
      { limit: 10_001, expectedRevision: 1 },
      { limit: '1', expectedRevision: 1 },
      { limit: 1, expectedRevision: 0 },
      { limit: 1, expectedRevision: 2_147_483_648 },
      { limit: 1, expectedRevision: 1, overflow: 'skip' },
      { limit: null, expectedRevision: 1, queueLength: 10 },
    ]) {
      expect(
        workflowConcurrencySettingsRequestSchema.safeParse(request).success,
      ).toBe(false);
      expect(validate(request)).toBe(false);
    }
  });
  it('represents absent entitlement and stored caps above subsequently reduced workspace limits', () => {
    const settings = {
      asOf: '2026-10-01T00:00:00.000001Z',
      limit: 10,
      revision: 2,
      workspaceActiveRunLimit: 1,
      workspacePolicyState: 'active',
      overflow: 'queue',
    };
    expect(workflowConcurrencySettingsSchema.parse(settings)).toEqual(settings);
    expect(
      workflowConcurrencySettingsSchema.parse({
        ...settings,
        workspaceActiveRunLimit: null,
        workspacePolicyState: 'unavailable',
      }).workspaceActiveRunLimit,
    ).toBeNull();
    expect(
      workflowConcurrencySettingsSchema.safeParse({
        ...settings,
        overflow: 'skip',
      }).success,
    ).toBe(false);
    expect(
      workflowConcurrencySettingsSchema.safeParse({
        ...settings,
        asOf: '2026-10-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  it('declares capability, authenticated CSRF/idempotency and typed current-policy conflicts', () => {
    const path =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/concurrency'
      ];
    expect(path.get.description).toContain('workflow:read');
    expect(path.put.description).toContain('workflow:update');
    expect(path.put.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key' }),
        expect.objectContaining({ name: 'x-csrf-token' }),
      ]),
    );
    for (const code of [
      'workflow.concurrency_revision_conflict',
      'workflow.concurrency_limit_exceeded',
      'workflow.concurrency_limit_unavailable',
    ] as const)
      expect(API_PROBLEM_MANIFEST[code].status).toBe(409);
  });
  it('projects only current timestamped blocker reasons without new run statuses or queue promises', () => {
    expect(
      workflowRunAdmissionBlockersSchema.parse({
        asOf: '2026-10-01T00:00:00.000001Z',
        reasons: [],
      }).reasons,
    ).toEqual([]);
    for (const reason of [
      'workspace_capacity',
      'workflow_capacity',
      'workflow_order',
    ])
      expect(
        workflowRunAdmissionBlockersSchema.safeParse({
          asOf: '2026-10-01T00:00:00.000001Z',
          reasons: [reason],
        }).success,
      ).toBe(true);
    expect(
      workflowRunAdmissionBlockersSchema.safeParse({
        asOf: '2026-10-01T00:00:00.000001Z',
        reasons: ['paused'],
        startsAt: 'soon',
      }).success,
    ).toBe(false);
  });
});
