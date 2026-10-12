#!/usr/bin/env bash
# TravelSplit restore (R4) into an EMPTY, isolated Supabase project whose migrations are already applied.
#
# Usage: restore.sh <archive.tar.age> <age identity file>
# Required environment (operator shell only):
#   RESTORE_DB_URL, RESTORE_SUPABASE_URL, RESTORE_SECRET_KEY   the TARGET project
#   RESTORE_CONFIRM_HOST   must equal the host of RESTORE_SUPABASE_URL (guards against restoring into the wrong project)
# Optional: PSQL (default psql)
set -euo pipefail

ARCHIVE=${1:?archive missing}
IDENTITY=${2:?age identity file missing}
: "${RESTORE_DB_URL:?missing}" "${RESTORE_SUPABASE_URL:?missing}" "${RESTORE_SECRET_KEY:?missing}" "${RESTORE_CONFIRM_HOST:?missing}"
PSQL=${PSQL:-psql}
HERE=$(cd "$(dirname "$0")" && pwd)

target_host=$(node -e 'console.log(new URL(process.argv[1]).host)' "$RESTORE_SUPABASE_URL")
if [[ "$target_host" != "$RESTORE_CONFIRM_HOST" ]]; then
  echo "RESTORE_CONFIRM_HOST ($RESTORE_CONFIRM_HOST) does not match target $target_host" >&2
  exit 1
fi

if [[ -f "$ARCHIVE.sha256" ]]; then sha256sum -c "$ARCHIVE.sha256"; fi

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
age -d -i "$IDENTITY" "$ARCHIVE" | tar -C "$WORK" -xf -

echo "Verifying archive contents ..."
node "$HERE/manifest.mjs" verify-files "$WORK"

echo "Checking target ..."
existing=$($PSQL "$RESTORE_DB_URL" -Atc "select (select count(*) from public.trips) + (select count(*) from auth.users)")
if [[ "$existing" != "0" ]]; then
  echo "Target is not empty ($existing trips/users). Restore only into a fresh project." >&2
  exit 1
fi
$PSQL "$RESTORE_DB_URL" -Atc "select version from supabase_migrations.schema_migrations order by version" > "$WORK/target-migrations.txt"
node "$HERE/manifest.mjs" check-migrations "$WORK" "$WORK/target-migrations.txt"

echo "Loading data in one transaction ..."
# Migrations seed singleton rows (e.g. private.whatsapp_config); the backup carries their real values.
{ echo "delete from private.whatsapp_config;"; cat "$WORK/db/data.sql"; } |
  $PSQL "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -q -f - > /dev/null

echo "Uploading storage ..."
node "$HERE/storage.mjs" import "$WORK/storage"

echo "Verifying row counts and receipts ..."
node "$HERE/manifest.mjs" verify-db "$WORK"
echo "Restore complete."
