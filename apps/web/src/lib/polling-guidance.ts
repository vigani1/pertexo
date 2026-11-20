import { POLL_MAX_ITEMS, POLL_MAX_SEEN_KEYS } from '@pertexo/contracts';
import { formatCount } from './format/count';

export const pollingGuidance = {
  baseline:
    'The first successful check after publishing records the items it sees and starts no runs.',
  keys: 'Choose a unique, stable key for each item.',
  retention: `The trigger remembers the last ${formatCount(POLL_MAX_SEEN_KEYS, 'item')} it recorded.`,
  interval: `Check often enough to keep new items near the front of the feed. Each check reads up to ${formatCount(POLL_MAX_ITEMS, 'item')} and can stop at an already-seen page.`,
};

export const databasePollingGuidance = {
  baseline:
    'The first successful check after publishing records the rows it sees and starts no runs.',
  keys: 'Choose a stable, non-null key column with a unique index. To watch for updates, choose an ordering column that advances on each update.',
  retention: `The trigger remembers the last ${formatCount(POLL_MAX_SEEN_KEYS, 'row or revision')} it recorded.`,
  interval: `Each check reads up to ${formatCount(POLL_MAX_ITEMS, 'row')}. Check often enough to keep new rows and updates within that set. Multiple updates between checks may appear as one.`,
};
