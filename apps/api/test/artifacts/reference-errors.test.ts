import {
  mapArtifactError,
  ArtifactUploadTooLargeError,
} from '../../src/artifacts/index.js';
import { describe, expect, it } from 'vitest';
import { ArtifactMetadataNotFoundError } from '@pertexo/database/runs';
import { mapWorkflowAuthoringError } from '../../src/problems/authoring/workflows.js';
import { mapWorkflowRunError } from '../../src/workflow-runs/errors.js';
import { mapNodeTestingError } from '../../src/node-testing/errors.js';

describe('unavailable artifact reference feedback', () => {
  it.each([
    mapWorkflowAuthoringError,
    mapWorkflowRunError,
    mapNodeTestingError,
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
  const problem = mapArtifactError(new ArtifactUploadTooLargeError());
  expect(problem.code).toBe('artifact.too_large');
  expect(problem.safeDetail).toContain('configured lower storage limit');
  expect(problem.safeDetail).toContain('Split');
});
