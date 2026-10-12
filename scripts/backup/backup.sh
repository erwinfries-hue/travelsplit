#!/usr/bin/env bash
# TravelSplit operator backup (R4). Runs on the operator's machine, never in CI or the browser.
#
# Produces ONE encrypted archive: travelsplit-backup-<UTC timestamp>.tar.age containing
#   db/data.sql        data-only dump of public, private, auth.users, auth.identities
#   db/schema.sql      schema-only dump of public and private (for review; restore uses the migrations)
#   storage/receipts/  every object in the private receipts bucket
#   manifest.json      migration versions, row counts and SHA-256 of every file
#
# Required environment (operator shell only, never committed):
#   SUPABASE_DB_URL        postgres connection string of the project (session pooler or direct)
#   SUPABASE_URL           https://<ref>.supabase.co
#   SUPABASE_SECRET_KEY    service-role/secret key, only for reading the private bucket
#   BACKUP_AGE_RECIPIENT   age public key (age1...) of the operator; the private key stays offline
# Optional:
#   BACKUP_OUT_DIR         target directory (default ./backups)
#   PG_DUMP                pg_dump command matching the server major version (default pg_dump)
set -euo pipefail

: "${SUPABASE_DB_URL:?missing}" "${SUPABASE_URL:?missing}" "${SUPABASE_SECRET_KEY:?missing}" "${BACKUP_AGE_RECIPIENT:?missing}"
PG_DUMP=${PG_DUMP:-pg_dump}
OUT_DIR=${BACKUP_OUT_DIR:-./backups}
HERE=$(cd "$(dirname "$0")" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/db" "$WORK/storage" "$OUT_DIR"

echo "Dumping database data ..."
# shellcheck disable=SC2086
$PG_DUMP "$SUPABASE_DB_URL" --data-only --no-owner --no-privileges \
  -t 'public.*' -t 'private.*' -t auth.users -t auth.identities \
  > "$WORK/db/data.sql"
# shellcheck disable=SC2086
$PG_DUMP "$SUPABASE_DB_URL" --schema-only --no-owner -n public -n private > "$WORK/db/schema.sql"

echo "Exporting storage ..."
node "$HERE/storage.mjs" export "$WORK/storage"

echo "Writing manifest ..."
node "$HERE/manifest.mjs" write "$WORK" "$STAMP"

ARCHIVE="$OUT_DIR/travelsplit-backup-$STAMP.tar.age"
tar -C "$WORK" -cf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "Backup written: $ARCHIVE"
