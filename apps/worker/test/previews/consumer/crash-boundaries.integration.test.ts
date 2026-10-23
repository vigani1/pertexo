import { describeIntegration } from './crash-boundaries/fixture.js';
import { registerPreservesFourPreviewDispatchAcknowledgementCrash } from './crash-boundaries/preserves-four-preview-dispatch-acknowledgement-crash.cases.js';
describeIntegration('preview dispatch crash boundaries', () => {
  registerPreservesFourPreviewDispatchAcknowledgementCrash();
});
