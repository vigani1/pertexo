import type { CSSProperties } from 'react';

export function NoticeTimer({
  timeout,
  appearance = 'ring',
}: Readonly<{ timeout: number; appearance?: 'ring' | 'thread' }>) {
  if (timeout <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={
        appearance === 'thread' ? 'notice-thread-timer' : 'notice-timer'
      }
      style={{ '--notice-timeout': `${String(timeout)}ms` } as CSSProperties}
    />
  );
}
