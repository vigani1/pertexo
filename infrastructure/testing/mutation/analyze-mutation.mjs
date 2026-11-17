import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// Reads a Stryker JSON report (mutation-testing-report-schema) produced with
// `disableBail`, so each mutant's `killedBy` lists every test that caught it.

/**
 * Tests that match one of these stay on purpose when pruning, even when other
 * tests catch the same mutants: they document a guarantee a reader looks for
 * by name, and a later change may make them the only guard. Reviewed list;
 * each pattern is matched against "<test file> <test name>".
 */
export const KEEP_PATTERNS = Object.freeze([
  {
    reason: 'security',
    why: 'Names an attack, a secret or a signature check; the guarantee must stay visible.',
    pattern:
      /secur|attack|forg(?:e|ery)|xss|csrf|ssrf|inject|escap|sanitiz|redact|secret|credential|password|encrypt|decrypt|signature|hmac|tamper|leak|two-factor|totp|saml|scim/iu,
  },
  {
    reason: 'workspace isolation',
    why: 'Proves one workspace never reads or changes another; a regression is a data breach.',
    pattern:
      /isolat|cross-workspace|cross workspace|another workspace|other workspace|foreign workspace|tenant|row security|row-level/iu,
  },
  {
    reason: 'permissions',
    why: 'Proves who may do what; a looser check fails open without any other test noticing.',
    pattern:
      /permission|authori[sz]|forbid|\bdenie[sd]\b|\bdeny\b|\broles?\b|\bviewer\b|\bowner\b|\badmin/iu,
  },
  {
    reason: 'data loss',
    why: 'Proves stored data survives deletes, retries, restores and overwrites; loss is not recoverable.',
    pattern:
      /data loss|\blos[et]\b|delet|purg|retention|overwrit|backup|restor|durab|rollback|roll back|idempoten/iu,
  },
]);

const CAUGHT = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);
const INVALID = new Set(['CompileError', 'RuntimeError', 'Ignored']);

export function analyzeReport(report, workspace) {
  const tests = readTests(report);
  const mutants = Object.entries(report.files).flatMap(([file, entry]) =>
    entry.mutants.map((mutant) => ({ ...mutant, file })),
  );
  for (const mutant of mutants) {
    if (INVALID.has(mutant.status)) continue;
    // A static mutant changes module-level code, so Stryker runs every test
    // against it and leaves `coveredBy` empty. Running is not reaching: a test
    // is judged only on mutants it actually executes, which `coveredBy` lists.
    if (mutant.static) for (const test of tests.values()) test.ranStatic++;
    else
      for (const id of mutant.coveredBy ?? []) requireTest(tests, id).covered++;
    if (!CAUGHT.has(mutant.status)) continue;
    const killers = mutant.killedBy ?? [];
    for (const id of killers) {
      const test = requireTest(tests, id);
      test.caught.add(mutant.id);
      if (killers.length === 1) test.unique++;
    }
  }
  const testList = [...tests.values()].sort(byFileThenName);
  const valid = mutants.filter((mutant) => !INVALID.has(mutant.status));
  const caught = valid.filter((mutant) => CAUGHT.has(mutant.status));
  const minimalSet = greedyMinimalSet(testList);
  const view = (test) => ({
    id: test.id,
    file: test.file,
    name: test.name,
    covered: test.covered,
    ranStatic: test.ranStatic,
    caught: test.caught.size,
    caughtByNoOther: test.unique,
    keep: test.keep,
  });
  return {
    workspace,
    package: {
      mutants: mutants.length,
      valid: valid.length,
      caught: caught.length,
      caughtShare: valid.length === 0 ? null : caught.length / valid.length,
      byStatus: countBy(mutants, (mutant) => mutant.status),
      survivors: groupSurvivors(mutants),
    },
    tests: testList.map(view),
    lists: {
      catchNothing: testList
        .filter((test) => test.covered > 0 && test.caught.size === 0)
        .map(view),
      allCaughtElsewhere: testList
        .filter((test) => test.caught.size > 0 && test.unique === 0)
        .map(view),
      coverNoMutant: testList
        .filter((test) => test.covered === 0 && test.caught.size === 0)
        .map(view),
      minimalSet: minimalSet.map(view),
    },
  };
}

export function keepReasons(file, name) {
  const text = `${file} ${name}`;
  return KEEP_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ reason }) => reason,
  );
}

function readTests(report) {
  const tests = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {}))
    for (const test of entry.tests)
      tests.set(test.id, {
        id: test.id,
        file,
        name: test.name,
        covered: 0,
        ranStatic: 0,
        caught: new Set(),
        unique: 0,
        keep: keepReasons(file, test.name),
      });
  return tests;
}

function requireTest(tests, id) {
  const test = tests.get(id);
  if (!test) throw new Error(`Report names unknown test ${id}`);
  return test;
}

// Greedy set cover: repeatedly take the test that catches the most mutants not
// yet caught. Ties go to the earlier test by file and name, so runs agree.
function greedyMinimalSet(tests) {
  const remaining = new Set(tests.flatMap((test) => [...test.caught]));
  const chosen = [];
  while (remaining.size > 0) {
    let best;
    let bestGain = 0;
    for (const test of tests) {
      let gain = 0;
      for (const id of test.caught) if (remaining.has(id)) gain++;
      if (gain > bestGain) {
        best = test;
        bestGain = gain;
      }
    }
    chosen.push(best);
    for (const id of best.caught) remaining.delete(id);
  }
  return chosen;
}

