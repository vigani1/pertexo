import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { keepReasons } from '../mutation/analyze-mutation.mjs';
import { renderMarkdown } from './render-overlap.mjs';

// Reads the reports run-file-coverage.mjs writes (any mix of workspaces, lanes
// and shards) and finds test files whose reach other files already have.
// Reach is not proof of checking: every list names candidates to read.

/**
 * Two files of one area join a merge cluster when their weighted overlap
 * reaches this. README.md, "Finding tests that overlap", explains how to read it.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 0.6;

export function analyzeOverlap(
  reports,
  { readSource, threshold = DEFAULT_CLUSTER_THRESHOLD },
) {
  const all = mergeReports(reports).map((test) => ({
    ...test,
    ...describeTestFile(test.file, readSource(test.file)),
  }));
  const measured = all.filter((test) => test.status === 'passed');
  const lines = internLines(measured);
  for (const test of measured) {
    test.unique = 0;
    for (const id of test.ids) if (lines.reachers[id] === 1) test.unique++;
  }
  const contained = findContainment(measured, lines);
  const clusters = findClusters(measured, lines, threshold);
  const view = (test) => ({
    file: test.file,
    workspace: test.workspace,
    lane: test.lane,
    testLines: test.testLines,
    its: test.its,
    mocks: test.mocks,
    reached: test.ids.length,
    reachedByNoOther: test.unique,
    keep: test.keep,
  });
  const byLinesDescending = (a, b) =>
    b.testLines - a.testLines || a.file.localeCompare(b.file, 'en');
  return {
    threshold,
    groups: summarizeGroups(all, contained, clusters),
    tests: measured.map(view),
    notMeasured: all
      .filter((test) => test.status !== 'passed')
      .map((test) => ({
        file: test.file,
        workspace: test.workspace,
        lane: test.lane,
        status: test.status,
        testLines: test.testLines,
      })),
    lists: {
      noNewReach: measured
        .filter((test) => test.unique === 0)
        .sort(byLinesDescending)
        .map(view),
      contained: [...contained.values()]
        .sort((a, b) => byLinesDescending(a.test, b.test))
        .map(({ test, container, containers }) => ({
          ...view(test),
          container: container.file,
          containerLane: container.lane,
          containerIsIntegration: container.lane === 'integration',
          sameReach: container.ids.length === test.ids.length,
          containers,
        })),
      clusters: clusters.map((cluster) => ({
        ...cluster,
        members: cluster.members.map(view),
      })),
    },
    bestNeighbourOverlap: bestNeighbourHistogram(measured, lines),
  };
}

function mergeReports(reports) {
  const tests = new Map();
  for (const { workspace, lane, files } of reports)
    for (const [file, record] of Object.entries(files)) {
      if (tests.has(file)) throw new Error(`${file} is in two reports`);
      tests.set(file, { file, workspace, lane, ...record });
    }
  return [...tests.values()].sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

const TEST_CALL = /(?<![\w.$])(?:it|test)\b(?:\.\w+)*\s*[(`]/gu;
const MOCK_CALL = /\bvi\.(?:mock|fn|spyOn)\s*\(/gu;
const TITLE =
  /(?<![\w.$])(?:describe|it|test)\b(?:\.\w+)*(?:\([^()]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gu;

/** Size and shape of one test file, read from its source text. */
export function describeTestFile(file, source) {
  const titles = [...source.matchAll(TITLE)].map((match) => match[2]);
  return {
    testLines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0),
    its: source.match(TEST_CALL)?.length ?? 0,
    mocks: source.match(MOCK_CALL)?.length ?? 0,
    keep: keepReasons(file, titles.join(' ')),
  };
}

/** Numbers every reached `source:line`, and counts how many files reach it. */
function internLines(tests) {
  const index = new Map();
  const reachers = [];
  for (const test of tests) {
    test.ids = [];
    for (const [source, lineNumbers] of Object.entries(test.reached))
      for (const line of lineNumbers) {
        const key = `${source}:${String(line)}`;
        let id = index.get(key);
        if (id === undefined) {
          id = reachers.length;
          index.set(key, id);
          reachers.push(0);
        }
        reachers[id]++;
        test.ids.push(id);
      }
    test.idSet = new Set(test.ids);
  }
  // Rare lines say more about a file than lines nearly every file loads.
  const weights = reachers.map((count) => Math.log(tests.length / count));
  return { reachers, weights };
}

/**
 * Files whose whole reach lies inside one other file's. The container shown
 * is an integration file when there is one (the real path), then the one with
 * the smallest reach (the closest fit).
 */
function findContainment(tests, { reachers }) {
  const byLine = new Map();
  for (const test of tests)
    for (const id of test.ids) {
      const list = byLine.get(id) ?? [];
      byLine.set(id, list);
      list.push(test);
    }
  const contained = new Map();
  for (const test of tests) {
    if (test.ids.length === 0) continue;
    // Only files reaching this file's rarest line can contain it.
    const rarest = test.ids.reduce((a, b) =>
      reachers[b] < reachers[a] ? b : a,
    );
    const containers = byLine
      .get(rarest)
      .filter(
        (other) =>
          other !== test &&
          other.ids.length >= test.ids.length &&
          test.ids.every((id) => other.idSet.has(id)),
      );
    if (containers.length === 0) continue;
    const container = containers.reduce((best, other) =>
      preferContainer(other, best) < 0 ? other : best,
    );
    contained.set(test.file, {
      test,
      container,
      containers: containers.length,
    });
  }
  return contained;
}

