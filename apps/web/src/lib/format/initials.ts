/** Up to two initials from a display name, falling back to a single letter. */
export function formatInitials(name: string, fallback = 'P'): string {
  const initials = name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('');
  return (initials === '' ? fallback.charAt(0) || 'P' : initials).toUpperCase();
}
