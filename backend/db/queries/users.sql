-- name: CreateUser :one
INSERT INTO users
(
  webauthn_user_id
)
VALUES ($1)
RETURNING *;

-- name: GetUserByID :one
SELECT *
FROM users
WHERE id = $1;

-- name: UpdateUserLastLogin :exec
UPDATE users
SET last_login_at = NOW(),
    last_seen_at = NOW(),
    failed_login_count = 0,
    locked_until = NULL
WHERE id = $1;

-- name: DisableInactiveUsers :many
UPDATE users
SET is_active = FALSE,
    disabled_reason = 'inactivity',
    disabled_at = NOW()
WHERE is_active = TRUE
  AND COALESCE(last_login_at, created_at) < $1
RETURNING *;
