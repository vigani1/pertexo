/**
 * Sign in beside an open page, leaving this tab and its in-memory edits
 * intact. `className` replaces the inline-link look, e.g. with a button's.
 */
export function SignInAction({
  className = 'focus-ring rounded-sm underline hover:text-foreground',
  returnTo = window.location.pathname + window.location.search,
}: Readonly<{ className?: string; returnTo?: string }> = {}) {
  return (
    <a
      className={className}
      href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      Sign in again<span className="sr-only"> (opens a new tab)</span>
    </a>
  );
}
