import { describe } from 'vitest';

import { registerAllowsExactlyOneRacingCompare } from './coordination/allows-exactly-one-racing-compare.cases.js';
import { registerHoldsActorAuthorityStableUntil } from './coordination/holds-actor-authority-stable-until.cases.js';
import { registerListsImmutableVersionsBoundedDeterministic } from './coordination/lists-immutable-versions-bounded-deterministic.cases.js';
import { registerSerializesBothSaveFirstPublish } from './coordination/serializes-both-save-first-publish.cases.js';
describe('workflow authoring coordination', () => {
  registerAllowsExactlyOneRacingCompare();

  registerHoldsActorAuthorityStableUntil();

  registerListsImmutableVersionsBoundedDeterministic();

  registerSerializesBothSaveFirstPublish();
});
