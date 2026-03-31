-- name: CreateKcalTemplateItem :one
INSERT INTO kcal_template_items (
    id,
    user_id,
    kind,
    name,
    amount,
    unit,
    kcal_amount,
    client_updated_at,
    server_updated_at,
    deleted_at
) VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10
)
RETURNING *;

-- name: GetKcalTemplateItemByID :one
SELECT *
FROM kcal_template_items
WHERE id = $1
  AND user_id = $2;

-- name: GetKcalTemplateItemForUpdate :one
SELECT *
FROM kcal_template_items
WHERE id = $1
  AND user_id = $2
FOR UPDATE;

-- name: ListKcalTemplateItemsByKind :many
SELECT *
FROM kcal_template_items
WHERE user_id = $1
  AND kind = $2
  AND deleted_at IS NULL
ORDER BY name, id;

-- name: UpdateKcalTemplateItem :one
UPDATE kcal_template_items
SET kind = $3,
    name = $4,
    amount = $5,
    unit = $6,
    kcal_amount = $7,
    client_updated_at = $8,
    server_updated_at = $9,
    deleted_at = $10,
    global_version = DEFAULT
WHERE id = $1
  AND user_id = $2
RETURNING *;

-- name: DeleteKcalTemplateItem :one
UPDATE kcal_template_items
SET client_updated_at = $3,
    server_updated_at = $4,
    deleted_at = $4,
    global_version = DEFAULT
WHERE id = $1
  AND user_id = $2
  AND deleted_at IS NULL
RETURNING *;

-- name: CreateKcalEntry :one
INSERT INTO kcal_entries (
    id,
    user_id,
    kcal_delta,
    happened_at,
    client_updated_at,
    server_updated_at,
    deleted_at
) VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7
)
RETURNING *;

-- name: GetKcalEntryByID :one
SELECT *
FROM kcal_entries
WHERE id = $1
  AND user_id = $2;

-- name: GetKcalEntryForUpdate :one
SELECT *
FROM kcal_entries
WHERE id = $1
  AND user_id = $2
FOR UPDATE;

-- name: UpdateKcalEntry :one
UPDATE kcal_entries
SET kcal_delta = $3,
    happened_at = $4,
    client_updated_at = $5,
    server_updated_at = $6,
    deleted_at = $7,
    global_version = DEFAULT
WHERE id = $1
  AND user_id = $2
RETURNING *;

-- name: DeleteKcalEntry :one
UPDATE kcal_entries
SET client_updated_at = $3,
    server_updated_at = $4,
    deleted_at = $4,
    global_version = DEFAULT
WHERE id = $1
  AND user_id = $2
  AND deleted_at IS NULL
RETURNING *;

-- name: ListKcalEntriesInRange :many
SELECT *
FROM kcal_entries
WHERE user_id = $1
  AND deleted_at IS NULL
  AND happened_at >= $2
  AND happened_at < $3
ORDER BY happened_at DESC, id DESC;

-- name: GetKcalTotalInRange :one
SELECT COALESCE(SUM(kcal_delta), 0)::bigint AS total_kcal
FROM kcal_entries
WHERE user_id = $1
  AND deleted_at IS NULL
  AND happened_at >= $2
  AND happened_at < $3;

-- name: EnsureSyncMetadataRow :exec
INSERT INTO sync_metadata (
    user_id,
    min_valid_version
) VALUES (
    $1,
    0
)
ON CONFLICT (user_id) DO NOTHING;

-- name: ReadSyncMetadata :one
SELECT GREATEST(
       COALESCE((SELECT MAX(template_items.global_version) FROM kcal_template_items AS template_items WHERE template_items.user_id = $1), 0),
       COALESCE((SELECT MAX(entries.global_version) FROM kcal_entries AS entries WHERE entries.user_id = $1), 0),
       metadata.min_valid_version
       )::BIGINT AS current_version,
     metadata.min_valid_version
FROM sync_metadata AS metadata
WHERE metadata.user_id = $1;

-- name: ListSyncRecordsSince :many
SELECT entity_table,
       id,
       kind,
       name,
       amount,
       unit,
       kcal_amount,
       kcal_delta,
       happened_at,
       client_updated_at,
       server_updated_at,
       global_version,
       deleted
FROM (
    SELECT 'kcal_template_items'::text AS entity_table,
           id,
           kind::text,
           name,
           amount::text,
           unit,
           kcal_amount,
           NULL::integer AS kcal_delta,
           NULL::timestamptz AS happened_at,
           client_updated_at,
           server_updated_at,
           global_version,
           (deleted_at IS NOT NULL)::boolean AS deleted
    FROM kcal_template_items AS template_items
    WHERE template_items.user_id = $1
      AND template_items.global_version > $2

    UNION ALL

    SELECT 'kcal_entries'::text AS entity_table,
           id,
          ''::text AS kind,
          ''::text AS name,
          ''::text AS amount,
          ''::text AS unit,
          0::integer AS kcal_amount,
           kcal_delta,
           happened_at,
           client_updated_at,
           server_updated_at,
           global_version,
          (deleted_at IS NOT NULL)::boolean AS deleted
    FROM kcal_entries AS entries
    WHERE entries.user_id = $1
      AND entries.global_version > $2
) AS sync_records
ORDER BY global_version, entity_table, id;

-- name: ListSyncSnapshot :many
SELECT entity_table,
       id,
       kind,
       name,
       amount,
       unit,
       kcal_amount,
       kcal_delta,
       happened_at,
       client_updated_at,
       server_updated_at,
       global_version,
       deleted
FROM (
    SELECT 'kcal_template_items'::text AS entity_table,
           id,
           kind::text,
           name,
           amount::text,
           unit,
           kcal_amount,
           NULL::integer AS kcal_delta,
           NULL::timestamptz AS happened_at,
           client_updated_at,
           server_updated_at,
           global_version,
           FALSE::boolean AS deleted
    FROM kcal_template_items AS template_items
    WHERE template_items.user_id = $1
      AND template_items.deleted_at IS NULL

    UNION ALL

    SELECT 'kcal_entries'::text AS entity_table,
           id,
          ''::text AS kind,
          ''::text AS name,
          ''::text AS amount,
          ''::text AS unit,
          0::integer AS kcal_amount,
           kcal_delta,
           happened_at,
           client_updated_at,
           server_updated_at,
           global_version,
          FALSE::boolean AS deleted
    FROM kcal_entries AS entries
    WHERE entries.user_id = $1
      AND entries.deleted_at IS NULL
) AS sync_snapshot
ORDER BY server_updated_at DESC, entity_table, id;

-- name: DeleteExpiredTemplateTombstones :many
DELETE FROM kcal_template_items AS template_items
WHERE template_items.user_id = $1
  AND template_items.deleted_at IS NOT NULL
  AND template_items.server_updated_at < $2
RETURNING template_items.global_version;

-- name: DeleteExpiredEntryTombstones :many
DELETE FROM kcal_entries AS entries
WHERE entries.user_id = $1
  AND entries.deleted_at IS NOT NULL
  AND entries.server_updated_at < $2
RETURNING entries.global_version;

-- name: BumpMinValidVersion :exec
UPDATE sync_metadata
SET min_valid_version = GREATEST(min_valid_version, $2)
WHERE user_id = $1;

-- name: UpsertDeviceSyncState :exec
INSERT INTO device_sync_state (
    user_id,
    device_id,
    last_sync_version
) VALUES (
    $1,
    $2,
    $3
)
ON CONFLICT (user_id, device_id) DO UPDATE
SET last_sync_version = EXCLUDED.last_sync_version;