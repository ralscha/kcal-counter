# Going To Production

This document is the production checklist for this service.

The app itself serves plain HTTP. In production, put it behind Caddy for TLS and public ingress.

## 1. Pick Your Public Hostnames

Decide which hostname will serve the app, for example:

- `api.example.com` for the API
- `app.example.com` for the frontend, if it is separate

If you are using OAuth, WebAuthn, cookies, and email links, these hostnames need to be finalized before you configure providers.

## 2. Set Up DNS

Create DNS records for the machine that will run Caddy.

- Add an `A` record for IPv4, for example `api.example.com -> 203.0.113.10`
- Add an `AAAA` record for IPv6, for example `api.example.com -> 2001:db8::10`

If you only have IPv4, the `A` record is enough.

You want the hostname to resolve to the public IP of the server that will terminate TLS.

## 3. Open Network Ports

The public server needs inbound access for:

- `80/tcp` for ACME HTTP challenge and HTTP to HTTPS redirect
- `443/tcp` for HTTPS traffic

Do not expose the Go service directly on the internet. Expose only Caddy.

## 4. Run The App On A Private HTTP Listener

This app should listen on a local interface behind Caddy.

Recommended production bind address:

```yaml
http:
  address: "127.0.0.1:8080"
```

That keeps the Go process private while Caddy accepts the public traffic.

## 5. Production Config Changes

The default [config/config.yaml](config/config.yaml) is a development config. Do not use it unchanged in production.

The backend loads its configuration from `config/config.yaml` relative to its working directory. With the versioned systemd unit in [deployment/kcal-counter.service](deployment/kcal-counter.service), that means the production file should be installed at:

```text
/opt/kcal-counter/backend/config/config.yaml
```

This repository includes a production template at [deployment/config.yaml](deployment/config.yaml). Copy that file to the path above and replace its placeholder secrets and hostnames before starting the service.

At minimum, review and change these sections.

### App

```yaml
app:
  env: production
  log_level: warn
```

- Set `env: production`
- `warn` is the supported warning-level setting in this codebase

### HTTP

```yaml
http:
  address: "127.0.0.1:8080"
  read_timeout: 15s
  read_header_timeout: 10s
  write_timeout: 30s
  idle_timeout: 60s
  shutdown_timeout: 20s
```

- Keep the app on a private bind address
- Timeouts can stay as they are unless you have large uploads or long-lived requests

### Database

Use a real production Postgres instance, not the local dev connection string.

Example:

```yaml
database:
  url: postgres://kcal_counter_user:REDACTED@db.example.com:5432/kcal_counter?sslmode=require
  max_open_conns: 25
  max_idle_conns: 5
  conn_max_lifetime: 5m
  conn_max_idle_time: 2m
```

- Use `sslmode=require` or stricter
- Use separate production credentials
- Make sure the DB firewall only allows the app host

If you want to run a single-host Postgres instance in Docker on the same machine as the app, this repository includes a versioned Compose file at [backend/deploy/postgres/docker-compose.yml](backend/deploy/postgres/docker-compose.yml). It binds Postgres only to `127.0.0.1:5432`, stores data in a named volume, and reads the database password from a local secret file instead of hardcoding it in the Compose YAML.

Typical usage:

```sh
cp ./backend/deploy/postgres/postgres_password.txt.example ./backend/deploy/postgres/postgres_password.txt
docker compose -f ./backend/deploy/postgres/docker-compose.yml up -d
docker compose -f ./backend/deploy/postgres/docker-compose.yml ps
```

When Postgres is bound only to `127.0.0.1` on the same host as the app, using `sslmode=disable` in the app's database URL can be acceptable because the traffic never leaves the machine. If Postgres runs on another host, keep using TLS with `sslmode=require` or stricter.

### Session Cookies

For production behind HTTPS:

```yaml
session:
  cookie_name: kcal_counter_session
  lifetime: 24h
  idle_timeout: 12h
  same_site: lax
  secure: true
  http_only: true
  persist: true
```

