/** Sign in beside an open draft, leaving this tab and its in-memory edits intact. */
export function SignInAction() {
  return (
    <a
      className="focus-ring rounded-sm underline hover:text-foreground"
      href={`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      Sign in again<span className="sr-only"> (opens a new tab)</span>
    </a>
  );
}
