import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// How a lane runner picks its files, measures them, and writes its report:
// the steps the Vitest and Playwright runners share, so both lanes write the
// one report shape analyze-overlap.mjs reads.

export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/u.exec(text);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total)
    throw new Error(`--shard takes i/n with 1 <= i <= n, not ${text}`);
  return { index, total };
}

/** Round-robin over the sorted list, so neighbouring files (often of similar
 * weight) spread across shards. Every file lands in exactly one shard. */
export function pickShard(files, { index, total }) {
  return [...files]
    .sort()
    .filter((_, position) => position % total === index - 1);
}

/**
 * Measures each file, `concurrency` at a time, and returns the records by
 * file and the files that failed. `measure(file, slot)` gets a slot below
 * `concurrency` that no other running file holds.
 *
 * Coverage makes some tests several times slower (a SAML signing test went
 * from 1.4 s to 7.8 s), and with other files sharing the CPU a few then pass
 * their own explicit time limits, which no configuration can raise. A file
 * that failed beside others runs once more alone; one that fails alone too
 * stays failed.
 */
export async function measureEach(files, concurrency, measure) {
  const records = {};
  const failed = [];
  const run = async (file, slot, label) => {
    const record = await measure(file, slot);
    records[file] = record;
    console.log(
      `${label} ${file}: ${record.status}, ${String(countLines(record.reached))} lines, ${String(record.seconds)} s`,
    );
    return record;
  };
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, files.length) },
      async (_, slot) => {
        while (next < files.length) {
          const index = next++;
          const record = await run(
            files[index],
            slot,
            `[${String(index + 1)}/${String(files.length)}]`,
          );
          if (record.status === 'failed') failed.push(files[index]);
        }
      },
    ),
  );
  if (concurrency > 1)
    for (const file of failed.splice(0))
      if ((await run(file, 0, '[alone]')).status === 'failed')
        failed.push(file);
  return { records, failed };
}

/** Writes reports/overlap/<workspace>-<lane>[-<i>of<n>].json under `root`. */
export function writeLaneReport(root, { workspace, lane, shard, records }) {
  const output = join(
    root,
    'reports/overlap',
    `${workspace}-${lane}${shard ? `-${String(shard.index)}of${String(shard.total)}` : ''}.json`,
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    `${JSON.stringify({ workspace, lane, shard, files: sortKeys(records) })}\n`,
  );
  console.log(`Wrote ${relative(root, output)}`);
}

/** A lane's result: failed when any test or the run itself failed. */
export function fileStatus(exitCode, tests) {
  if (exitCode !== 0 || tests.failed > 0) return 'failed';
  return tests.passed > 0 ? 'passed' : 'skipped';
}

function countLines(reached) {
  return Object.values(reached).reduce((sum, lines) => sum + lines.length, 0);
}

function sortKeys(object) {
  return Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')),
  );
}
