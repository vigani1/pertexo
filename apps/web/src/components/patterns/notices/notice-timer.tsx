import type { CSSProperties } from 'react';

export function NoticeTimer({ timeout }: Readonly<{ timeout: number }>) {
  if (timeout <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="notice-timer"
      style={{ '--notice-timeout': `${String(timeout)}ms` } as CSSProperties}
    />
  );
}
