#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

LIVESYNC_IMAGE=${LIVESYNC_IMAGE:-livesync-cli:1.0.9-cli}
LIVESYNC_SOURCE_DIR=${LIVESYNC_SOURCE_DIR:-/Users/dungxbuif/workspace/projects/obsidian-livesync}
LIVESYNC_VAULT_DIR=${LIVESYNC_VAULT_DIR:-/Users/dungxbuif/workspace/vaults/secondbrain}
LIVESYNC_STATE_ROOT=${LIVESYNC_STATE_ROOT:-"${HOME}/Library/Application Support/CouchLoom/livesync"}
LIVESYNC_DB_DIR=${LIVESYNC_DB_DIR:-"$LIVESYNC_STATE_ROOT/obsidian-vault"}
LIVESYNC_SETTINGS_PATH=${LIVESYNC_SETTINGS_PATH:-"$LIVESYNC_DB_DIR/settings.json"}
LIVESYNC_VARS_FILE=${LIVESYNC_VARS_FILE:-/Users/dungxbuif/workspace/vaults/homelab/local_vars.json}

die() {
    printf 'livesync: %s\n' "$1" >&2
    exit 1
}

need_command() {
    command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

load_couchdb_config() {
    if [ -n "${LIVESYNC_COUCHDB_URL:-}" ] &&
        [ -n "${LIVESYNC_COUCHDB_USER:-}" ] &&
        [ -n "${LIVESYNC_COUCHDB_PASSWORD:-}" ] &&
        [ -n "${LIVESYNC_COUCHDB_DATABASE:-}" ]; then
        return
    fi

    [ -f "$LIVESYNC_VARS_FILE" ] || die "set LIVESYNC_COUCHDB_* or provide $LIVESYNC_VARS_FILE"
    LIVESYNC_COUCHDB_URL=${LIVESYNC_COUCHDB_URL:-$(jq -er '.COUCHDB_SECRETS.COUCHDB_URL' "$LIVESYNC_VARS_FILE")}
    LIVESYNC_COUCHDB_USER=${LIVESYNC_COUCHDB_USER:-$(jq -er '.COUCHDB_SECRETS.COUCHDB_SYNC_USER' "$LIVESYNC_VARS_FILE")}
    LIVESYNC_COUCHDB_PASSWORD=${LIVESYNC_COUCHDB_PASSWORD:-$(jq -er '.COUCHDB_SECRETS.COUCHDB_SYNC_PASSWORD' "$LIVESYNC_VARS_FILE")}
    LIVESYNC_COUCHDB_DATABASE=${LIVESYNC_COUCHDB_DATABASE:-$(jq -er '.COUCHDB_SECRETS.COUCHDB_DB_OBSIDIAN' "$LIVESYNC_VARS_FILE")}
}

write_settings() {
    load_couchdb_config
    mkdir -p "$(dirname "$LIVESYNC_SETTINGS_PATH")"
    old_umask=$(umask)
    umask 077
    temp_settings="$LIVESYNC_SETTINGS_PATH.tmp.$$"
    if [ -f "$LIVESYNC_SETTINGS_PATH" ]; then
        jq \
            --arg uri "$LIVESYNC_COUCHDB_URL" \
            --arg user "$LIVESYNC_COUCHDB_USER" \
            --arg password "$LIVESYNC_COUCHDB_PASSWORD" \
            --arg database "$LIVESYNC_COUCHDB_DATABASE" \
            '.couchDB_URI = $uri |
             .couchDB_USER = $user |
             .couchDB_PASSWORD = $password |
             .couchDB_DBNAME = $database |
             .liveSync = true |
             .syncOnSave = true |
             .syncOnStart = true |
             .isConfigured = true |
             .suspendFileWatching = false |
             .maxMTimeForReflectEvents = 0' \
            "$LIVESYNC_SETTINGS_PATH" > "$temp_settings"
    else
        jq -n \
            --arg uri "$LIVESYNC_COUCHDB_URL" \
            --arg user "$LIVESYNC_COUCHDB_USER" \
            --arg password "$LIVESYNC_COUCHDB_PASSWORD" \
            --arg database "$LIVESYNC_COUCHDB_DATABASE" \
            '{
                couchDB_URI: $uri,
                couchDB_USER: $user,
                couchDB_PASSWORD: $password,
                couchDB_DBNAME: $database,
                liveSync: true,
                syncOnSave: true,
                syncOnStart: true,
                encrypt: false,
                usePluginSync: false,
                isConfigured: true,
                suspendFileWatching: false,
                maxMTimeForReflectEvents: 0
            }' > "$temp_settings"
    fi
    chmod 600 "$temp_settings"
    mv -f "$temp_settings" "$LIVESYNC_SETTINGS_PATH"
    umask "$old_umask"
}

print_docker_command() {
    printf '%s\n' "docker run --rm --init -i -v $LIVESYNC_DB_DIR:/data -v $LIVESYNC_VAULT_DIR:/vault $LIVESYNC_IMAGE --settings /data/settings.json --vault /vault --write-settings $1"
}

run_cli() {
    action=$1
    shift
    case "$action" in
        sync|mirror|daemon|remote-status)
            write_settings
            ;;
        *)
            die "unsupported action: $action"
            ;;
    esac

    if [ "${LIVESYNC_DRY_RUN:-0}" = "1" ]; then
        print_docker_command "$action"
        return 0
    fi

    need_command docker
    docker run --rm --init -i \
        -v "$LIVESYNC_DB_DIR:/data" \
        -v "$LIVESYNC_VAULT_DIR:/vault" \
        "$LIVESYNC_IMAGE" \
        --settings /data/settings.json \
        --vault /vault \
        --write-settings \
        "$action" "$@"
}

build_image() {
    need_command docker
    [ -f "$LIVESYNC_SOURCE_DIR/src/apps/cli/Dockerfile" ] || die "missing LiveSync checkout: $LIVESYNC_SOURCE_DIR"
    docker build -f "$SCRIPT_DIR/Dockerfile" -t "$LIVESYNC_IMAGE" "$LIVESYNC_SOURCE_DIR"
}

doctor() {
    need_command docker
    need_command jq
    [ -d "$LIVESYNC_VAULT_DIR" ] || die "vault directory does not exist: $LIVESYNC_VAULT_DIR"
    load_couchdb_config
    docker image inspect "$LIVESYNC_IMAGE" >/dev/null 2>&1 || die "Docker image is missing: $LIVESYNC_IMAGE"
    write_settings
    printf '%s\n' "livesync doctor: ready"
    printf '%s\n' "vault=$LIVESYNC_VAULT_DIR"
    printf '%s\n' "state=$LIVESYNC_DB_DIR"
    printf '%s\n' "database=$LIVESYNC_COUCHDB_DATABASE"
}

action=${1:-daemon}
shift || true
case "$action" in
    build)
        build_image
        ;;
    doctor)
        doctor
        ;;
    sync|mirror|daemon|remote-status)
        run_cli "$action" "$@"
        ;;
    *)
        printf '%s\n' "Usage: $0 {build|doctor|sync|mirror|daemon|remote-status}" >&2
        exit 2
        ;;
esac
