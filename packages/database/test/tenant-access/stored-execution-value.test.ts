import { describe } from 'vitest';

import { registerPreservesFormatLikeFieldNames } from './stored-execution-value/preserves-format-like-field-names.cases.js';
import { registerSerializesTrustedDataWithoutInherited } from './stored-execution-value/serializes-trusted-data-without-inherited.cases.js';
import { registerRoundTripsArtifactReferenceRejects } from './stored-execution-value/round-trips-artifact-reference-rejects.cases.js';
describe('StoredExecutionValue', () => {
  registerPreservesFormatLikeFieldNames();

  registerSerializesTrustedDataWithoutInherited();

  registerRoundTripsArtifactReferenceRejects();
});
