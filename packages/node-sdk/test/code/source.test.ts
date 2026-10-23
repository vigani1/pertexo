import { describe, expect, it } from 'vitest';
import {
  CODE_LIMITS,
  DEFAULT_CODE_SETTINGS,
  inspectCodeSource,
  parseCodeSettings,
  codeRunnerSocketPath,
} from '../../src/index.js';

describe('Code authoring boundary', () => {
  it('validates Python source bounds without executing or using the JavaScript parser', () => {
    expect(inspectCodeSource('while True: pass', 'python')).toBeUndefined();
    expect(inspectCodeSource('', 'python')?.message).toContain('Python');
    expect(inspectCodeSource('é'.repeat(65536), 'python')?.message).toContain(
      '64 KB',
    );
    expect(
      parseCodeSettings({ CODE_RUNNER_PYTHON_PACKAGES: '["acme.transforms"]' })
        .pythonPackages,
    ).toEqual(['acme.transforms']);
    expect(() =>
      parseCodeSettings({ CODE_RUNNER_PYTHON_PACKAGES: '["../secret"]' }),
    ).toThrow();
  });
  it('accepts async bodies without evaluating them', () => {
    expect(
      inspectCodeSource(
        'await Promise.resolve(); while(true) {} return input;',
      ),
    ).toBeUndefined();
    expect(
      inspectCodeSource('return $vars.RATE * input.amount;'),
    ).toBeUndefined();
  });
  it('reports user line and column and refuses an escaped body', () => {
    expect(inspectCodeSource('const a = 1;\nreturn (;')).toMatchObject({
      line: 2,
      column: 9,
    });
    expect(
      inspectCodeSource('}\nwhile(true) {}\nfunction extra(){'),
    ).toBeDefined();
    expect(inspectCodeSource('')).toBeDefined();
  });
  it('enforces UTF-8 source bytes', () => {
    const issue = inspectCodeSource(
      "return '" + 'é'.repeat(CODE_LIMITS.sourceBytes / 2) + "';",
    );
    expect(issue?.message).toContain('64 KB');
  });
  it('parses one settings contract and rejects invalid administrator values', () => {
    expect(parseCodeSettings({})).toEqual(DEFAULT_CODE_SETTINGS);
    expect(
      parseCodeSettings({
        CODE_STEPS_ENABLED: 'false',
        CODE_RUNNER_PACKAGES: '["@acme/transform"]',
      }),
    ).toMatchObject({ enabled: false, extraPackages: ['@acme/transform'] });
    for (const env of [
      { CODE_STEPS_ENABLED: 'yes' },
      { CODE_RUNNER_MEMORY_MB: '1' },
      { CODE_RUNNER_CONCURRENCY: '17' },
      { CODE_RUNNER_PACKAGES: '["../secret"]' },
    ])
      expect(() => parseCodeSettings(env)).toThrow();
  });
  it('uses a private absolute socket path with a Unix path length bound', () => {
    expect(
      codeRunnerSocketPath({ configured: undefined, hardened: true, uid: 1 }),
    ).toBe('/run/pertexo-code/runner.sock');
    expect(
      codeRunnerSocketPath({
        configured: undefined,
        hardened: false,
        uid: 501,
      }),
    ).toBe('/tmp/pertexo-code-501/runner.sock');
    expect(() =>
      codeRunnerSocketPath({
        configured: 'relative',
        hardened: false,
        uid: 501,
      }),
    ).toThrow();
    expect(() =>
      codeRunnerSocketPath({
        configured: '/' + 'x'.repeat(101),
        hardened: false,
        uid: 501,
      }),
    ).toThrow();
  });
});
