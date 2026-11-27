import type { ReactNode } from 'react';

/**
 * List and detail for stepping through many items: side by side from about
 * 900 px, below that the detail alone, which carries its own back link.
 */
export function ListDetail({
  list,
  detail,
}: Readonly<{ list: ReactNode; detail: ReactNode }>) {
  return (
    <div className="grid min-w-0 gap-8 min-[900px]:grid-cols-[minmax(16rem,1fr)_minmax(0,1.65fr)] xl:gap-12">
      <aside className="hidden min-w-0 min-[900px]:block">{list}</aside>
      <div className="min-w-0">{detail}</div>
    </div>
  );
}
