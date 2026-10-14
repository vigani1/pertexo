import { describe, expect, it } from 'vitest';
import { ArtifactMetadataNotFoundError } from '@pertexo/database/runs';
import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
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
