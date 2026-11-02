import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './admission/fixture.js';
import { registerAdmitsMemberFormOnceTrusted } from './admission/admits-member-form-once-trusted.cases.js';
import { registerLinearizesDuplicateFormSubmissionsRejects } from './admission/linearizes-duplicate-form-submissions-rejects.cases.js';
import { registerAdmitsTypedMultipleChoicesOnce } from './admission/admits-typed-multiple-choices-once.cases.js';
import { registerLockOrder } from './admission/lock-order.cases.js';
import { registerPublicLink } from './admission/public-link.cases.js';
import { registerMemberAccess } from './admission/member-access.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerAdmitsMemberFormOnceTrusted();
registerLinearizesDuplicateFormSubmissionsRejects();
registerAdmitsTypedMultipleChoicesOnce();
registerLockOrder();
registerPublicLink();
registerMemberAccess();
