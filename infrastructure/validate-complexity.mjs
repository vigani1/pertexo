#!/usr/bin/env node

import console from 'node:console';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(
  root,
  'infrastructure',
  'complexity-baseline.json',
);
const FILE_LINE_BUDGET = 500;
const FUNCTION_LINE_BUDGET = 200;
const FUNCTION_BRANCH_BUDGET = 40;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(location)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
      files.push(location);
  }
  return files;
}

function branchIncrement(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  )
    return 1;
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  )
    return 1;
  return 0;
}

function functionName(node, sourceFile, anonymousCounts) {
  if ('name' in node && node.name !== undefined)
    return node.name.getText(sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile);
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  const kind = ts.SyntaxKind[node.kind] ?? 'Function';
  const next = (anonymousCounts.get(kind) ?? 0) + 1;
  anonymousCounts.set(kind, next);
  return `<${kind}:${next}>`;
}

function analyzeFunction(node, sourceFile, relativePath, anonymousCounts) {
  let branches = 0;
  const visit = (child) => {
    if (child !== node && ts.isFunctionLike(child)) return;
    branches += branchIncrement(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  return {
    key: `${relativePath}#${functionName(node, sourceFile, anonymousCounts)}`,
    file: relativePath,
    lines: end - start + 1,
    branches,
  };
}

async function inventory() {
  const roots = ['apps', 'packages'];
  const files = (
    await Promise.all(
      roots.map(async (directory) => {
        const parent = path.join(root, directory);
        const packages = await readdir(parent, { withFileTypes: true });
        return (
          await Promise.all(
            packages
              .filter((entry) => entry.isDirectory())
              .map(async (entry) => {
                const source = path.join(parent, entry.name, 'src');
                try {
                  return await sourceFiles(source);
                } catch (error) {
                  if (error?.code === 'ENOENT') return [];
                  throw error;
                }
              }),
          )
        ).flat();
      }),
    )
  ).flat();
  const fileHotspots = {};
  const functionHotspots = {};
  const allFunctions = [];
  for (const absolutePath of files.sort()) {
    const relativePath = path.relative(root, absolutePath);
    const source = await readFile(absolutePath, 'utf8');
    const lines = source.split('\n').length;
    if (lines > FILE_LINE_BUDGET) fileHotspots[relativePath] = lines;
    const sourceFile = ts.createSourceFile(
      absolutePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const anonymousCounts = new Map();
    const visit = (node) => {
      if (ts.isFunctionLike(node)) {
        const measurement = analyzeFunction(
          node,
          sourceFile,
          relativePath,
          anonymousCounts,
        );
        allFunctions.push(measurement);
        if (
          measurement.lines > FUNCTION_LINE_BUDGET ||
          measurement.branches > FUNCTION_BRANCH_BUDGET
        )
          functionHotspots[measurement.key] = {
            branches: measurement.branches,
            lines: measurement.lines,
          };
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { fileHotspots, functionHotspots, allFunctions };
}

export function findComplexityRegressions(current, baseline) {
  const errors = [];
  for (const [file, lines] of Object.entries(current.fileHotspots)) {
    const allowed = baseline.fileHotspots[file];
    if (allowed === undefined)
      errors.push(`new file hotspot: ${file} has ${lines} lines`);
    else if (lines > allowed)
      errors.push(
        `file hotspot worsened: ${file} ${allowed} -> ${lines} lines`,
      );
  }
  for (const [key, measurement] of Object.entries(current.functionHotspots)) {
    const allowed = baseline.functionHotspots[key];
    if (allowed === undefined)
      errors.push(
        `new function hotspot: ${key} has ${measurement.lines} lines/${measurement.branches} branches`,
      );
    else if (
      measurement.lines > allowed.lines ||
      measurement.branches > allowed.branches
    )
      errors.push(
        `function hotspot worsened: ${key} ${allowed.lines}/${allowed.branches} -> ${measurement.lines}/${measurement.branches}`,
      );
  }
  return errors;
}

async function main() {
  const current = await inventory();
  if (process.argv.includes('--write')) {
    const baseline = {
      budgets: {
        fileLines: FILE_LINE_BUDGET,
        functionBranches: FUNCTION_BRANCH_BUDGET,
        functionLines: FUNCTION_LINE_BUDGET,
      },
      fileHotspots: current.fileHotspots,
      functionHotspots: current.functionHotspots,
    };
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `Wrote ${Object.keys(baseline.fileHotspots).length} file and ${Object.keys(baseline.functionHotspots).length} function hotspot baselines.`,
    );
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const errors = findComplexityRegressions(current, baseline);
    const top = current.allFunctions
      .sort(
        (left, right) =>
          right.branches - left.branches || right.lines - left.lines,
      )
      .slice(0, 10);
    console.log('Top source-function complexity hotspots:');
    for (const item of top)
      console.log(
        `- ${item.key}: ${item.lines} lines, ${item.branches} branches`,
      );
    if (errors.length > 0) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        'Complexity ratchet passed without a new or worsened hotspot.',
      );
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
