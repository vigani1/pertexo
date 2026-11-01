import { describe } from 'vitest';

import { registerPreservesFormatLikeFieldNames } from './stored-execution/preserves-format-like-field-names.cases.js';
import { registerSerializesTrustedDataWithoutInherited } from './stored-execution/serializes-trusted-data-without-inherited.cases.js';
import { registerRoundTripsArtifactReferenceRejects } from './stored-execution/round-trips-artifact-reference-rejects.cases.js';
describe('StoredExecutionValue', () => {
  registerPreservesFormatLikeFieldNames();

  registerSerializesTrustedDataWithoutInherited();

  registerRoundTripsArtifactReferenceRejects();
});
