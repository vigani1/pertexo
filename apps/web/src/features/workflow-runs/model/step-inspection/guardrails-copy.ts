import type { GuardrailsReason } from '@pertexo/node-sdk';

/** What each Guardrails finding category is called in the run inspector. */
export const GUARDRAILS_REASON_LABELS: Readonly<
  Record<GuardrailsReason, string>
> = {
  'pii.email': 'Email address',
  'pii.phone': 'Phone number',
  'pii.payment_card': 'Payment card number',
  'pii.iban': 'Bank account number (IBAN)',
  'pii.national_id': 'National ID number',
  'terms.prohibited': 'Prohibited term',
  'model.clear': 'Model approved the text',
  'model.injection': 'Model flagged prompt injection',
  'model.policy': 'Model flagged a policy violation',
  'injection.marker': 'Prompt injection marker',
};

// The labels record names every reason exactly once, so its keys are the reasons.
export const GUARDRAILS_REASONS = Object.keys(
  GUARDRAILS_REASON_LABELS,
) as readonly GuardrailsReason[];
