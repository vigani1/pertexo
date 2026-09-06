import { describe, expect, it } from 'vitest';
import {
  workflowActivationStatusSchema as canonicalActivationStatusSchema,
  workflowLifecycleStatusSchema as canonicalLifecycleStatusSchema,
} from '@pertexo/workflow-model/lifecycle';

import {
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
  workflowSummarySchema,
} from '../src/http/workflow-authoring.js';

describe('workflow activation response contract', () => {
  it('uses the canonical browser-safe domain schemas without a second vocabulary', () => {
    expect(workflowActivationStatusSchema).toBe(
      canonicalActivationStatusSchema,
    );
    expect(workflowLifecycleStatusSchema).toBe(canonicalLifecycleStatusSchema);
    expect(workflowActivationStatusSchema.options).toEqual([
      'inactive',
      'activating',
      'active',
      'deactivating',
      'degraded',
      'error',
    ]);
    for (const state of workflowActivationStatusSchema.options) {
      expect(workflowSummarySchema.shape.activationStatus.parse(state)).toBe(
        state,
      );
    }
    expect(
      workflowSummarySchema.shape.activationStatus.safeParse('enabled').success,
    ).toBe(false);
  });
});
