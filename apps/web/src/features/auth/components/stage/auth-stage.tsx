import { useRef, type ReactNode } from 'react';
import { CoreOrb } from '@/components/patterns/core-orb';
import { StatusGlyph } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { ConvergingThreads } from './converging-threads';
import { Wordmark } from './wordmark';

type StageLayout = 'docked' | 'centered';

// Below 900px the Core is a 180px band above the lens and the threads turn
// off. Above it, `docked` sets the Core in the stage beside the lens: its
// size is capped by the height so it ends above the product facts, and by
// the width left of the lens so the two never collide. `centered` keeps the
// Core as a band above the lens at every size, so the glass never sits on
// its face. The stage stops growing at 120rem, so a very wide screen keeps
// the lens near the Core instead of a screen's width away.
const CORE_SLOT: Record<StageLayout, string> = {
  docked:
    'min-[900px]:absolute min-[900px]:top-[40%] min-[900px]:left-[34%] min-[900px]:mx-0 min-[900px]:size-[min(66vmin,calc(120dvh-27rem),calc(132vw-57.5rem))] min-[900px]:-translate-x-1/2 min-[900px]:-translate-y-1/2',
  centered: 'min-[900px]:mt-[max(3rem,calc(28dvh-7rem))] min-[900px]:size-52',
};

// The lens's top edge is pinned, so a message appearing or clearing grows
// it downward instead of moving it.
const MAIN_LAYOUT: Record<StageLayout, string> = {
  docked:
    'min-[900px]:min-h-dvh min-[900px]:justify-end min-[900px]:pt-[max(4rem,calc(50dvh-13rem))] min-[900px]:pr-14',
  centered: 'min-[900px]:pt-2',
};

const FACTS = [
  {
    tone: 'success',
    text: 'Runs pick up where they stopped after crashes and deploys',
  },
  {
    tone: 'live',
    text: 'Every publish is an immutable version you can go back to',
  },
  {
    tone: 'waiting',
    text: 'Waits of up to 30 days, and retries that don’t repeat side effects',
  },
] as const;

function ProductFacts() {
  // On a short wide screen the lens needs the height; the facts step aside
  // rather than sit half under the fold.
  return (
    <aside
      aria-label="About Pertexo"
      className="relative z-10 mx-auto w-full max-w-[27.25rem] px-4 pt-4 pb-12 min-[900px]:absolute min-[900px]:bottom-11 min-[900px]:left-11 min-[900px]:mx-0 min-[900px]:w-auto min-[900px]:max-w-[min(35rem,calc(100vw-34.5rem))] min-[900px]:p-0 min-[900px]:[@media(max-height:40.625rem)]:hidden"
    >
      <p className="font-display text-[clamp(2.25rem,4.4vw,3.625rem)] leading-[0.92] text-balance [--display-optical-size:96] [--display-width:74%]">
        Workflows that <span className="text-action">finish</span> what they
        start.
      </p>
      <ul className="mt-5 grid gap-2.5 font-mono text-[0.78rem] leading-snug text-muted-foreground">
        {FACTS.map((fact) => (
          <li key={fact.text} className="flex items-start gap-2.5 text-pretty">
            <StatusGlyph
              tone={fact.tone}
              className={cn(
                'mt-px',
                fact.tone === 'success' && 'text-success',
                fact.tone === 'live' && 'text-action',
                fact.tone === 'waiting' && 'text-secondary',
              )}
            />
            {fact.text}
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * The full-bleed stage shared by sign in, sign up, recovery, migration and
 * invitations: the Core with threads converging into it, the wordmark and a
 * glass lens holding the page's one job. `docked` puts the lens on the right
 * with the product facts; `centered` floats it over the Core.
 */
export function AuthStage({
  layout = 'docked',
  children,
}: Readonly<{ layout?: StageLayout; children: ReactNode }>) {
  const coreRef = useRef<HTMLDivElement>(null);
  return (
    // flow-root keeps the centred Core's top margin inside the stage, so it
    // doesn't carry the stage (and the wordmark pinned to it) down with it.
    <div className="relative isolate mx-auto flow-root min-h-dvh max-w-[120rem] overflow-x-clip bg-background">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10"
      >
        <div className="ambient" />
        <ConvergingThreads
          coreRef={coreRef}
          className="absolute inset-0 size-full max-[899px]:hidden"
        />
      </div>
      <header className="relative z-10 px-6 pt-6 min-[900px]:absolute min-[900px]:top-9 min-[900px]:left-11 min-[900px]:p-0">
        <Wordmark />
      </header>
      <div
        ref={coreRef}
        aria-hidden="true"
        className={cn(
          'pointer-events-none relative mx-auto size-[11.25rem]',
          CORE_SLOT[layout],
        )}
      >
        <CoreOrb state="idle" className="size-full" />
      </div>
      <main
        id="main"
        className={cn(
          'relative z-10 flex items-start justify-center px-4 pb-10 min-[900px]:pb-16',
          MAIN_LAYOUT[layout],
        )}
      >
        {children}
      </main>
      {layout === 'docked' ? <ProductFacts /> : null}
    </div>
  );
}
