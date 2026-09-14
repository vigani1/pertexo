#!/usr/bin/env node

import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import GithubSlugger from 'github-slugger';
import MarkdownIt from 'markdown-it';

// Tiny bundles flowchart rendering without runtime CDN imports.
// https://mermaid.js.org/config/usage.html#tiny-mermaid
const MERMAID_URL =
  'https://cdn.jsdelivr.net/npm/@mermaid-js/tiny@12.0.0/dist/mermaid.tiny.js';
const MERMAID_SHA256 =
  '9f2807e402479d2864bfd9a95052076fc69d0ff45a0b25148b84b70fc33425b9';

function headingText(token) {
  return (token.children ?? [])
    .filter((child) =>
      ['text', 'code_inline', 'image', 'softbreak'].includes(child.type),
    )
    .map((child) => (child.type === 'softbreak' ? ' ' : child.content))
    .join('');
}

// Markdown lives in docs/; output lives one level down in docs/dist/.
function outputLink(href) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/iu.test(href) || href === '')
    return href;
  return href.startsWith('/') ? `../..${href}` : `../${href}`;
}

export function renderOverview(source, template, mermaidBytes) {
  const markdown = new MarkdownIt({ html: false, linkify: false });
  const escape = markdown.utils.escapeHtml;
  const tokens = markdown.parse(source, {});
  const slugger = new GithubSlugger();
  const navigation = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      const title = headingText(tokens[index + 1]);
      const id = slugger.slug(title);
      token.attrSet('id', id);
      if (token.tag === 'h2')
        navigation.push(
          `<li><a href="#${escape(id)}">${escape(title)}</a></li>`,
        );
    }
    for (const child of token.children ?? []) {
      if (child.type === 'link_open')
        child.attrSet('href', outputLink(child.attrGet('href')));
      if (child.type === 'image')
        child.attrSet('src', outputLink(child.attrGet('src')));
    }
  }
  const defaultFence = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (items, index, ...rest) => {
    if (items[index].info.trim() !== 'mermaid')
      return defaultFence(items, index, ...rest);
    const diagram = escape(items[index].content);
    return `<div class="diagram"><pre class="mermaid">${diagram}</pre><details><summary>Diagram source</summary><pre>${diagram}</pre></details></div>\n`;
  };
  markdown.renderer.rules.table_open = () =>
    '<div class="table-scroll" role="region" aria-label="Reference table" tabindex="0"><table>\n';
  markdown.renderer.rules.table_close = () => '</table></div>\n';
  const values = {
    CONTENT: markdown.renderer.render(tokens, markdown.options, {}),
    NAV: navigation.join('\n'),
    SOURCE_HASH: createHash('sha256').update(source).digest('hex').slice(0, 12),
    MERMAID: mermaidBytes.toString('base64'),
  };
  for (const key of Object.keys(values)) {
    if (template.split(`{{${key}}}`).length !== 2)
      throw new Error(`Overview template must contain {{${key}}} once`);
  }
  // One pass avoids interpreting placeholder-looking text inside Markdown.
  return template.replace(
    /\{\{(CONTENT|NAV|SOURCE_HASH|MERMAID)\}\}/gu,
    (_, key) => values[key],
  );
}

export async function loadMermaidBundle(fetchBundle = fetch) {
  const response = await fetchBundle(MERMAID_URL, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Mermaid download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== MERMAID_SHA256)
    throw new Error('Mermaid bundle integrity mismatch; overview not written');
  return bytes;
}

async function generateOverview() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const [source, template, mermaid] = await Promise.all([
    readFile(path.join(root, 'docs/codebase-map.md'), 'utf8'),
    readFile(new URL('./overview-template.html', import.meta.url), 'utf8'),
    loadMermaidBundle(),
  ]);
  const output = path.join(root, 'docs/dist/codebase-map.html');
  const html = renderOverview(source, template, mermaid);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, html);
  console.log(`Generated offline overview: ${output}`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  await generateOverview();