- `secure: true` is required for HTTPS-only cookies
- `http_only: true` should remain enabled
- `same_site: lax` is generally fine for a normal web app

### Security

This is the most important section to review.

```yaml
security:
  encryption_key: CHANGE_ME_TO_A_LONG_RANDOM_SECRET
  authorization_cache_ttl: 5s
  failed_login_threshold: 5
  failed_login_window: 15m
  inactivity_disable_after: 8760h
```

- Replace `encryption_key` with a strong random value of at least 32 characters
- Do not reuse the default key from development

Example Linux command to generate a strong encryption key:

```sh
openssl rand -base64 48
```

If the generated value includes special characters, wrap it in quotes in your YAML config.

The `security.encryption_key` is used for application-level encryption of secrets stored in the database. If you change this key later without a rotation plan, previously stored encrypted values may no longer decrypt correctly.

Important: the app refuses to start in non-development environments if the default encryption key is still present. That check is implemented in [internal/config/config.go](internal/config/config.go).

### WebAuthn

If you use passkeys, these values must match your production hostname.

Example:

```yaml
webauthn:
  rp_id: api.example.com
  rp_display_name: Example
  rp_origins:
    - https://app.example.com
```

- `rp_id` must be a real domain you control
- `rp_origins` must contain the actual HTTPS origins used by the browser

### Scheduler

The scheduler is responsible for cleanup and inactive-account jobs.

```yaml
scheduler:
  enabled: true
  cleanup_every: 1h
  inactivity_check_every: 24h
```

Leave this enabled unless you move those jobs to a separate worker process.

## 6. Set Up Caddy As Reverse Proxy With TLS

Caddy is a good fit here because it will automatically provision and renew TLS certificates.

In production, serve both the Angular frontend and the Go backend from the same hostname. The built frontend assets live at `/opt/kcal-counter/frontend/dist/kcal-counter/browser`, while the Go app continues listening privately on `127.0.0.1:8080`.

Example `Caddyfile`:

```caddy
app.example.com {
  @api path /api/*
  handle @api {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
  }

  handle {
    root * /opt/kcal-counter/frontend/dist/kcal-counter/browser
    try_files {path} /index.html
    file_server {
      precompressed br gzip
    }
  }

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
  }
}
```

The same example is versioned in this repository at [backend/deploy/caddy/Caddyfile](backend/deploy/caddy/Caddyfile).

Notes:

- Caddy listens publicly on `:80` and `:443`
- Caddy fetches certificates automatically once DNS points at the box
- Requests for `/api/*` are proxied to the Go backend on `127.0.0.1:8080`, and Caddy compresses those proxied responses with `zstd` or `gzip`
- All other requests are served from `/opt/kcal-counter/frontend/dist/kcal-counter/browser`
- Static assets are served from precompressed `.br` and `.gz` files when available, so Caddy does not recompress them on the fly
- `try_files {path} /index.html` allows Angular client-side routes to load correctly on refresh or direct navigation
- The Go app continues to listen only on `127.0.0.1:8080`
- In this production setup, Caddy is the single owner of these response security headers, so the Go app does not need to emit them itself

If you later split frontend and API across different domains, create separate site blocks. If you run this app on the same host as other sites, keep the hostname-specific Caddy blocks separate and explicit.

## 7. Start The App As A Service

Use a service manager such as `systemd` on Linux so the app restarts automatically and has controlled environment/config.

Typical production pattern:

- Deploy the compiled Go binary
- Store the production config file on disk with restricted permissions
- Run the app as a non-root user
- Keep Caddy as the only public-facing process

This repository includes:

- a systemd unit at [deployment/kcal-counter.service](deployment/kcal-counter.service)
- a matching Caddyfile at [deployment/Caddyfile](deployment/Caddyfile)
- a production build-and-deploy script at [backend/deploy/build-and-deploy.sh](backend/deploy/build-and-deploy.sh)

It assumes:

