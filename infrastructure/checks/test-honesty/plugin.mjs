import { noFixedSleep } from './no-fixed-sleep.mjs';
import { noFlakeMasking } from './no-flake-masking.mjs';
import { noInternalTestDoubles } from './no-internal-test-doubles.mjs';
import { noUnsignaledPoll } from './no-unsignaled-poll.mjs';

// Rules that stop a test passing by sleeping, retrying, waiting longer or
// faking our own code. The rule set and its ratchet follow Landmines
// (https://github.com/interfere-inc/landmines, MIT), rewritten for this
// repository's lanes and its "mock only outside services" rule.
const plugin = {
  meta: { name: 'test-honesty' },
  rules: {
    'no-fixed-sleep': noFixedSleep,
    'no-flake-masking': noFlakeMasking,
    'no-unsignaled-poll': noUnsignaledPoll,
    'no-internal-test-doubles': noInternalTestDoubles,
  },
};

export default plugin;
