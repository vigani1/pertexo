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
  const findings = areaCycleFindings(imports);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /inbox->runs closes a cycle/u);
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
  assert.equal(areaCycleFindings(imports).length, 3);
});

test('refuses a type-only cycle, and loads a module through inline type specifiers', () => {
  const imports = [
    ...findAreaImports(
      file('runs', 'a.ts'),
      "import type { T } from '../inbox/b.js';",
    ),
    ...findAreaImports(
      file('inbox', 'b.ts'),
      "export type { Y } from '../runs/a.js';",
    ),
  ];
  assert.deepEqual(
    imports.map((i) => i.runtime),
    [false, false],
  );
  assert.equal(areaCycleFindings(imports).length, 2);
  for (const text of [
    "import { type U, type V } from '../inbox/d.js';",
    "export { type U } from '../inbox/d.js';",
  ])
    assert.deepEqual(
      findAreaImports(file('runs', 'c.ts'), text).map((i) => i.runtime),
      [true],
      text,
    );
});

test('lets a one-way dependency through', () => {
  const imports = [
    ...findAreaImports(
      file('runs', 'a.ts'),
      "import type { T } from '../inbox/b.js';",
    ),
    ...findAreaImports(
      file('runs', 'c.ts'),
      "import { y } from '../inbox/d.js';",
    ),
  ];
  assert.deepEqual(areaCycleFindings(imports), []);
  assert.deepEqual(
    stronglyConnectedGroups(areaGraph(imports, { runtimeOnly: false })),
    [],
  );
});

test("sees import() calls and core's own @pertexo/core/<area> entries", () => {
  const imports = [
    ...findAreaImports(
      file('runs', 'a.ts'),
      "export const load = () => import('../inbox/b.js');",
    ),
    ...findAreaImports(
      file('inbox', 'b.ts'),
      "import { a } from '@pertexo/core/runs';",
    ),
  ];
  assert.deepEqual(
    imports.map((i) => [i.from, i.to, i.runtime]),
    [
      ['runs', 'inbox', true],
      ['inbox', 'runs', true],
    ],
  );
  assert.equal(areaCycleFindings(imports).length, 2);
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

test("core's areas have no import cycle", async () => {
  assert.deepEqual(areaCycleFindings(await collectAreaImports()), []);
});
