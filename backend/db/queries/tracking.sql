-- name: GetKcalTargetForUpdate :one
SELECT * FROM kcal_targets
WHERE id = $1 AND user_id = $2
FOR UPDATE;

-- name: UpsertKcalTarget :one
INSERT INTO kcal_targets (
    id,
    user_id,
    effective_from,
    kcal_limit,
    client_updated_at,
    server_updated_at,
    deleted_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, id) DO UPDATE
SET effective_from = EXCLUDED.effective_from,
    kcal_limit = EXCLUDED.kcal_limit,
    client_updated_at = EXCLUDED.client_updated_at,
    server_updated_at = EXCLUDED.server_updated_at,
    deleted_at = EXCLUDED.deleted_at,
    global_version = EXCLUDED.global_version
RETURNING *;

-- name: DeleteExpiredTargetTombstones :many
DELETE FROM kcal_targets
WHERE user_id = $1
  AND deleted_at IS NOT NULL
  AND server_updated_at < $2
RETURNING global_version;

-- name: GetKcalPeriodForUpdate :one
SELECT * FROM kcal_periods
WHERE id = $1 AND user_id = $2
FOR UPDATE;

-- name: UpsertKcalPeriod :one
INSERT INTO kcal_periods (
    id,
    user_id,
    start_date,
    end_date,
    client_updated_at,
    server_updated_at,
    deleted_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, id) DO UPDATE
SET start_date = EXCLUDED.start_date,
    end_date = EXCLUDED.end_date,
    client_updated_at = EXCLUDED.client_updated_at,
    server_updated_at = EXCLUDED.server_updated_at,
    deleted_at = EXCLUDED.deleted_at,
    global_version = EXCLUDED.global_version
RETURNING *;

-- name: DeleteExpiredPeriodTombstones :many
DELETE FROM kcal_periods
WHERE user_id = $1
  AND deleted_at IS NOT NULL
  AND server_updated_at < $2
RETURNING global_version;

-- name: GetKcalMealForUpdate :one
SELECT * FROM kcal_meals
WHERE id = $1 AND user_id = $2
FOR UPDATE;

-- name: UpsertKcalMeal :one
INSERT INTO kcal_meals (
    id,
    user_id,
    name,
    items,
    client_updated_at,
    server_updated_at,
    deleted_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, id) DO UPDATE
SET name = EXCLUDED.name,
    items = EXCLUDED.items,
    client_updated_at = EXCLUDED.client_updated_at,
    server_updated_at = EXCLUDED.server_updated_at,
    deleted_at = EXCLUDED.deleted_at,
    global_version = EXCLUDED.global_version
RETURNING *;

-- name: DeleteExpiredMealTombstones :many
DELETE FROM kcal_meals
WHERE user_id = $1
  AND deleted_at IS NOT NULL
  AND server_updated_at < $2
RETURNING global_version;

