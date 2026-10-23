import { describe } from 'vitest';

import { registerRollsBackEveryMaterialPublication } from './atomicity/rolls-back-every-material-publication.cases.js';
import { registerPublishesAtomicallyReplaysExactlyRejects } from './atomicity/publishes-atomically-replays-exactly-rejects.cases.js';
describe('workflow publication atomicity', () => {
  registerRollsBackEveryMaterialPublication();

  registerPublishesAtomicallyReplaysExactlyRejects();
});
