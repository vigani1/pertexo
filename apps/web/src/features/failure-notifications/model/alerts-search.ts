/** The Alerts page's URL state: the destination a link asked to open. */
export type AlertsSearch = Readonly<{ destination?: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseAlertsSearch(
  search: Readonly<Record<string, unknown>>,
): AlertsSearch {
  const { destination } = search;
  return typeof destination === 'string' && UUID.test(destination)
    ? { destination }
    : {};
}
