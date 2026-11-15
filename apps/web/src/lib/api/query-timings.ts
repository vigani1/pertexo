// How long the browser trusts a server snapshot, how long it keeps one nobody
// shows, and how often a screen asks again. One owner, so screens showing the
// same kind of data refresh alike; test/lib/query-timings.test.ts refuses a
// number written into a query's options instead.

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

/** `staleTime`: how long a cached snapshot counts as fresh. */
export const QUERY_FRESHNESS = Object.freeze({
  /** Read again on every use: the snapshot guards a write or a decision. */
  none: 0,
  /** Something people watch change: a running task or a live discussion. */
  live: 5 * SECOND_MS,
  /** What people are working in: rows, drafts, settings, discussions. */
  working: 10 * SECOND_MS,
  /** Personal and current state: the inbox, account security, usage now. */
  recent: 15 * SECOND_MS,
  /** An ordinary snapshot; the app-wide default. */
  standard: 30 * SECOND_MS,
  /** History and summaries that change slowly. */
  settled: MINUTE_MS,
  /** The catalog, templates and discovery: they change with a deployment. */
  catalog: 5 * MINUTE_MS,
  /** A snapshot that never changes once read: a stored value, a version. */
  immutable: Number.POSITIVE_INFINITY,
});

/** `gcTime`: how long a snapshot no screen shows stays cached. */
export const QUERY_RETENTION = Object.freeze({
  /** Dropped once unused: drafts, capabilities and other sensitive reads. */
  none: 0,
  /** The signed-in session, kept across a brief remount. */
  session: 5 * MINUTE_MS,
  /** A long-lived reference list, such as workflow names for pickers. */
  extended: 30 * MINUTE_MS,
});

/** `refetchInterval`: how often an open screen asks again. */
export const QUERY_POLLING = Object.freeze({
  /** While a test case or a test suite runs. */
  inFlight: SECOND_MS,
  /** While a run, a call or a listener waits on something it started. */
  waiting: 2 * SECOND_MS,
  /** While an activation or a deletion settles. */
  settling: 5 * SECOND_MS,
  /** While a pending task waits on a person. */
  pendingTask: 15 * SECOND_MS,
  /** Health, counts and statistics on an open screen. */
  status: 30 * SECOND_MS,
  /** Slower summaries, such as Home's Loom. */
  dashboard: MINUTE_MS,
  /** The inbox, beside its live stream. */
  inbox: 2 * MINUTE_MS,
  /** Usage trends, which move by the day. */
  trends: 5 * MINUTE_MS,
});

/** `retry`: how many times a failed read is asked again before it shows. */
export const QUERY_RETRIES = Object.freeze({
  /** One more try for a read the whole app waits on (the session). */
  once: 1,
});
