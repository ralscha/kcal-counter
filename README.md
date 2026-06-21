# kcal-counter

A calorie tracking app with a Go API and an Angular PWA frontend.

## What it does

- Passkey-based authentication backed by server-side sessions.
- Daily calorie dashboard, weekly history, editable food and activity templates, and profile preferences.
- Offline-first local storage with IndexedDB/Dexie and queued sync when the app comes back online.
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

Run the frontend:

```sh
cd frontend
bun install
bun run start
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
bun test
bun run build
bun run lint
```

Database-backed Go tests use testcontainers. If Docker cannot provide a PostgreSQL container in the current environment, those tests skip instead of failing for infrastructure reasons.

