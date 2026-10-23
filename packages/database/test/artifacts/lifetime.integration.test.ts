import { describe } from 'vitest';

import { shapes } from './lifetime/fixture.js';
import { registerArtifactOwnerRetention } from './lifetime/owner-retention.cases.js';
import { registerKeepsPreviewOutputReadableLive } from './lifetime/keeps-preview-output-readable-live.cases.js';
describe.each(shapes)('artifact lifetime and cleanup (%s)', (shape) => {
  registerArtifactOwnerRetention(shape);

  registerKeepsPreviewOutputReadableLive(shape);
});
