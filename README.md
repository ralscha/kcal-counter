# kcal-counter

A calorie tracking app with a Go API and an Angular PWA frontend.

## What it does

- Passkey-based authentication backed by server-side sessions.
- Daily calorie dashboard, weekly history, editable food and activity templates, and profile preferences.
- Offline-first local storage with IndexedDB/Dexie and queued sync when the app comes back online.
- Separate offline data and preferences for each account, visible sync status, and manual retry.
- Service-worker updates, installable PWA metadata, dark/light theme support, and toast notifications.
- PostgreSQL persistence, migrations, sqlc-generated store code, RBAC tables, rate limiting, and cleanup scheduling.

## Project layout

- `backend/` contains the Go HTTP API, config loading, database migrations, sqlc queries, and tests.
- `frontend/` contains the Angular 22 application, PWA assets, offline sync code, and frontend tests.
- `deployment/` contains the production-oriented Docker Compose, Caddy, service, and deployment files.

## Local development

Start PostgreSQL:

```sh
cd backend
docker compose up -d
```

Run the API:

```sh
cd backend
go run ./cmd/app -config config/config.yaml
```

Run the frontend with Node.js (matching `frontend/package.json` engines) and pnpm 12.3.2:

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm run start
```

The Angular dev server proxies `/api` to `http://localhost:8080`.

## Checks

Backend:

```sh
cd backend
go test ./...
```

Frontend:

```sh
cd frontend
pnpm test
pnpm run build
pnpm run lint
```

Database-backed Go tests use testcontainers. If Docker cannot provide a PostgreSQL container in the current environment, those tests skip instead of failing for infrastructure reasons.

## Offline use and upgrades

After signing in online, the app can reopen that account's saved data without a network connection. Saves commit locally before forms close, then upload in batches in the background. The sync status shows pending changes and provides a **Sync now** button. Sign-out keeps each account's local data and queued edits for the next sign-in.

Deploy the API and frontend together: authentication now returns an account ID, and sync checks that the browser's account matches the server session. Existing server data downloads automatically into the account's new local database.

Older versions stored one shared browser database without identifying its owner. Its queued edits and preferences are preserved. Use **Profile → Previous device data** to download a backup and recover them after confirming they belong to the current account. Recovery keeps current queued edits and preferences when they already exist. The original database is retained.

Frontend tests run with Vitest on Node.js. Persistence tests use an IndexedDB implementation with Dexie transactions to cover rollback, in-flight edits, account changes, and reset recovery. `frontend/pnpm-lock.yaml` is checked in for reproducible development and deployment installs.
