import { EllipsisIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

type Crumb = Readonly<{ key: string; label: ReactNode }>;

function Separator() {
  return (
    <span aria-hidden="true" className="opacity-40">
      /
    </span>
  );
}

/**
 * The shell's breadcrumb: the workspace switcher, then each step down to the
 * page. On narrow screens the steps between them fold into "…", which opens
 * them in a small lens, so the page's own crumb always stays readable.
 */
export function ShellBreadcrumb({
  root,
  crumbs,
}: Readonly<{
  /** The workspace switcher the trail starts from. */
  root: ReactNode;
  /** Steps after the workspace, outermost first; the last is the page. */
  crumbs: readonly Crumb[];
}>) {
  const middle = crumbs.slice(0, -1);
  const page = crumbs.at(-1);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-2 text-[0.8rem] text-subtle-foreground">
        <li className="min-w-0">{root}</li>
        {middle.length === 0 ? null : (
          <li className="flex shrink-0 items-center gap-2 sm:hidden">
            <Separator />
            <FoldedCrumbs crumbs={middle} />
          </li>
        )}
        {middle.map((crumb) => (
          <li
            key={crumb.key}
            className="hidden min-w-0 items-center gap-2 sm:flex"
          >
            <Separator />
            <span className="truncate">{crumb.label}</span>
          </li>
        ))}
        {page === undefined ? null : (
          <li
            aria-current="page"
            className="flex max-w-[60%] min-w-0 shrink-0 items-center gap-2 sm:max-w-none sm:shrink"
          >
            <Separator />
            <span className="truncate">{page.label}</span>
          </li>
        )}
      </ol>
    </nav>
  );
}

/** "…": the steps between the workspace and the page, one press away. */
function FoldedCrumbs({ crumbs }: Readonly<{ crumbs: readonly Crumb[] }>) {
  const [open, setOpen] = useState(false);
  const count = crumbs.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Show ${String(count)} more ${count === 1 ? 'step' : 'steps'} of the path`}
        className="grid size-7 place-items-center rounded-md outline-none hover:bg-white/5 hover:text-foreground focus-ring"
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[min(18rem,calc(100vw-2rem))] p-2">
        <PopoverTitle className="sr-only">The path to this page</PopoverTitle>
        {/* A crumb that leads somewhere closes the lens as it goes. */}
        <ol
          className="flex flex-col text-sm text-muted-foreground [&_a]:-mx-2 [&_a]:-my-1.5 [&_a]:block [&_a]:px-2 [&_a]:py-1.5 [&_a]:text-foreground"
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('a') !== null
            )
              setOpen(false);
          }}
        >
          {crumbs.map((crumb) => (
            <li
              key={crumb.key}
              className="truncate rounded-sm px-2 py-1.5 has-[a:hover]:bg-white/5"
            >
              {crumb.label}
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}
