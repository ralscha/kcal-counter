-- +goose Up
CREATE TYPE kcal_template_kind AS ENUM ('food', 'activity');

CREATE SEQUENCE IF NOT EXISTS kcal_sync_global_version_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS kcal_template_items (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind kcal_template_kind NOT NULL,
    name TEXT NOT NULL,
    amount NUMERIC(12, 3) NOT NULL,
    unit TEXT NOT NULL,
    kcal_amount INTEGER NOT NULL,
    client_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    server_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    global_version BIGINT NOT NULL DEFAULT nextval('kcal_sync_global_version_seq'),
    deleted_at TIMESTAMPTZ,
    CHECK (length(btrim(name)) > 0),
    CHECK (amount > 0),
    CHECK (kcal_amount > 0),
    CHECK (length(btrim(unit)) > 0)
);

CREATE TABLE IF NOT EXISTS kcal_entries (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kcal_delta INTEGER NOT NULL,
    happened_at TIMESTAMPTZ NOT NULL,
    client_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    server_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    global_version BIGINT NOT NULL DEFAULT nextval('kcal_sync_global_version_seq'),
    deleted_at TIMESTAMPTZ,
    CHECK (kcal_delta <> 0)
);

CREATE TABLE IF NOT EXISTS sync_metadata (
    user_id BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    min_valid_version BIGINT NOT NULL DEFAULT 0,
    CHECK (min_valid_version >= 0)
);

CREATE TABLE IF NOT EXISTS device_sync_state (
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id UUID NOT NULL,
    last_sync_version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, device_id),
    CHECK (last_sync_version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_kcal_template_items_user_kind ON kcal_template_items (user_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kcal_entries_user_happened_at ON kcal_entries (user_id, happened_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kcal_template_items_user_global_version ON kcal_template_items (user_id, global_version);
CREATE INDEX IF NOT EXISTS idx_kcal_entries_user_global_version ON kcal_entries (user_id, global_version);
CREATE INDEX IF NOT EXISTS idx_kcal_template_items_user_deleted_at ON kcal_template_items (user_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kcal_entries_user_deleted_at ON kcal_entries (user_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS device_sync_state;
DROP TABLE IF EXISTS sync_metadata;
DROP TABLE IF EXISTS kcal_entries;
DROP TABLE IF EXISTS kcal_template_items;

DROP SEQUENCE IF EXISTS kcal_sync_global_version_seq;

DROP TYPE IF EXISTS kcal_template_kind;