/**
 * The default clock for time decisions that take an injected `now`. It reads
 * `Date.now` on every call rather than capturing it, so a replaced `Date.now`
 * (a test moving time forward) is seen by a hook that rendered before the
 * replacement, as the direct `Date.now()` calls it stands in for were. One
 * stable function also keeps hook effects that depend on the clock from
 * restarting on every render.
 */
export function readWallClock(): number {
  return Date.now();
}
