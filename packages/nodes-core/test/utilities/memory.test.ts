import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('refuses long repeated XML names within a bounded heap before output amplification', () => {
  const moduleUrl = new URL(
    '../../dist/data/utilities/xml/build.js',
    import.meta.url,
  ).href;
  const script = `
    const { buildXml } = await import(${JSON.stringify(moduleUrl)});
    const input = { root: { ['n'.repeat(32_768)]: Array.from({ length: 2_000 }, () => 'x') } };
    try {
      buildXml(input, new AbortController().signal);
      throw new Error('Expected a bounded XML refusal');
    } catch (error) {
      if (error.safeErrorCode !== 'utility.result_too_large') throw error;
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
