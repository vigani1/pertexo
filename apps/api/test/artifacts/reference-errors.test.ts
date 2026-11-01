import { toProblem } from '../../src/problems/registry.js';
import {
  authoringFailure,
  runFailure,
  nodeTestingFailure,
  artifactFailure,
} from '../../src/problems/context/normalize.js';
import { ArtifactUploadTooLargeError } from '../../src/artifacts/index.js';
import { describe, expect, it } from 'vitest';
import { ArtifactMetadataNotFoundError } from '@pertexo/core/artifacts';

describe('unavailable artifact reference feedback', () => {
  it.each([
    (error: unknown) => toProblem(authoringFailure(error)),
    (error: unknown) => toProblem(runFailure(error)),
    (error: unknown) => toProblem(nodeTestingFailure(error)),
  ])(
    'explains the file problem without changing the identity/access problem (%#)',
    (map) => {
      const error = map(new ArtifactMetadataNotFoundError());
      expect(error.code).toBe('request.invalid');
      expect(error.safeDetail).toContain('attached file is unavailable');
      expect(error.safeDetail).not.toMatch(
        /permission|role|workspace.*access|storage.key/i,
      );
    },
  );
});

it('returns a distinct file-size problem with split-file advice for configured storage limits', () => {
  const problem = toProblem(artifactFailure(new ArtifactUploadTooLargeError()));
  expect(problem.code).toBe('artifact.too_large');
  expect(problem.safeDetail).toContain('configured lower storage limit');
  expect(problem.safeDetail).toContain('Split');
});
