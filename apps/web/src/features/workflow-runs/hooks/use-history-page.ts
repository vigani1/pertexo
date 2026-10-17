import { useState } from 'react';

const PAGE_SIZE = 50;

/** Keep navigation local while a newly selected step opens its own page. */
export function useHistoryPage<T>(
  items: readonly T[],
  selectedKey?: string,
  selectedIndex = -1,
) {
  const selectedPage = Math.max(0, Math.floor(selectedIndex / PAGE_SIZE));
  const [navigation, setNavigation] = useState({
    selectedKey,
    page: selectedPage,
  });
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(
    pages - 1,
    navigation.selectedKey === selectedKey ? navigation.page : selectedPage,
  );
  const start = page * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    start,
    end: Math.min(start + PAGE_SIZE, items.length),
    total: items.length,
    page,
    pages,
    onPage: (next: number) => {
      setNavigation({
        selectedKey,
        page: Math.max(0, Math.min(next, pages - 1)),
      });
    },
  };
}
