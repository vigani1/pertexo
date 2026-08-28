-- Bind an OIDC authorization transaction to the browser that started it.
-- Existing transactions cannot acquire the missing raw secret, so invalidate
-- them during rollout and give them an unmatchable fixed-width digest.

ALTER TABLE app.oidc_login_transactions
  ADD COLUMN browser_binding_digest char(64);

UPDATE app.oidc_login_transactions
SET browser_binding_digest = repeat('0', 64),
    consumed_at = COALESCE(consumed_at, clock_timestamp());

ALTER TABLE app.oidc_login_transactions
  ALTER COLUMN browser_binding_digest SET NOT NULL,
  ADD CONSTRAINT oidc_login_transactions_browser_binding_digest_format
    CHECK (browser_binding_digest ~ '^[0-9a-f]{64}$');
