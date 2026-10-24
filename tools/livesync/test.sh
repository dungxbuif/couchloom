#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNNER="$SCRIPT_DIR/livesync.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/couchloom-livesync-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT

assert_contains() {
    haystack=$1
    needle=$2
    printf '%s\n' "$haystack" | grep -F -- "$needle" >/dev/null
}

output=$(
    LIVESYNC_DRY_RUN=1 \
    LIVESYNC_IMAGE=test-image:1 \
    LIVESYNC_VAULT_DIR="$TEST_ROOT/vault" \
    LIVESYNC_DB_DIR="$TEST_ROOT/db" \
    LIVESYNC_SETTINGS_PATH="$TEST_ROOT/db/settings.json" \
    LIVESYNC_COUCHDB_URL=https://couch.example.test \
    LIVESYNC_COUCHDB_USER=sync-user \
    LIVESYNC_COUCHDB_PASSWORD=super-secret \
    LIVESYNC_COUCHDB_DATABASE=notes \
    "$RUNNER" sync
)

assert_contains "$output" "test-image:1"
assert_contains "$output" "/vault"
assert_contains "$output" "--write-settings"
if printf '%s\n' "$output" | grep -F -- "super-secret" >/dev/null; then
    printf '%s\n' "runner leaked the CouchDB password" >&2
    exit 1
fi

test "$(jq -r '.couchDB_URI' "$TEST_ROOT/db/settings.json")" = "https://couch.example.test"
test "$(jq -r '.couchDB_DBNAME' "$TEST_ROOT/db/settings.json")" = "notes"
test "$(jq -r '.isConfigured' "$TEST_ROOT/db/settings.json")" = "true"
test "$(stat -f '%Lp' "$TEST_ROOT/db/settings.json")" = "600"

jq '.remoteConfigurations = {"keep-me": {"uri": "sls+https://example.test/notes"}} | .activeConfigurationId = "keep-me"' \
    "$TEST_ROOT/db/settings.json" > "$TEST_ROOT/db/settings.next"
mv "$TEST_ROOT/db/settings.next" "$TEST_ROOT/db/settings.json"
LIVESYNC_DRY_RUN=1 \
LIVESYNC_IMAGE=test-image:1 \
LIVESYNC_VAULT_DIR="$TEST_ROOT/vault" \
LIVESYNC_DB_DIR="$TEST_ROOT/db" \
LIVESYNC_SETTINGS_PATH="$TEST_ROOT/db/settings.json" \
LIVESYNC_COUCHDB_URL=https://couch.example.test \
LIVESYNC_COUCHDB_USER=sync-user \
LIVESYNC_COUCHDB_PASSWORD=super-secret \
LIVESYNC_COUCHDB_DATABASE=notes \
"$RUNNER" sync >/dev/null
test "$(jq -r '.remoteConfigurations["keep-me"].uri' "$TEST_ROOT/db/settings.json")" = "sls+https://example.test/notes"

if LIVESYNC_DRY_RUN=1 \
    LIVESYNC_VAULT_DIR="$TEST_ROOT/vault" \
    LIVESYNC_DB_DIR="$TEST_ROOT/missing-db" \
    LIVESYNC_SETTINGS_PATH="$TEST_ROOT/missing-db/settings.json" \
    LIVESYNC_COUCHDB_URL=https://couch.example.test \
    LIVESYNC_COUCHDB_USER=sync-user \
    LIVESYNC_COUCHDB_DATABASE=notes \
    LIVESYNC_VARS_FILE="$TEST_ROOT/missing-vars.json" \
    "$RUNNER" sync >/dev/null 2>&1; then
    printf '%s\n' "runner accepted missing CouchDB password" >&2
    exit 1
fi

printf '%s\n' "livesync runner smoke test: PASS"