function groupSurvivors(mutants) {
  const files = new Map();
  for (const mutant of mutants) {
    if (!UNDETECTED.has(mutant.status)) continue;
    const lines = files.get(mutant.file) ?? new Map();
    files.set(mutant.file, lines);
    const line = mutant.location.start.line;
    const entries = lines.get(line) ?? [];
    lines.set(line, entries);
    entries.push({
      status: mutant.status,
      mutator: mutant.mutatorName,
      replacement: mutant.replacement ?? null,
    });
  }
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([file, lines]) => ({
      file,
      lines: [...lines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([line, mutants]) => ({ line, mutants })),
    }));
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en')),
  );
}

function byFileThenName(a, b) {
  return (
    a.file.localeCompare(b.file, 'en') || a.name.localeCompare(b.name, 'en')
  );
}

export function renderMarkdown(summary) {
  const { package: pkg, lists, tests } = summary;
  const keepNote = (test) =>
    test.keep.length ? ` — keep: ${test.keep.join(', ')}` : '';
  const testLine = (test) =>
    `- \`${test.file}\` › ${escapeMarkdown(test.name)} (covers ${test.covered}, catches ${test.caught}, alone ${test.caughtByNoOther})${keepNote(test)}`;
  const section = (title, explanation, items) => [
    `### ${title} (${items.length})`,
    '',
    explanation,
    '',
    ...(items.length ? items.map(testLine) : ['None.']),
    '',
  ];
  return [
    `# Mutation summary: ${summary.workspace}`,
    '',
    `- Mutants: ${pkg.mutants} (${pkg.valid} valid)`,
    `- Caught: ${pkg.caught} (${formatShare(pkg.caughtShare)})`,
    `- By status: ${Object.entries(pkg.byStatus)
      .map(([status, count]) => `${status} ${count}`)
      .join(', ')}`,
    `- Tests: ${tests.length}; smallest set keeping every catch: ${lists.minimalSet.length}`,
    '',
    '## Tests',
    '',
    'Kept tests match the reviewed patterns in `analyze-mutation.mjs`; pruning keeps them on purpose.',
    '',
    ...section(
      'Cover mutated code but catch nothing',
      'These tests ran against planted bugs and passed every time.',
      lists.catchNothing,
    ),
    ...section(
      'Every catch also caught by another test',
      'Redundant by this measure: removing one alone loses no catch.',
      lists.allCaughtElsewhere,
    ),
    ...section(
      'Smallest set keeping every catch',
      'Greedy choice; tests outside it and not kept are pruning candidates.',
      lists.minimalSet,
    ),
    `Tests reaching no mutated code and catching nothing: ${lists.coverNoMutant.length} (not judged; they exercise code outside this run, or only ran against module-level mutants).`,
    '',
    '## Survivors by file and line',
    '',
    'Planted bugs no test caught: real gaps in the tests.',
    '',
    ...(pkg.survivors.length
      ? pkg.survivors.flatMap(({ file, lines }) => [
          `### \`${file}\``,
          '',
          ...lines.map(
            ({ line, mutants }) =>
              `- line ${line}: ${mutants
                .map(
                  (mutant) =>
                    `${mutant.mutator}${mutant.status === 'NoCoverage' ? ' (no test runs it)' : ''}`,
                )
                .join(', ')}`,
          ),
          '',
        ])
      : ['None.', '']),
  ].join('\n');
}

/** One table across workspaces, for the workflow's job summary. */
export function renderCombinedMarkdown(summaries) {
  const sorted = [...summaries].sort((a, b) =>
    a.workspace.localeCompare(b.workspace, 'en'),
  );
  return [
    '# Mutation run',
    '',
    '| Workspace | Mutants | Caught | Tests | Catch nothing | All caught elsewhere | Smallest set |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...sorted.map(
      ({ workspace, package: pkg, tests, lists }) =>
        `| ${workspace} | ${pkg.mutants} | ${formatShare(pkg.caughtShare)} | ${tests.length} | ${lists.catchNothing.length} | ${lists.allCaughtElsewhere.length} | ${lists.minimalSet.length} |`,
    ),
    '',
    'Each workspace’s full summary is in its `mutation-<workspace>` artifact.',
    '',
  ].join('\n');
}

function formatShare(share) {
  return share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`;
}

function escapeMarkdown(text) {
  return text.replace(/[\\`*_[\]<>|]/gu, (character) => `\\${character}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === '--combine') {
    if (rest.length === 0)
      throw new Error(
        'usage: analyze-mutation.mjs --combine <summary.json>...',
      );
    process.stdout.write(
      renderCombinedMarkdown(
        rest.map((path) => JSON.parse(readFileSync(path, 'utf8'))),
      ),
    );
  } else {
    if (!first?.endsWith('.json') || rest.length > 0)
      throw new Error('usage: analyze-mutation.mjs <report.json>');
    const summary = analyzeReport(
      JSON.parse(readFileSync(first, 'utf8')),
      basename(first, '.json'),
    );
    const stem = first.slice(0, -'.json'.length);
    writeFileSync(
      `${stem}.summary.json`,
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    writeFileSync(`${stem}.summary.md`, renderMarkdown(summary));
    console.log(`Wrote ${stem}.summary.json and ${stem}.summary.md`);
  }
}