function preferContainer(a, b) {
  return (
    Number(b.lane === 'integration') - Number(a.lane === 'integration') ||
    a.ids.length - b.ids.length ||
    a.file.localeCompare(b.file, 'en')
  );
}

/** The workspace, lane and first directory below `test/`. */
export function areaOf({ file, workspace, lane }) {
  const below = file.split('/test/')[1] ?? file;
  const first = below.includes('/') ? below.split('/')[0] : '(top)';
  return `${workspace} ${lane} ${first}`;
}

/** Overlap of two reaches, each line weighted by how rare it is. */
export function weightedOverlap(a, b, weights) {
  const [small, large] = a.ids.length <= b.ids.length ? [a, b] : [b, a];
  let shared = 0;
  for (const id of small.ids) if (large.idSet.has(id)) shared += weights[id];
  const union = totalWeight(a, weights) + totalWeight(b, weights) - shared;
  return union === 0 ? 0 : shared / union;
}

function totalWeight(test, weights) {
  test.weight ??= test.ids.reduce((sum, id) => sum + weights[id], 0);
  return test.weight;
}

/** Single-linkage groups of same-area files at or above the threshold. */
function findClusters(tests, { weights }, threshold) {
  const parent = new Map(tests.map((test) => [test, test]));
  const root = (test) => {
    while (parent.get(test) !== test) test = parent.get(test);
    return test;
  };
  for (const members of groupBy(tests, areaOf).values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        if (weightedOverlap(members[i], members[j], weights) >= threshold)
          parent.set(root(members[i]), root(members[j]));
  return [...groupBy(tests, root).values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      const shared = members[0].ids.filter((id) =>
        members.every((member) => member.idSet.has(id)),
      ).length;
      return {
        area: areaOf(members[0]),
        testLines: members.reduce((sum, member) => sum + member.testLines, 0),
        its: members.reduce((sum, member) => sum + member.its, 0),
        sharedLines: shared,
        unionLines: new Set(members.flatMap((member) => member.ids)).size,
        members,
      };
    })
    .sort(
      (a, b) => b.testLines - a.testLines || a.area.localeCompare(b.area, 'en'),
    );
}

/** For each file, its closest same-area neighbour, in tenths: the data the
 * threshold is chosen from. */
function bestNeighbourHistogram(tests, { weights }) {
  const buckets = Array.from({ length: 11 }, () => 0);
  for (const members of groupBy(tests, areaOf).values())
    for (const test of members) {
      let best = 0;
      for (const other of members)
        if (other !== test)
          best = Math.max(best, weightedOverlap(test, other, weights));
      if (members.length > 1) buckets[Math.floor(best * 10)]++;
    }
  return buckets;
}

function summarizeGroups(all, contained, clusters) {
  const groups = groupBy(all, (test) => `${test.workspace} ${test.lane}`);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, tests]) => {
      const [workspace, lane] = key.split(' ');
      const measured = tests.filter((test) => test.status === 'passed');
      const noNew = measured.filter((test) => test.unique === 0);
      const realPath = measured.filter(
        (test) => contained.get(test.file)?.container.lane === 'integration',
      );
      const own = clusters.filter(
        (cluster) =>
          cluster.members[0].workspace === workspace &&
          cluster.members[0].lane === lane,
      );
      return {
        workspace,
        lane,
        files: tests.length,
        testLines: sumLines(tests),
        measured: measured.length,
        noNewReach: noNew.length,
        noNewReachShare: measured.length
          ? noNew.length / measured.length
          : null,
        noNewReachLines: sumLines(noNew),
        containedByIntegration: realPath.length,
        containedByIntegrationLines: sumLines(realPath),
        clusters: own.length,
        clusterLines: own.reduce((sum, cluster) => sum + cluster.testLines, 0),
      };
    });
}

function sumLines(tests) {
  return tests.reduce((sum, test) => sum + test.testLines, 0);
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    const list = groups.get(value) ?? [];
    groups.set(value, list);
    list.push(item);
  }
  return groups;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'reports/overlap/summary' },
      threshold: {
        type: 'string',
        default: String(DEFAULT_CLUSTER_THRESHOLD),
      },
    },
  });
  const threshold = Number(values.threshold);
  if (positionals.length === 0 || !(threshold > 0 && threshold <= 1))
    throw new Error(
      'usage: analyze-overlap.mjs [--out <stem>] [--threshold 0..1] <report.json>...',
    );
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const summary = analyzeOverlap(
    positionals.map((path) => JSON.parse(readFileSync(path, 'utf8'))),
    {
      threshold,
      readSource: (file) => readFileSync(join(root, file), 'utf8'),
    },
  );
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(`${values.out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${values.out}.md`, renderMarkdown(summary));
  console.log(`Wrote ${values.out}.json and ${values.out}.md`);
}
