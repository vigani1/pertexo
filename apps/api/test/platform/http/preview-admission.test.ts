import { describe, expect, it } from 'vitest';
import { PreviewAdmissionDeniedError } from '@pertexo/core/previews';
import { toProblem } from '../../../src/problems/registry.js';
import { nodeTestingFailure } from '../../../src/problems/context/normalize.js';

describe('public preview admission refusals', () => {
  it.each([
    ['actor', 'resource.not_found', undefined],
    ['draft', 'workflow.revision_conflict', /Refresh.*prepare/u],
    ['deadline', 'workflow.invalid', /expired.*Prepare/u],
    ['retention', 'workflow.invalid', /expired.*Prepare/u],
  ] as const)(
    'gives a safe recoverable response for %s',
    (reason, code, remedy) => {
      const result = toProblem(
        nodeTestingFailure(new PreviewAdmissionDeniedError(reason)),
      );
      expect(result.code).toBe(code);
      if (remedy !== undefined) expect(result.safeDetail).toMatch(remedy);
    },
  );
});
