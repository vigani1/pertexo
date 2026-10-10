import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EMPTY_WORKFLOW_GRAPH,
  InvalidWorkflowGraphError,
} from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import {
  createCoreAuthoringOptions,
  createCoreWorkflowCompatibility,
} from '../../src/platform/workflow/compatibility.js';
import { serializeWorkflowValidation } from '../../src/workflow-authoring/http/serializers.js';
import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
import { createDraftRepresentationTag } from '../../src/workflow-authoring/http/etag.js';
import { withRequestOperationSignal } from '../../src/platform/http/request-operation-signal.js';

const valid = {
  ok: true as const,
  issues: [] as const,
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};
const graph = EMPTY_WORKFLOW_GRAPH;
const draft = {
  workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 9,
  graphJson: graph,
  compatibility: {
    compatible: true,
    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
    issues: [],
  },
  updatedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  updatedAt: new Date('2026-09-28T00:00:00Z'),
};

describe('authoring API admission adapter', () => {
  it('derives the portable and definition catalogs from the served catalog', () => {
    const compatibility = createCoreWorkflowCompatibility();
    const options = createCoreAuthoringOptions(compatibility, {
      validate: () => Promise.resolve(valid),
    });
    const identities = (
      definitions: readonly { key: string; version: number }[],
    ) => definitions.map(({ key, version }) => ({ key, version }));
    expect(identities(options.portableCatalog.definitions)).toEqual(
      identities(options.definitionCatalog.definitions),
    );
    expect(identities(options.definitionCatalog.definitions)).toEqual(
      identities(
        compatibility.catalog.definitions.map(({ definition }) => definition),
      ),
    );
  });
  it('admits through the real compiled parser with the production policies', async () => {
    const compatibility = createCoreWorkflowCompatibility();
    const validator = new WorkflowAuthoringValidator();
    const options = createCoreAuthoringOptions(compatibility, validator);
    const malformed = {
      ...graph,
      nodes: [
        {
          id: 'step',
          definition: { key: 'core.set', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          connectionRefs: {},
          inputMappings: {
            result: {
              kind: 'expression' as const,
              language: 'jsonata' as const,
              expression: '(',
            },
          },
        },
      ],
    };
    try {
      const checked = await options.validateAuthoringGraph(malformed, {});
      expect(checked.ok).toBe(false);
      expect(checked.issues).toContainEqual({
        code: 'invalid_expression',
        path: '$.nodes.step.inputMappings.result',
        message: 'This expression is not valid restricted JSONata.',
      });
      expect(validator.diagnostics().active).toBe(0);
    } finally {
      await validator.shutdown();
    }
  });
  it('validates against the served catalog policies through the shared owner', async () => {
    const compatibility = createCoreWorkflowCompatibility();
    const validate = vi.fn().mockResolvedValue(valid);
    const options = createCoreAuthoringOptions(compatibility, { validate });
    const signal = new AbortController().signal;
    await options.validateAuthoringGraph(graph, { signal });
    const projected = compatibility.authoringPolicies;
    expect(projected.definitions.length).toBeGreaterThan(0);
    expect(validate).toHaveBeenCalledExactlyOnceWith(graph, projected, {
      signal,
    });
  });

  it('returns the existing strong tag of the same checked snapshot and truthful structural/compatibility findings', () => {
    const issue = {
      code: 'invalid_expression' as const,
      path: '$.nodes.loop.structured.body.nodes.action.inputMappings.value',
      message: 'The expression cannot be parsed.',
    };
    const result = serializeWorkflowValidation(draft, {
      ...valid,
      ok: false,
      issues: [issue],
    });
    expect(result.body).toMatchObject({
      valid: false,
      issues: [issue],
      compatibility: draft.compatibility,
    });
    expect(result.representationTag).toBe(
      createDraftRepresentationTag({
        workflowId: draft.workflowId,
        revision: draft.revision,
        graph,
        compatibilityFingerprint: draft.compatibility.fingerprint,
      }),
    );
    expect(
      serializeWorkflowValidation({ ...draft, revision: 10 }, valid)
        .representationTag,
    ).not.toBe(result.representationTag);
  });

  it.each(['path', 'message'] as const)(
    'classifies unrepresentable %s as unavailable rather than request error or truncated target',
    (field) => {
      const issue = {
        code: 'invalid_expression' as const,
        path: '$.nodes.action',
        message: 'Cannot parse.',
        [field]: 'x'.repeat(field === 'path' ? 1025 : 501),
      };
      expect(() =>
        serializeWorkflowValidation(draft, {
          ...valid,
          ok: false,
          issues: [issue],
        }),
      ).toThrow(AuthoringValidationUnavailableError);
      const mapped = mapWorkflowAuthoringError(
        new InvalidWorkflowGraphError([issue]),
      );
      expect(mapped).toMatchObject({
        code: 'workflow.validation_unavailable',
        details: { retryAfterSeconds: 1 },
      });
      expect(mapped.cause).toBeUndefined();
      expect(mapped.details).not.toHaveProperty('issues');
    },
  );

  it('maps operational failure safely before generic input errors', () => {
    const mapped = mapWorkflowAuthoringError(
      new AuthoringValidationUnavailableError('database_budget'),
    );
    expect(mapped).toMatchObject({
      code: 'workflow.validation_unavailable',
      details: { retryAfterSeconds: 1 },
    });
    expect(mapped.cause).toBeUndefined();
  });

  it('does not cancel on ordinary request completion but does cancel disposal and removes listeners', async () => {
    const raw = Object.assign(new EventEmitter(), {
      socket: new EventEmitter(),
    });
    let seen: AbortSignal | undefined;
    await withRequestOperationSignal({ raw }, (signal) => {
      seen = signal;
      raw.emit('close');
      expect(signal.aborted).toBe(false);
      raw.socket.emit('close');
      expect(signal.aborted).toBe(true);
      return Promise.resolve();
    });
    expect(seen?.aborted).toBe(true);
    expect(raw.listenerCount('aborted')).toBe(0);
    expect(raw.socket.listenerCount('close')).toBe(0);
  });
});
