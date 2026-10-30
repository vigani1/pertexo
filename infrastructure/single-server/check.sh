#!/usr/bin/env bash
# The server's look at itself, run by systemd/check.timer. It can't report that the
# whole server is down, which is what an outside uptime monitor is for.
set -Eeuo pipefail
[[ $# == 0 ]] || { echo 'usage: check.sh' >&2; exit 64; }
source "$(dirname "$0")/common.sh"
[[ -f "$BETA_STATE_DIR/current" ]] || { echo 'No release is installed yet'; exit 0; }
# A deploy or backup stops the app on purpose. Holding the lock here would make a
# real one fail, so this only looks, and looks again before reporting.
operation_running() { ! ( exec 9>"$BETA_STATE_DIR/operation.lock"; flock -n 9 ); }
if operation_running; then echo 'An operation is running; nothing to check'; exit 0; fi
select_release "$(cat "$BETA_STATE_DIR/current")"

webhook=$(config_value ALERT_WEBHOOK_URL)
disk_limit=$(config_value ALERT_DISK_PERCENT)
backup_limit=$(config_value ALERT_BACKUP_MAX_AGE_HOURS)
stuck_limit=$(config_value ALERT_STUCK_MINUTES)
alerts="$BETA_STATE_DIR/alerts"
mkdir -p "$alerts"
problems=0

# An empty message means this problem is over. Once when it starts and every six
# hours while it lasts: a channel that repeats itself every five minutes gets muted.
report() {
  local name=$1 message=$2
  if [[ -z $message ]]; then rm -f "$alerts/$name"; return; fi
  problems=1
  printf '%s\n' "$message" >&2
  [[ -n $webhook && -z $(find "$alerts/$name" -mmin -360 2>/dev/null) ]] || return 0
  # The messages hold only fixed text and numbers, so they need no JSON escaping.
  # Slack and Mattermost read "text"; Discord reads "content".
  if curl --fail --silent --show-error --max-time 10 --output /dev/null \
    --header 'content-type: application/json' \
    --data "{\"text\":\"Pertexo on $(hostname): $message\",\"content\":\"Pertexo on $(hostname): $message\"}" "$webhook"; then
    : > "$alerts/$name"
  else
    echo 'The alert could not be sent' >&2
  fi
}

disk_message() {
  local path used fullest=0
  for path in "$beta_root" "$(docker info --format '{{.DockerRootDir}}')"; do
    used=$(df -P "$path" 2>/dev/null | awk 'NR == 2 { print $5 + 0 }') || continue
    if [[ -n $used && $used -gt $fullest ]]; then fullest=$used; fi
  done
  if ((fullest >= ${disk_limit:-90})); then echo "the disk is $fullest% full"; fi
}

backup_message() {
  local marker="$BETA_STATE_DIR/last-backup" hours
  if [[ ! -f $marker ]]; then echo 'no backup has completed yet'; return; fi
  hours=$((($(date +%s) - $(stat -c %Y "$marker")) / 3600))
  if ((hours >= ${backup_limit:-30})); then echo "the last completed backup is $hours hours old"; fi
}

services_message() {
  local running service down=''
  running=$(compose ps --services --status running)
  for service in "${runtime_services[@]}"; do
    grep -qx "$service" <<< "$running" || down+=" $service"
  done
  if [[ -n $down ]]; then echo "these services are not running:$down"; fi
}

# Only reports on an API that's running: services_message already covers a stopped one.
readiness_message() {
  compose exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready', { signal: AbortSignal.timeout(10000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null \
    || echo 'the API is not ready: a dependency is down or the database refuses writes'
}

app_message() {
  wait_for_app 5 2>/dev/null || echo 'the app cannot reach the API through the proxy'
}

# Waiting runs have their own timers. A queued or running one that hasn't changed for
# this long is work nobody is picking up.
stuck_message() {
  local count
  count=$(compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql --no-password --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<SQL
SELECT count(*) FROM app.workflow_runs
WHERE status IN ('queued', 'running') AND updated_at <= now() - make_interval(mins => ${stuck_limit:-30});
SQL
  ) || { echo 'the database could not be asked about stuck runs'; return; }
  if ((count > 0)); then echo "$count runs look stuck: queued or running, with no change for ${stuck_limit:-30} minutes or more"; fi
}

names=(disk backup services stuck)
messages=("$(disk_message)" "$(backup_message)" "$(services_message)" "$(stuck_message)")
if grep -qx api <<< "$(compose ps --services --status running)"; then
  names+=(ready app)
  messages+=("$(readiness_message)" "$(app_message)")
fi
if operation_running; then echo 'An operation started; ignoring this check'; exit 0; fi
for index in "${!names[@]}"; do
  report "${names[index]}" "${messages[index]}"
done
if ((problems == 0)); then echo 'All checks passed'; fi
exit "$problems"
