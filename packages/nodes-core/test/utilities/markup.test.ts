import { describe, expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';
const registry = createCoreNodeRegistry();
const run = (key: string, config: unknown, value: unknown) =>
  registry.execute({
    definition: { key: `core.${key}`, version: 1 },
    executor: { key: `core.${key}`, version: 1 },
    config,
    input: { value },
    signal: new AbortController().signal,
  });

describe('bounded markup conversion', () => {
  it('quotes boolean attributes and preserves their text on round trip', async () => {
    const built = await run(
      'xml',
      { operation: 'build' },
      { r: { '@_enabled': true, '@_disabled': false, '@_literal': 'true' } },
    );
    expect(built).toMatchObject({
      output: { value: '<r enabled="true" disabled="false" literal="true"/>' },
    });
    expect(
      await run(
        'xml',
        { operation: 'parse' },
        (built.output as { value: string }).value,
      ),
    ).toMatchObject({
      output: {
        value: {
          r: {
            '@_enabled': 'true',
            '@_disabled': 'false',
            '@_literal': 'true',
          },
        },
      },
    });
  });
  it('requires names for nested lists and scalar non-null #text', async () => {
    for (const value of [{ r: { item: [[1, 2]] } }, { r: { '#text': null } }])
      await expect(
        run('xml', { operation: 'build' }, value),
      ).rejects.toMatchObject({ safeErrorCode: 'utility.xml_data' });
  });
  it('preserves empty lists, null attributes and null elements when budgeting XML', async () => {
    expect(
      await run(
        'xml',
        { operation: 'build' },
        { r: { '@_omit': null, missing: [], child: null } },
      ),
    ).toMatchObject({ output: { value: '<r><child/></r>' } });
  });
  it('admits the exact retained XML result size and refuses one additional byte', async () => {
    const count =
      262_144 - Buffer.byteLength(JSON.stringify({ value: '<r></r>' }));
    const result = await run(
      'xml',
      { operation: 'build' },
      { r: 'x'.repeat(count) },
    );
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBe(262_144);
    await expect(
      run('xml', { operation: 'build' }, { r: 'x'.repeat(count + 1) }),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.result_too_large' });
  });
  it('converts XML with strings, Unicode names, attributes, namespaces and repeated elements', async () => {
    const source =
      '<orders xmlns:x="urn:order"><x:order id="001"><amount>12.5</amount></x:order><x:order id="002"><amount>0</amount></x:order><名>&lt;A &amp; B&gt; &#x1F600;</名></orders>';
    const result = await run('xml', { operation: 'parse' }, source);
    expect(result).toMatchObject({
      output: {
        value: {
          orders: {
            '@_xmlns:x': 'urn:order',
            'x:order': [
              { '@_id': '001', amount: '12.5' },
              { '@_id': '002', amount: '0' },
            ],
            名: '<A & B> 😀',
          },
        },
      },
    });
    const built = await run(
      'xml',
      { operation: 'build' },
      (result.output as { value: unknown }).value,
    );
    expect(
      await run(
        'xml',
        { operation: 'parse' },
        (built.output as { value: string }).value,
      ),
    ).toEqual(result);
  });
  it('escapes element/attribute values and preserves whitespace and empty elements', async () => {
    const built = await run(
      'xml',
      { operation: 'build' },
      { root: { '@_quote': '"<&', item: [' one ', ''], '#text': '<script>&' } },
    );
    expect((built.output as { value: string }).value).toContain(
      '&lt;script&gt;&amp;',
    );
    expect(
      await run(
        'xml',
        { operation: 'parse' },
        (built.output as { value: string }).value,
      ),
    ).toMatchObject({
      output: {
        value: {
          root: { '@_quote': '"<&', item: [' one ', ''], '#text': '<script>&' },
        },
      },
    });
  });
  it('ignores declarations/comments and reports only safe line and column for malformed input', async () => {
    expect(
      await run(
        'xml',
        { operation: 'parse' },
        '<?xml version="1.0"?><r><!-- secret -->ok</r>',
      ),
    ).toMatchObject({ output: { value: { r: 'ok' } } });
    const result = await run(
      'xml',
      { operation: 'parse' },
      '<root>private\n<child></root>',
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({
      safeErrorCode: 'utility.xml_malformed',
    });
    expect(result).toHaveProperty(
      'errorSummary',
      expect.stringContaining('line 2'),
    );
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([
    '<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>',
    '<!DOCTYPE r [<!ENTITY x "secret">]><r>&x;</r>',
  ])(
    'rejects DTDs before any expansion or external resolution',
    async (source) => {
      await expect(
        run('xml', { operation: 'parse' }, source),
      ).rejects.toMatchObject({ safeErrorCode: 'utility.xml_dtd' });
    },
  );
  it.each([
    '<r><constructor>x</constructor></r>',
    '<r><__proto__>x</__proto__></r>',
  ])('rejects reserved XML names without renaming data', async (source) => {
    await expect(
      run('xml', { operation: 'parse' }, source),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.xml_name' });
  });
  it('rejects excessive XML depth, element count and output size', async () => {
    await expect(
      run(
        'xml',
        { operation: 'parse' },
        '<r>'.repeat(52) + 'x' + '</r>'.repeat(52),
      ),
    ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
    await expect(
      run('xml', { operation: 'parse' }, '<r>' + '<i/>'.repeat(8_001) + '</r>'),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.xml_size' });
    await expect(
      run('xml', { operation: 'build' }, { r: '&'.repeat(250_000) }),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.result_too_large' });
  });
  it.each([
    { a: [], b: 1 },
    { r: [1, 2] },
    { r: { 'bad name': 1 } },
    { r: { '@_id': { x: 1 } } },
    { r: { '#text': [1, 2] } },
  ])('refuses invalid XML output shapes', async (value) => {
    await expect(
      run('xml', { operation: 'build' }, value),
    ).rejects.toMatchObject({ kind: 'failed', possiblyDispatched: false });
  });
  it('extracts inert HTML text and exact attributes with selectors and visible limits', async () => {
    const source =
      '<main><a class="link" href="/one?a=1&amp;b=2">One <b>bold</b></a><a class="link">Two</a><script>throw new Error("never run")</script><img src="https://example.invalid/x"></main>';
    expect(
      await run(
        'html',
        { operation: 'text', selector: 'main > a.link', limit: 1 },
        source,
      ),
    ).toMatchObject({
      output: { items: ['One bold'], matchCount: 2, truncated: true },
    });
    expect(
      await run(
        'html',
        {
          operation: 'attribute',
          selector: 'a.link',
          attribute: 'href',
          limit: 10,
        },
        source,
      ),
    ).toMatchObject({
      output: { items: ['/one?a=1&b=2', ''], matchCount: 2, truncated: false },
    });
    expect(
      await run(
        'html',
        { operation: 'text', selector: 'a[href], img', limit: 10 },
        source,
      ),
    ).toMatchObject({ output: { items: ['One bold', ''], matchCount: 2 } });
  });
  it.each(['a:has(b)', 'a:not(.x)', 'a::before', '[', 'a,'.repeat(8) + 'a'])(
    'refuses malformed or unbounded selector features',
    async (selector) => {
      await expect(
        run(
          'html',
          { operation: 'text', selector, limit: 100 },
          '<a>private</a>',
        ),
      ).rejects.toMatchObject({ safeErrorCode: 'utility.html_selector' });
    },
  );
  it('bounds the DOM during parsing, before selection, and measures a maximum document', async () => {
    await expect(
      run(
        'html',
        { operation: 'text', selector: 'b', limit: 1 },
        '<div>'.repeat(50) + '</div>'.repeat(50),
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.html_depth' });
    await expect(
      run(
        'html',
        { operation: 'text', selector: 'i', limit: 1 },
        '<i x="1"></i>'.repeat(4_001),
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.html_size' });
    const start = performance.now();
    const result = await run(
      'html',
      { operation: 'text', selector: 'i', limit: 4_998 },
      '<i>x</i>'.repeat(4_000),
    );
    expect((result.output as { items: string[] }).items).toHaveLength(4_000);
    console.info(
      `F38 bounded HTML: 8,000 nodes, 4,000 results in ${(performance.now() - start).toFixed(1)}ms`,
    );
  });
  it.each([
    '<r>&bogus;</r>',
    '<r>&#0;</r>',
    '<r>&#xD800;</r>',
    '<r>\u0001</r>',
  ])('refuses invalid XML characters and undefined entities', async (value) => {
    await expect(
      run('xml', { operation: 'parse' }, value),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.xml_malformed' });
  });
  it('normalizes source line endings in linear work and preserves referenced CR', async () => {
    expect(
      await run('xml', { operation: 'parse' }, '<r>a\r\nb\rc&#xD;d</r>'),
    ).toMatchObject({ output: { value: { r: 'a\nb\nc\rd' } } });
    const start = performance.now();
    await expect(
      run('xml', { operation: 'parse' }, '<r>' + '\r'.repeat(500_000) + '</r>'),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.result_too_large' });
    console.info(
      `F38 XML: 500,000 normalized line endings in ${(performance.now() - start).toFixed(1)}ms`,
    );
  });
  it('supports bounded structural CSS pseudo-classes and measures the maximum flat DOM', async () => {
    expect(
      await run(
        'html',
        { operation: 'text', selector: 'li:nth-child(2n+1)', limit: 10 },
        '<ul><li>one</li><li>two</li><li>three</li></ul>',
      ),
    ).toMatchObject({ output: { items: ['one', 'three'], matchCount: 2 } });
    const start = performance.now();
    const result = await run(
      'html',
      { operation: 'text', selector: 'i:nth-child(odd)', limit: 4_998 },
      '<i></i>'.repeat(8_000),
    );
    expect((result.output as { items: string[] }).items).toHaveLength(4_000);
    console.info(
      `F38 structural selector: 8,000 elements in ${(performance.now() - start).toFixed(1)}ms`,
    );
  });
  it('refuses repeated ancestor text before accumulating an oversized HTML result', async () => {
    await expect(
      run(
        'html',
        { operation: 'text', selector: 'div', limit: 100 },
        '<div>'.repeat(40) + 'x'.repeat(700_000) + '</div>'.repeat(40),
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.result_too_large' });
    expect(
      await run(
        'html',
        { operation: 'attribute', selector: 'a', attribute: 'HREF', limit: 1 },
        '<a href="/exact">Link</a>',
      ),
    ).toMatchObject({ output: { items: ['/exact'] } });
  });

  it('refuses combinatorial selectors before querying a maximum-depth tree', async () => {
    const selector = 'missing ' + 'div '.repeat(14) + 'span';
    await expect(
      run(
        'html',
        { operation: 'text', selector, limit: 10 },
        '<div>'.repeat(46) + '<span>x</span>' + '</div>'.repeat(46),
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.html_selector' });
    for (const unsafe of ['a ~ b', 'div div span', 'i:first-child:last-child'])
      await expect(
        run(
          'html',
          { operation: 'text', selector: unsafe, limit: 10 },
          '<i>x</i>',
        ),
      ).rejects.toMatchObject({ safeErrorCode: 'utility.html_selector' });
    expect(
      await run(
        'html',
        { operation: 'text', selector: 'div span', limit: 10 },
        '<div>'.repeat(46) + '<span>x</span>' + '</div>'.repeat(46),
      ),
    ).toMatchObject({ output: { items: ['x'], matchCount: 1 } });
  });
  it('bounds processing instructions and repeated XML collections', async () => {
    await expect(
      run('xml', { operation: 'parse' }, '<?p x?>'.repeat(8_001) + '<r/>'),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.xml_size' });
    await expect(
      run('xml', { operation: 'parse' }, '<r>' + '<i/>'.repeat(4_999) + '</r>'),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.too_many_items' });
    await expect(
      run(
        'xml',
        { operation: 'build' },
        { r: { i: Array.from({ length: 4_999 }, () => 1) } },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'utility.too_many_items' });
  });
});
