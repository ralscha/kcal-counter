# kcal-counter

A calorie tracking app with a Go API and an Angular PWA frontend.

## What it does

- Passkey-based authentication backed by server-side sessions.
- Daily calorie dashboard, weekly history, editable food and activity templates, saved meals, and profile preferences.
- Offline-first local storage with IndexedDB/Dexie and queued sync when the app comes back online.
- Separate offline data and preferences for each account, visible sync status, and manual retry.
- Account-wide calorie targets with effective dates, current period start dates, and archived periods, synchronized between devices.
- Repeat an entry, copy yesterday, or log a saved meal made from several food templates.
- Interactive daily, seven-day-average, and cumulative-difference charts, with period comparisons.
- CSV spreadsheet exports and full JSON backup/import with a merge preview.
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

Run the frontend with Node.js matching `frontend/package.json` engines and the pnpm version pinned in its `packageManager` field:

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm run start
```

The Angular dev server proxies `/api` to `http://localhost:8080`.

Regenerate icon assets with `pnpm run icons` in `frontend/`. The source artwork is
`frontend/scripts/assets/app-icon.png`. Desktop icons fill their canvas; mobile
maskable icons have separate padding and an opaque background. When changing the
artwork, bump the icon URL version in the manifest and HTML so installed apps can
detect the update.

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

Database-backed Go tests use testcontainers and skip when Docker is unavailable. Image-pull and container startup failures still fail the tests. Set `KCAL_COUNTER_TEST_POSTGRES_IMAGE` to another PostgreSQL 18 image, such as a locally cached `postgres:18.6`, to override the default `postgres:18-alpine` image.

## Offline use and synchronization

After signing in online, the app can reopen that account's saved data without a network connection. Saves commit locally before forms close, then upload in batches in the background. The sync status shows pending changes and provides a **Sync now** button. Sign-out keeps each account's local data and queued edits for the next sign-in.

Targets, period dates, archived periods, and saved meals are stored per account in PostgreSQL and cached on each device. Dates use calendar dates without time zones. Changes save locally and queue for synchronization, including when offline. Signing in on another device downloads the same account data. Offline changes use the same retry and conflict handling as calorie entries; the newest edit wins.

In **Profile**, set a target and its effective date. Earlier days keep their earlier targets, and future changes can be scheduled. A blank target disables it from that date. Starting a new period archives the previous range through yesterday and sets the active start to today in one local transaction. Editing the active start adjusts the current period; clearing it retains archived periods.

A new device must complete its first sync before starting a new period, so the previous period can be archived correctly. After that, starting periods works offline as well.

**Saved meals** contain snapshots of food-template portions and calories. Editing or deleting a template does not alter saved meals or previously logged entries. Logging a meal or copying a day saves all new entries together; copied entries keep their local time of day and food/activity signs.

**Trends & periods** compares net calories (food minus activity) with each day's effective target. Seven-day averages include all seven calendar days, with zero for days without entries. The recording coverage count shows days with any entries, not whether a day is complete. A full-period difference requires a target on every day. Charts show at most 366 days at once; period totals cover the full range.

**Export & backup** downloads CSV files for entries, daily totals, templates, and archived periods. JSON backups include entries, templates, target history, archived periods, the active period start, and saved meals, including changes waiting to sync. Import previews the records to add or replace, then merges by ID after confirmation. Other existing records remain; matching IDs and the active period start use the backup values. Files contain no sign-in credentials or account IDs, and can be restored into a fresh account. Imports validate the whole file and commit locally in one transaction. The limits are 10 MiB per file, 50,000 records and meal items, 1,000 archived periods, and 128 KiB per sync record.

Uploads are bounded by both record count and encoded request size. Related archived-period changes and the active start travel together; other records upload in batches. Resets retain queued local changes for all entity types.

If another device changes period boundaries while you are offline, the server checks the combined history before accepting your period changes. Conflicting period changes are rejected together and the current server history is restored on your device; the sync notice links to review the history before starting a period again. Independent food, activity, meal, and target changes can still sync.

This project targets fresh installations. The initial PostgreSQL and IndexedDB schemas contain the current data model; there is no upgrade or legacy-data recovery path. Deploy the API and frontend together. Sync checks that the browser's account matches the server session.

Frontend tests run with Vitest on Node.js. Persistence tests use an IndexedDB implementation with Dexie transactions to cover rollback, in-flight edits, account changes, and reset recovery. `frontend/pnpm-lock.yaml` is checked in for reproducible development and deployment installs.
