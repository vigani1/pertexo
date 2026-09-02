#!/usr/bin/env node

import { execFile } from 'node:child_process';
import console from 'node:console';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import GithubSlugger from 'github-slugger';
import MarkdownIt from 'markdown-it';

const execute = promisify(execFile);
const markdown = new MarkdownIt({ html: false, linkify: false });

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

async function markdownFiles(rootDirectory) {
  const files = [];
  const readTree = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await readTree(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.md'))
        files.push(entryPath);
    }
  };
  const readme = path.join(rootDirectory, 'README.md');
  try {
    if ((await stat(readme)).isFile()) files.push(readme);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
  await readTree(path.join(rootDirectory, 'docs'));
  return files.sort();
}

function inlineText(token) {
  if (!Array.isArray(token.children)) return token.content;
  return token.children
    .filter((child) =>
      ['code_inline', 'image', 'softbreak', 'text'].includes(child.type),
    )
    .map((child) => (child.type === 'softbreak' ? ' ' : child.content))
    .join('');
}

function inspectMarkdown(contents) {
  const tokens = markdown.parse(contents, {});
  const anchors = new Set();
  const links = [];
  const slugger = new GithubSlugger();

  const inspectTokens = (items) => {
    for (const token of items) {
      if (token.type === 'link_open') links.push(token.attrGet('href'));
      if (token.type === 'image') links.push(token.attrGet('src'));
      if (Array.isArray(token.children)) inspectTokens(token.children);
    }
  };
  inspectTokens(tokens);

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].type !== 'heading_open') continue;
    const inline = tokens[index + 1];
    if (inline.type === 'inline') anchors.add(slugger.slug(inlineText(inline)));
  }
  return { anchors, links: links.filter((link) => typeof link === 'string') };
}

function localTarget(rootDirectory, sourceFile, href) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('//')) return null;
  const hashIndex = href.indexOf('#');
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const rawPath =
    queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  let targetPath;
  let anchor;
  try {
    const decodedPath = decodeURIComponent(rawPath);
    targetPath = decodedPath.startsWith('/')
      ? path.resolve(rootDirectory, decodedPath.slice(1))
      : path.resolve(path.dirname(sourceFile), decodedPath || '.');
    anchor =
      hashIndex === -1
        ? undefined
        : decodeURIComponent(href.slice(hashIndex + 1));
  } catch {
    throw new Error(`link contains invalid percent encoding: ${href}`);
  }
  const relativeTarget = path.relative(rootDirectory, targetPath);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error(`local link escapes the repository: ${href}`);
  }
  return { anchor, relativeTarget, targetPath };
}

async function validateLinks(rootDirectory, files, contentsByFile) {
  const errors = [];
  let localLinksChecked = 0;
  const inspections = new Map(
    files.map((file) => [file, inspectMarkdown(contentsByFile.get(file))]),
  );
  for (const sourceFile of files) {
    const relativeSource = path.relative(rootDirectory, sourceFile);
    for (const href of inspections.get(sourceFile).links) {
      let target;
      try {
        target = localTarget(rootDirectory, sourceFile, href);
      } catch (error) {
        errors.push(`${relativeSource}: ${error.message}`);
        continue;
      }
      if (target === null) continue;
      localLinksChecked += 1;
      let targetStats;
      try {
        targetStats = await stat(target.targetPath);
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
        errors.push(
          `${relativeSource}: local link target does not exist: ${target.relativeTarget}`,
        );
        continue;
      }
      if (target.anchor === undefined || target.anchor === '') continue;
      if (!targetStats.isFile() || !target.targetPath.endsWith('.md')) {
        errors.push(
          `${relativeSource}: heading anchor targets a non-Markdown file: ${href}`,
        );
        continue;
      }
      let targetInspection = inspections.get(target.targetPath);
      if (targetInspection === undefined) {
        const targetContents = await readFile(target.targetPath, 'utf8');
        targetInspection = inspectMarkdown(targetContents);
        inspections.set(target.targetPath, targetInspection);
      }
      if (!targetInspection.anchors.has(target.anchor)) {
        errors.push(
          `${relativeSource}: heading anchor does not exist: ${target.relativeTarget}#${target.anchor}`,
        );
      }
    }
  }
  return { errors, localLinksChecked };
}

function requiredMatch(contents, pattern, label) {
  const match = pattern.exec(contents);
  if (match === null) throw new Error(`${label} is missing`);
  return match[1];
}

async function validateAuditHead(rootDirectory, contentsByFile) {
  const auditFile = path.join(rootDirectory, 'docs/whole-repository-audit.md');
  const progressFile = path.join(
    rootDirectory,
    'docs/implementation-progress.md',
  );
  const statusFile = path.join(
    rootDirectory,
    'docs/current-implementation-status.md',
  );
  const auditedHead = requiredMatch(
    contentsByFile.get(auditFile),
    /^Audited implementation head: `([\da-f]{40})`$/mu,
    'whole-repository-audit.md audited implementation head',
  );
  const progressHead = requiredMatch(
    contentsByFile.get(progressFile),
    /^## Current whole-repository audit — implementation head `([\da-f]{7,40})`$/mu,
    'implementation-progress.md current audit head',
  );
  const statusHead = requiredMatch(
    contentsByFile.get(statusFile),
    /^Audited implementation head: `([\da-f]{40})`$/mu,
    'current-implementation-status.md audited implementation head',
  );
  if (!auditedHead.startsWith(progressHead)) {
    throw new Error(
      'implementation-progress.md audit head must match whole-repository-audit.md',
    );
  }
  if (statusHead !== auditedHead) {
    throw new Error(
      'current-implementation-status.md audit head must match whole-repository-audit.md',
    );
  }
  try {
    await execute('git', [
      '-C',
      rootDirectory,
      'merge-base',
      '--is-ancestor',
      auditedHead,
      'HEAD',
    ]);
  } catch {
    throw new Error(
      'audited implementation head must resolve to an ancestor of the publication',
    );
  }
  return auditedHead;
}

export async function validateDocumentationRepository(rootDirectory) {
  const absoluteRoot = path.resolve(rootDirectory);
  const files = await markdownFiles(absoluteRoot);
  const contentsByFile = new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(file, 'utf8')]),
    ),
  );
  const { errors, localLinksChecked } = await validateLinks(
    absoluteRoot,
    files,
    contentsByFile,
  );
  if (errors.length > 0) {
    throw new Error(
      `Documentation validation failed:\n- ${errors.join('\n- ')}`,
    );
  }
  const auditedHead = await validateAuditHead(absoluteRoot, contentsByFile);
  return { auditedHead, filesChecked: files.length, localLinksChecked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
  const result = await validateDocumentationRepository(rootDirectory);
  console.log(
    `Validated ${result.localLinksChecked} local documentation links across ${result.filesChecked} files at audited head ${result.auditedHead.slice(0, 7)}.`,
  );
}
