import { describe } from 'vitest';

import { enabled } from './editor/fixture/environment.js';
import { createEditorBrowserFixture } from './editor/fixture/setup.js';
import { registerEditorBrowserJourney } from './editor/fixture/journey.js';

describe.skipIf(!enabled)('real browser, API and pure-node worker', () => {
  const fixture = createEditorBrowserFixture();
  registerEditorBrowserJourney(fixture);
});
