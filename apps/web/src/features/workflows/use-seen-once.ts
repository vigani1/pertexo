import { useEffect, useState } from 'react';

/**
 * Becomes true once the element has come near the viewport and stays true,
 * so rows read their shape only when someone could actually see it.
 * Without IntersectionObserver every element counts as seen.
 */
export function useSeenOnce<Target extends Element>() {
  const [element, setElement] = useState<Target | null>(null);
  const [seen, setSeen] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    if (seen || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element, seen]);
  return [setElement, seen] as const;
}
