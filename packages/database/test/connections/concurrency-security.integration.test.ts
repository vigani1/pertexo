import { describe } from 'vitest';

import { registerListsReadsActorScopedMetadata } from './concurrency-security/lists-reads-actor-scoped-metadata.cases.js';
import { registerSerializesConcurrentSameNameCreations } from './concurrency-security/serializes-concurrent-same-name-creations.cases.js';
describe('connection concurrency and security', () => {
  registerListsReadsActorScopedMetadata();

  registerSerializesConcurrentSameNameCreations();
});
