// The identities served before integration modules were introduced.
const definitions = new Set([
  'core.approval@1',
  'core.batch@1',
  'core.call@1',
  'core.code@1',
  'core.concat@1',
  'core.condition@1',
  'core.create_file@1',
  'core.crypto@1',
  'core.date@1',
  'core.filter@1',
  'core.foreach@1',
  'core.form@1',
  'core.hmac@1',
  'core.html@1',
  'core.manual@1',
  'core.merge@1',
  'core.number@1',
  'core.parallel@1',
  'core.read_file@1',
  'core.request_input@1',
  'core.respond_webhook@1',
  'core.run_values@1',
  'core.schedule@1',
  'core.set@1',
  'core.sort@1',
  'core.summarize@1',
  'core.switch@1',
  'core.table_delete@1',
  'core.table_find@1',
  'core.table_insert@1',
  'core.table_update@1',
  'core.table_upsert@1',
  'core.take@1',
  'core.terminate@1',
  'core.text@1',
  'core.unique@1',
  'core.validate@1',
  'core.wait@1',
  'core.webhook@1',
  'core.workflow_error@1',
  'core.xml@1',
  'database.execute@1',
  'database.poll@1',
  'email.send_notification@1',
  'http.poll@1',
  'http.request@1',
  'slack.send_message@1',
]);
const policies = new Set([
  'email.send_notification@1',
  'http.network@1',
  'http.response.value@1',
  'jsonata.restricted@1',
  'node.json.bounded@1',
  'slack.send_message@1',
]);

type Identity = Readonly<{ key: string; version: number }>;

function identityKey({ key, version }: Identity) {
  return `${key}@${String(version)}`;
}

export function isLegacyDefinition(identity: Identity) {
  return definitions.has(identityKey(identity));
}

export function isLegacyPolicy(identity: Identity) {
  return policies.has(identityKey(identity));
}
