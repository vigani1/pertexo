import { describe, expect, it } from 'vitest';
import { browserTabId } from '@/features/workflow-collaboration/model/presence';

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('the identity a tab reports presence under', () => {
  it('survives a reload, so the tab is not counted as another tab', () => {
    const storage = memory();
    expect(browserTabId(storage)).toBe(browserTabId(storage));
  });

  it('differs between tabs', () => {
    expect(browserTabId(memory())).not.toBe(browserTabId(memory()));
  });

  it('still answers when storage is refused', () => {
    const refused = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(browserTabId(refused)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
