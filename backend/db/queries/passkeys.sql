-- name: CreatePasskeyCredential :one
INSERT INTO passkey_credentials (
    user_id,
    credential_id,
    credential_public_key,
    attestation_type,
    aaguid,
    sign_count,
    clone_warning,
    transports,
    credential_data
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: ListPasskeyCredentialsByUserID :many
SELECT *
FROM passkey_credentials
WHERE user_id = $1
ORDER BY id ASC;

-- name: GetPasskeyCredentialByCredentialID :one
SELECT *
FROM passkey_credentials
WHERE credential_id = $1;

-- name: UpdatePasskeyCredential :exec
UPDATE passkey_credentials
SET
    credential_public_key = $2,
    attestation_type = $3,
    aaguid = $4,
    sign_count = $5,
    clone_warning = $6,
    transports = $7,
    credential_data = $8
WHERE credential_id = $1;