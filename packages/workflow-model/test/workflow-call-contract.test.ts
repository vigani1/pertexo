import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallFamilyPolicySchemaV1,
  workflowCallPinSchemaV1,
} from '../src/workflow-call-contract.js';

const pin = () => ({
  workflowId: '00000001-0000-4000-8000-000000000001',
  versionId: '00000002-0000-4000-8000-000000000002',
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
});

describe('exact workflow call pins and immutable family policy', () => {
  it('accepts all exact pin fields without adding defaults', () => {
    expect(workflowCallPinSchemaV1.parse(pin())).toEqual(pin());
  });
  it.each(['workflowId', 'versionId', 'checksum', 'callableContractIdentity'])(
    'requires %s',
    (field) => {
      const input: Record<string, unknown> = pin();
      Reflect.deleteProperty(input, field);
      expect(workflowCallPinSchemaV1.safeParse(input).success).toBe(false);
    },
  );
  it.each([
    { ...pin(), workspaceId: '00000003-0000-4000-8000-000000000003' },
    { ...pin(), workflowId: 'workflow' },
    { ...pin(), versionId: '' },
    { ...pin(), checksum: `wf:v2:sha256:${'a'.repeat(64)}` },
    { ...pin(), checksum: `wf:v3:sha256:${'A'.repeat(64)}` },
    { ...pin(), checksum: `wf:v3:sha256:${'a'.repeat(63)}` },
    {
      ...pin(),
      callableContractIdentity: `callable:v2:sha256:${'b'.repeat(64)}`,
    },
    {
      ...pin(),
      callableContractIdentity: `callable:v1:sha256:${'B'.repeat(64)}`,
    },
    {
      ...pin(),
      callableContractIdentity: `callable:v1:sha256:${'b'.repeat(65)}`,
    },
  ])('rejects nonexact pins %#', (input) => {
    expect(workflowCallPinSchemaV1.safeParse(input).success).toBe(false);
  });
  it('pins all family limits as required literals, not mutable defaults', () => {
    expect(Object.isFrozen(WORKFLOW_CALL_FAMILY_POLICY_V1)).toBe(true);
    expect(
      workflowCallFamilyPolicySchemaV1.parse(WORKFLOW_CALL_FAMILY_POLICY_V1),
    ).toEqual({
      schemaVersion: 1,
      defaultMaxRunDurationMs: 3_600_000,
      maxCallDepth: 4,
      maxChildRuns: 64,
      maxExpandedInvocations: 1_000,
    });
    expect(workflowCallFamilyPolicySchemaV1.safeParse({}).success).toBe(false);
    expect(
      workflowCallFamilyPolicySchemaV1.safeParse({
        ...WORKFLOW_CALL_FAMILY_POLICY_V1,
        extra: true,
      }).success,
    ).toBe(false);
    for (const [key, value] of Object.entries(WORKFLOW_CALL_FAMILY_POLICY_V1)) {
      const omitted: Record<string, unknown> = {
        ...WORKFLOW_CALL_FAMILY_POLICY_V1,
      };
      Reflect.deleteProperty(omitted, key);
      expect(workflowCallFamilyPolicySchemaV1.safeParse(omitted).success).toBe(
        false,
      );
      expect(
        workflowCallFamilyPolicySchemaV1.safeParse({
          ...WORKFLOW_CALL_FAMILY_POLICY_V1,
          [key]: value + 1,
        }).success,
      ).toBe(false);
      expect(
        workflowCallFamilyPolicySchemaV1.safeParse({
          ...WORKFLOW_CALL_FAMILY_POLICY_V1,
          [key]: value - 1,
        }).success,
      ).toBe(false);
    }
  });
});
