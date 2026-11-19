import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { pageName } from './page-title';

/**
 * Says which page a navigation opened. A single-page app loads no new page,
 * so a screen reader stays silent unless the app speaks; it says the title
 * the route set, without the product name. The first page isn't said: the
 * browser's own load already reads its title.
 */
export function RouteAnnouncer() {
  const pathname = useRouterState({
    select: (state) => state.resolvedLocation?.pathname,
  });
  const [announcement, setAnnouncement] = useState('');
  const lastPathname = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pathname === undefined) return;
    const previous = lastPathname.current;
    lastPathname.current = pathname;
    if (previous === undefined || previous === pathname) return;
    // The route's head sets the title as this commit lands; read it once drawn.
    const frame = requestAnimationFrame(() => {
      setAnnouncement(pageName(document.title));
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [pathname]);
  return (
    <p aria-live="assertive" aria-atomic="true" className="sr-only">
      {announcement}
    </p>
  );
}
