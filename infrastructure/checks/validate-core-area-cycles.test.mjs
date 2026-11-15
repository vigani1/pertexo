import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areaCycleFindings,
  collectAreaImports,
  findAreaImports,
  stronglyConnectedGroups,
  areaGraph,
} from './validate-core-area-cycles.mjs';

const core = 'packages/core/src';
const file = (area, name) => `${core}/${area}/${name}`;

test('refuses a runtime import that closes a cycle between two areas', () => {
  const imports = [
    ...findAreaImports(
      file('runs', 'a.ts'),
      "import { x } from '../inbox/b.js';",
    ),
    ...findAreaImports(
      file('inbox', 'b.ts'),
      "import { y } from '../runs/a.js';",
    ),
  ];
  const findings = areaCycleFindings(imports, {});
  assert.equal(findings.length, 2);
  assert.match(findings[0], /inbox->runs closes a runtime cycle/u);
  assert.match(
    findings[0],
    /inbox\/b\.ts -> packages\/core\/src\/runs\/a\.js/u,
  );
});

test('refuses a cycle that runs through three areas and re-exports', () => {
  const imports = [
    ...findAreaImports(file('a', 'x.ts'), "export { v } from '../b/y.js';"),
    ...findAreaImports(file('b', 'y.ts'), "import '../c/z.js';"),
    ...findAreaImports(file('c', 'z.ts'), "import * as a from '../a/x.js';"),
  ];
  assert.equal(areaCycleFindings(imports, {}).length, 3);
});

test('lets a type-only cycle and a one-way dependency through', () => {
  const imports = [
    ...findAreaImports(
      file('runs', 'a.ts'),
      "import type { T } from '../inbox/b.js';",
    ),
    ...findAreaImports(
      file('runs', 'c.ts'),
      "import { type U, type V } from '../inbox/d.js';",
    ),
    ...findAreaImports(
      file('inbox', 'b.ts'),
      "import { y } from '../runs/a.js';",
    ),
  ];
  assert.deepEqual(areaCycleFindings(imports, {}), []);
  assert.deepEqual(
    stronglyConnectedGroups(areaGraph(imports, { runtimeOnly: false })),
    [['inbox', 'runs']],
  );
});

test("ignores imports inside one area and from core's root files", () => {
  assert.deepEqual(
    [
      ...findAreaImports(file('runs', 'a.ts'), "import { x } from './b.js';"),
      ...findAreaImports(
        `${core}/testing.ts`,
        "import { x } from './runs/a.js';",
      ),
    ],
    [],
  );
});

test('keeps an allowlisted cycle and refuses an entry that no longer closes one', () => {
  const cycle = [
    ...findAreaImports(file('a', 'x.ts'), "import { v } from '../b/y.js';"),
    ...findAreaImports(file('b', 'y.ts'), "import { w } from '../a/x.js';"),
  ];
  const kept = { 'a->b': 'reason', 'b->a': 'reason' };
  assert.deepEqual(areaCycleFindings(cycle, kept), []);
  const findings = areaCycleFindings(cycle.slice(0, 1), kept);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /lists a->b, which no longer closes a cycle/u);
});

test("core's areas have no runtime cycle beyond the kept list", async () => {
  assert.deepEqual(areaCycleFindings(await collectAreaImports()), []);
});
