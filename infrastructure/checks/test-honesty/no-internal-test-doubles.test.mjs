import { noInternalTestDoubles } from './no-internal-test-doubles.mjs';
import { ratchetCases, tester } from './rule-tester.mjs';

const filename = 'apps/api/test/doubles.test.ts';
const valid = (name, code) => ({ name, code, filename });
const invalid = (name, code, messageId) => ({
  name,
  code,
  filename,
  errors: [{ messageId }],
});

tester.run('no-internal-test-doubles', noInternalTestDoubles, {
  valid: [
    valid('mocking an outside client library', `vi.mock('ioredis');`),
    valid(
      'mocking a node: module',
      `vi.mock('node:dns/promises', () => ({ lookup }));`,
    ),
    valid(
      'a plain vi.fn() callback',
      `const onSaved = vi.fn(); render({ onSaved });`,
    ),
    valid(
      'silencing a platform object',
      `vi.spyOn(console, 'error').mockImplementation(() => undefined);`,
    ),
    valid(
      'observing our own code without replacing it',
      `import * as runs from '../src/runs.js';
      const started = vi.spyOn(runs, 'start');`,
    ),
    valid('faking the network', `vi.stubGlobal('fetch', fakeFetch);`),
    valid('faking the clock', `vi.stubGlobal('Date', FixedDate);`),
    valid(
      'installing the real platform implementation',
      `import { webcrypto } from 'node:crypto';
      vi.stubGlobal('crypto', webcrypto);`,
    ),
  ],
  invalid: [
    invalid(
      'mocking a relative module',
      `vi.mock('../src/telemetry.js');`,
      'module',
    ),
    invalid(
      'mocking a workspace package',
      `vi.mock('@pertexo/core/runs', () => ({ startRun }));`,
      'module',
    ),
    invalid(
      'mocking through the web alias',
      `vi.doMock('@/features/auth/public');`,
      'module',
    ),
    invalid(
      'replacing a namespace export',
      `import * as runs from '../src/runs.js';
      vi.spyOn(runs, 'start').mockResolvedValue({ id: 1 });`,
      'spy',
    ),
    invalid(
      'replacing a prototype method of our class',
      `import { Store } from '@pertexo/core/authoring';
      vi.spyOn(Store.prototype, 'save').mockImplementationOnce(async () => undefined);`,
      'spy',
    ),
    invalid(
      'stubbing a global that is not a seam',
      `vi.stubGlobal('matchMedia', fakeMatch);`,
      'global',
    ),
  ],
});

tester.run(
  'no-internal-test-doubles ratchet',
  noInternalTestDoubles,
  ratchetCases({
    filename,
    count: 2,
    code: `vi.mock('../src/a.js');
    vi.mock('../src/b.js');`,
  }),
);
