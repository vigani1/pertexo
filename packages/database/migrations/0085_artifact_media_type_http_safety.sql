-- Artifact media types are reflected into signed-upload Content-Type headers.
-- Retain the established loose media-type grammar while constraining every
-- character to the field-value bytes accepted by the Node HTTP boundary.
-- NOT VALID enforces the invariant for concurrent writes before the existing
-- inventory is scanned; validation fails closed if a historical row is unsafe.
ALTER TABLE app.artifacts
  DROP CONSTRAINT artifacts_media_type_format;

ALTER TABLE app.artifacts
  ADD CONSTRAINT artifacts_media_type_format
  CHECK (
    length(media_type) BETWEEN 3 AND 255
    AND media_type ~ '^[^[:space:]/;]+/[^\r\n]+$'
    AND media_type !~ U&'[^\0009\0020-\007e\0080-\00ff]'
  ) NOT VALID;

ALTER TABLE app.artifacts
  VALIDATE CONSTRAINT artifacts_media_type_format;
