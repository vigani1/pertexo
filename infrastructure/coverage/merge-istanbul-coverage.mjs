#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

function sameMap(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right))
    throw new Error(`Coverage instrumentation changed for ${label}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function assertHit(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Coverage hit count is invalid for ${label}`);
}

function validateCoverageEntry(file, coverage) {
  if (
    !isRecord(coverage) ||
    typeof coverage.path !== 'string' ||
    coverage.path.length === 0 ||
    coverage.path !== file
  )
    throw new Error(`Coverage entry is malformed for ${file}`);
  for (const [mapName, hitName] of [
    ['statementMap', 's'],
    ['fnMap', 'f'],
    ['branchMap', 'b'],
  ]) {
    if (!isRecord(coverage[mapName]) || !isRecord(coverage[hitName]))
      throw new Error(
        `Coverage ${mapName}/${hitName} is malformed for ${file}`,
      );
    if (!Object.values(coverage[mapName]).every(isRecord))
      throw new Error(`Coverage ${mapName} entries are malformed for ${file}`);
    if (!sameKeys(coverage[mapName], coverage[hitName]))
      throw new Error(`Coverage ${mapName}/${hitName} keys differ for ${file}`);
  }
  for (const [key, hits] of Object.entries(coverage.s))
    assertHit(hits, `${file}:statement:${key}`);
  for (const [key, hits] of Object.entries(coverage.f))
    assertHit(hits, `${file}:function:${key}`);
  for (const [key, hits] of Object.entries(coverage.b)) {
    const locations = coverage.branchMap[key]?.locations;
    if (!Array.isArray(hits) || !Array.isArray(locations))
      throw new Error(
        `Coverage branch evidence is malformed for ${file}:${key}`,
      );
    if (hits.length !== locations.length)
      throw new Error(`Coverage branch arity changed for ${file}:${key}`);
    hits.forEach((hit, index) =>
      assertHit(hit, `${file}:branch:${key}:${String(index)}`),
    );
  }
}

function validateCoverageReport(report, index) {
  if (!isRecord(report))
    throw new Error(`Coverage report ${String(index + 1)} is malformed`);
  for (const [file, coverage] of Object.entries(report))
    validateCoverageEntry(file, coverage);
}

function summedRecord(left, right, label) {
  return Object.fromEntries(
    Object.keys(left).map((key) => {
      const sum = left[key] + right[key];
      assertHit(sum, `${label}:${key}:sum`);
      return [key, sum];
    }),
  );
}

export function mergeIstanbulCoverage(reports) {
  if (!Array.isArray(reports) || reports.length === 0)
    throw new Error('Coverage reports must be a nonempty array');
  const merged = {};
  for (const [index, report] of reports.entries()) {
    validateCoverageReport(report, index);
    for (const [file, coverage] of Object.entries(report)) {
      const current = merged[file];
      if (current === undefined) {
        merged[file] = {
          ...coverage,
          b: Object.fromEntries(
            Object.entries(coverage.b).map(([key, hits]) => [key, [...hits]]),
          ),
          f: { ...coverage.f },
          s: { ...coverage.s },
        };
        continue;
      }
      sameMap(
        current.statementMap,
        coverage.statementMap,
        `${file}:statements`,
      );
      sameMap(current.fnMap, coverage.fnMap, `${file}:functions`);
      sameMap(current.branchMap, coverage.branchMap, `${file}:branches`);
      current.s = summedRecord(current.s, coverage.s, `${file}:statements`);
      current.f = summedRecord(current.f, coverage.f, `${file}:functions`);
      current.b = Object.fromEntries(
        Object.keys(current.b).map((key) => [
          key,
          current.b[key].map((hits, branchIndex) => {
            const sum = hits + coverage.b[key][branchIndex];
            assertHit(sum, `${file}:branch:${key}:${String(branchIndex)}:sum`);
            return sum;
          }),
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