- the backend binary is installed at `/opt/kcal-counter/backend/bin/app`
- the backend working directory is `/opt/kcal-counter/backend`
- the production config is available at `/opt/kcal-counter/backend/config/config.yaml`
- the service runs as a dedicated `kcal-counter` system user

On Debian 13, install it like this:

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin kcal-counter
sudo systemctl daemon-reload
sudo systemctl enable --now kcal-counter.service
sudo systemctl reload caddy
sudo systemctl status kcal-counter.service
```

Or run the bundled deploy script as root:

```sh
sudo REPO_URL=git@github.com:YOUR_ORG/kcal-counter.git BRANCH=main bash ./backend/deploy/build-and-deploy.sh
```

The deploy script clones a fresh checkout into `/opt/kcal-counter/build`, builds the backend and frontend there, publishes `/opt/kcal-counter/backend/bin/app` and `/opt/kcal-counter/frontend/dist`, fixes ownership and modes on those deployed artefacts, stops the backend service only while the binary is swapped, and starts it again afterwards. It does not overwrite `/opt/kcal-counter/backend/config/config.yaml`.

Before you run it, make sure:

- `git`, `go`, `bun`, and `systemctl` are installed on the server
- the `kcal-counter` system user and group already exist
- `/opt/kcal-counter/backend/config/config.yaml` already contains your production config
- `REPO_URL` points at the repository the server is allowed to clone

Useful follow-up commands:

```sh
sudo journalctl -u kcal-counter.service -f
sudo systemctl restart kcal-counter.service
sudo systemctl stop kcal-counter.service
```

This app starts from [cmd/app/main.go](cmd/app/main.go), loads config, opens Postgres, runs migrations, starts the scheduler, and serves HTTP.

## 8. Run Database Migrations Safely

The app currently runs migrations on startup from [internal/app/app.go](internal/app/app.go).

That is convenient, but in production you should still treat schema changes carefully:

- back up the database before risky migrations
- review migration SQL before deploy
- test migrations against a staging environment first
- avoid multiple simultaneous first-start deploys if you later scale horizontally

## 9. Production OAuth Setup

OAuth does not work in production until you register the app with each provider.

The app already supports the OAuth flow and exposes these routes:

- `/api/v1/auth/oauth/{provider}/start`
- `/api/v1/auth/oauth/{provider}/callback`

The provider config lives in [config/config.yaml](config/config.yaml) and the types are defined in [internal/config/config.go](internal/config/config.go).

### What You Must Do With The Provider

For each provider such as Google, GitHub, or Microsoft:

1. Create an OAuth application in the provider's developer console.
2. Set the authorized redirect URI to your production callback URL.
3. Copy the issued client ID and client secret into this app's config.
4. Enable the provider in the config.

For Google, a typical production redirect URI would be:

## 10. Smoke Test Before Real Traffic

Before opening the service to users, validate the full flow.

Checklist:

1. Open `https://api.example.com/health`
2. Confirm Caddy serves a valid certificate
3. Confirm the app can reach Postgres
4. Register a user with a passkey
5. Log in with a passkey from the real production hostname
6. Verify authenticated API access works normally after sign-in

## 11. Common Production Mistakes

Avoid these:

- leaving `security.encryption_key` at the development default
- leaving `session.secure: false`
- pointing DNS at the app directly instead of at Caddy
- forgetting to open `80` and `443`
- registering the wrong OAuth redirect URL with the provider
- leaving WebAuthn origins on localhost
- using a non-TLS SMTP setup for production mail
- exposing Postgres directly to the public internet

## 12. Minimal Production Checklist

1. Create the server and public IP.
2. Add `A` and optionally `AAAA` DNS records.
3. Install Caddy and configure a reverse proxy for your hostname.
4. Run the Go app on `127.0.0.1:8080`.
5. Replace the default encryption key.
6. Turn on secure cookies and secure CSRF behavior.
7. Point the app at production Postgres with TLS.
8. Configure SMTP.
9. Update WebAuthn production domain settings if using passkeys.
10. Register the app with each OAuth provider and set exact callback URLs.
11. Smoke test login, email, OAuth, and recovery flows.
