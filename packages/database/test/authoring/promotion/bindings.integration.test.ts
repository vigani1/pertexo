import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './bindings/fixture.js';
import { registerUsesCompatibleActiveTargetConnections } from './bindings/uses-compatible-active-target-connections.cases.js';
import { registerRequiresExactPromotedChildVersion } from './bindings/requires-exact-promoted-child-version.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerUsesCompatibleActiveTargetConnections();
registerRequiresExactPromotedChildVersion();
