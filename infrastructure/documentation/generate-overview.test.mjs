import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadMermaidBundle, renderOverview } from './generate-overview.mjs';

const template =
  '<nav>{{NAV}}</nav><main>{{CONTENT}}</main><footer>{{SOURCE_HASH}}</footer><script src="data:text/javascript;base64,{{MERMAID}}"></script>';
const bundle = Buffer.from('/* renderer fixture */');

test('generates matching heading anchors and navigation from Markdown', () => {
  const html = renderOverview(
    '# Overview\n\n## **Features** and `runs`\n\nUseful content.\n\n## Features and runs\n',
    template,
    bundle,
  );
  assert.match(html, /<h2 id="features-and-runs">/u);
  assert.match(html, /<h2 id="features-and-runs-1">/u);
  assert.match(html, /href="#features-and-runs-1"/u);
  assert.match(html, /Useful content\./u);
});

test('keeps section links and rebases local file, image, and directory links', () => {
  const html = renderOverview(
    '[Section](#features) [Runbook](./operations/test-confidence.md#scope) [Package](../packages/queue/) [Root](/README.md) [External](https://example.com/) ![Image](./image.svg)\n',
    template,
    bundle,
  );
  for (const href of [
    '#features',
    '.././operations/test-confidence.md#scope',
    '../../packages/queue/',
    '../../README.md',
    'https://example.com/',
  ])
    assert.ok(html.includes(`href="${href}"`));
  assert.ok(html.includes('src=".././image.svg"'));
});

test('escapes raw HTML and diagram text and retains readable diagram source', () => {
  const html = renderOverview(
    '<script>alert(1)</script>\n\n```mermaid\nflowchart TB\n A["<script>bad</script>"]\n```\n\n```js\nconst x = 1;\n```\n',
    template,
    bundle,
  );
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /class="mermaid"/u);
  assert.match(html, /<summary>Diagram source<\/summary>/u);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/u);
  assert.match(html, /class="language-js"/u);
});

test('embeds the renderer offline and leaves source placeholder text untouched', () => {
  const source = '## Features\n\n{{NAV}}\n';
  const html = renderOverview(source, template, bundle);
  assert.match(html, /<p>\{\{NAV\}\}<\/p>/u);
  assert.ok(html.includes(`base64,${bundle.toString('base64')}`));
  assert.equal(html, renderOverview(source, template, bundle));
  assert.notEqual(html, renderOverview(`${source}Changed`, template, bundle));
  assert.throws(
    () => renderOverview(source, '{{CONTENT}}', bundle),
    /template/u,
  );
});

test('wraps tables for narrow screens and uses the real page template', async () => {
  const page = await readFile(
    new URL('./overview-template.html', import.meta.url),
    'utf8',
  );
  const html = renderOverview(
    '## Features\n\n| Part | Does |\n| --- | --- |\n| API | Requests |\n',
    page,
    bundle,
  );
  assert.match(html, /class="table-scroll"/u);
  assert.match(html, /<td>Requests<\/td>/u);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /id="content"/u);
  assert.ok(!/\{\{(?:NAV|CONTENT|MERMAID|SOURCE_HASH)\}\}/u.test(html));
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)="https?:/u.test(html));
});

test('fails closed on a failed or changed renderer download', async () => {
  await assert.rejects(
    loadMermaidBundle(async () => new Response('', { status: 503 })),
    /HTTP 503/u,
  );
  await assert.rejects(
    loadMermaidBundle(async () => new Response('changed bundle')),
    /integrity mismatch/u,
  );
  await assert.rejects(
    loadMermaidBundle(async () => {
      throw new Error('offline');
    }),
    /offline/u,
  );
});
