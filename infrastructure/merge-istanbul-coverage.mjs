#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

function sameMap(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right))
    throw new Error(`Coverage instrumentation changed for ${label}`);
}

function summedRecord(left, right) {
  return Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key] + right[key]]),
  );
}

export function mergeIstanbulCoverage(reports) {
  const merged = {};
  for (const report of reports) {
    for (const [file, coverage] of Object.entries(report)) {
      const current = merged[file];
      if (current === undefined) {
        merged[file] = JSON.parse(JSON.stringify(coverage));
        continue;
      }
      sameMap(
        current.statementMap,
        coverage.statementMap,
        `${file}:statements`,
      );
      sameMap(current.fnMap, coverage.fnMap, `${file}:functions`);
      sameMap(current.branchMap, coverage.branchMap, `${file}:branches`);
      current.s = summedRecord(current.s, coverage.s);
      current.f = summedRecord(current.f, coverage.f);
      current.b = Object.fromEntries(
        Object.keys(current.b).map((key) => [
          key,
          current.b[key].map((hits, index) => hits + coverage.b[key][index]),
        ]),
      );
    }
  }
  return merged;
}

async function main() {
  const [firstPath, secondPath, outputPath] = process.argv.slice(2);
  if (
    firstPath === undefined ||
    secondPath === undefined ||
    outputPath === undefined
  )
    throw new Error('Expected two input reports and one output path');
  const reports = await Promise.all(
    [firstPath, secondPath].map(async (file) =>
      JSON.parse(await readFile(file, 'utf8')),
    ),
  );
  const merged = mergeIstanbulCoverage(reports);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(merged)}\n`);
  process.stdout.write(
    `Merged ${String(Object.keys(merged).length)} instrumented files into ${outputPath}\n`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
