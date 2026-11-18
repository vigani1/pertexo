// Writes the Markdown view of an overlap summary. The JSON beside it keeps
// every entry; the Markdown shows the largest few of each list.

const LIST_LIMIT = 60;
const CLUSTER_LIMIT = 10;

export function renderMarkdown(summary) {
  const { groups, lists, notMeasured, threshold } = summary;
  return [
    '# Coverage overlap',
    '',
    'Each test file ran alone; its reach is the source lines it executed inside functions (module top level is left out: it runs on any import). Reach is not proof of checking, so every list names candidates to read, not files to delete.',
    '',
    '| Workspace | Lane | Files | Test lines | Measured | Reach nothing new | Their lines | Inside a real-path file | Their lines | Clusters | Their lines |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...groups.map(
      (group) =>
        `| ${group.workspace} | ${group.lane} | ${group.files} | ${group.testLines} | ${group.measured} | ${group.noNewReach} (${formatShare(group.noNewReachShare)}) | ${group.noNewReachLines} | ${group.containedByRealPath} | ${group.containedByRealPathLines} | ${group.clusters} | ${group.clusterLines} |`,
    ),
    '',
    `Closest same-area neighbour, files per tenth of weighted overlap (0.0–0.1 … 1.0): ${summary.bestNeighbourOverlap.join(', ')}. Clusters join files at ${String(threshold)} or more.`,
    '',
    ...section(
      'Reach no line another file does not reach',
      'Largest first. Removing one alone loses no reached line.',
      lists.noNewReach,
      (test) => `- ${describe(test)}`,
    ),
    ...section(
      'Reach lies inside one other file',
      'The container shown is a real-path file (an integration file or a Playwright spec) when there is one.',
      lists.contained,
      (test) =>
        `- ${describe(test)} ⊆ \`${test.container}\` (${test.containerLane}${test.sameReach ? ', same reach' : ''}; ${test.containers} container${test.containers === 1 ? '' : 's'})`,
    ),
    ...section(
      'Merge clusters',
      'Files of one area whose reach overlaps; candidates to fold into one flow test. Largest by test lines.',
      lists.clusters.slice(0, CLUSTER_LIMIT),
      (cluster) =>
        [
          `- **${cluster.area}**: ${cluster.members.length} files, ${cluster.testLines} test lines, ${cluster.its} tests; ${cluster.sharedLines} lines reached by all of them, ${cluster.unionLines} by any`,
          ...cluster.members.map((test) => `  - ${describe(test)}`),
        ].join('\n'),
    ),
    `## Not measured (${notMeasured.length})`,
    '',
    'Failed or ran no passing test, so their reach is left out of every comparison.',
    '',
    ...(notMeasured.length
      ? notMeasured.map(
          (test) =>
            `- \`${test.file}\` (${test.status}, ${test.testLines} lines)`,
        )
      : ['None.']),
    '',
  ].join('\n');
}

function section(title, explanation, items, line) {
  const shown = items.slice(0, LIST_LIMIT);
  return [
    `## ${title} (${items.length})`,
    '',
    explanation,
    ...(items.length > shown.length
      ? [`The first ${shown.length} are shown; the JSON has all of them.`]
      : []),
    '',
    ...(shown.length ? shown.map(line) : ['None.']),
    '',
  ];
}

function describe(test) {
  const keep = test.keep.length ? ` — keep: ${test.keep.join(', ')}` : '';
  return `\`${test.file}\` (${test.testLines} lines, ${test.its} tests, ${test.mocks} mocks; reaches ${test.reached}, alone ${test.reachedByNoOther})${keep}`;
}

function formatShare(share) {
  return share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`;
}
