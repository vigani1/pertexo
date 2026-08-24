ALTER TABLE app.connections
  DROP CONSTRAINT connections_auth_type_valid,
  ADD CONSTRAINT connections_auth_type_valid
    CHECK (auth_type IN ('http_headers', 'slack_bot_token'));
