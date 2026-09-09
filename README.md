# Leave Management System

A self-hosted web app that keeps vacation and sick-leave balances accurate, applies company leave policy automatically, and routes requests to the right approvers by email.

**Live demo:** [https://apexianlab-leave.rightandabove.com/](https://apexianlab-leave.rightandabove.com/)

White paper: [WHITEPAPER.md](WHITEPAPER.md).

License: [MIT](LICENSE) · copyright Right&Above, LLC.

## Features

**Employees** see accrued, held, spent and remaining vacation and sick leave; submit a request (type, dates, optional hours, comment, approvers); and follow their own history and balance timeline.

**Approvers** receive an email with a link, sign in with company SSO, and approve or reject. Access is checked against the addressee list.

**Administrators** manage the employee directory, leave policies, holiday calendars, default approvers, activity, audit trail, and Excel import/export.

Roles come from the identity token (directory groups). Signing in without an application role is refused. Employees see only their own data; administrators see everyone.

Each employee is assigned a leave policy with configurable vacation and sick allowances, optional seniority step-up, a probationary period, paid and unpaid sick leave, and carryover. Vacation accrues monthly; sick leave is granted as a yearly amount, prorated from the hire month. Pending time goes on **hold** (weekends and holidays skipped); rejecting a request releases the hold, approving it spends the days.

## Stack

Nx monorepo: NestJS 11 API, React 18 + MUI frontend, PostgreSQL (TypeORM), shared TypeScript contracts.

Identity: OIDC (Keycloak) via [`@rightandabove/auth-oidc-*`](https://github.com/raa-org/auth-oidc). Email: [`@rightandabove/communication-email-*`](https://github.com/raa-org/communication-email). Optional LDAPS directory sync.

## Getting started

Requires **Node.js >= 22** and **Docker** (Postgres + Keycloak + MailHog).

```bash
cp .env.example .env

docker compose up -d db keycloak mailhog

npm install
npm run migration:run

npm run serve:api    # API on :3000
npm run serve:web    # Vite on :4200
```

`.env.example` matches the bundled Keycloak realm ([`docker/keycloak/leave-management-realm.json`](docker/keycloak/leave-management-realm.json)). Restart the Keycloak container to re-import the realm.

`npm install` pulls `@rightandabove/*` from the **public npm registry**. No private GitLab token is required.

### Demo users (local Keycloak)

| User | Password | App roles |
| --- | --- | --- |
| `employee@example.com` | `employee` | Employee |
| `admin@example.com` | `admin` | Employee + Administrator |
| `guest@example.com` | `guest` | *(none — sign-in refused)* |

Keycloak admin: [http://localhost:8080](http://localhost:8080) — `admin` / `admin`. MailHog: [http://localhost:8025](http://localhost:8025).

### Demo onboarding (before the first leave request)

Signing in **creates or updates** the employee row (OIDC auto-provisioning). There is **no employee self-service profile screen** — an administrator must finish setup before leave requests work.

**Why leave is blocked:** the API requires profile status **Ready** — both an **employment start date** and a **country** on the employee record, plus a **holiday calendar** for that country (at least for the request year). Until then the employee UI shows *Profile setup in progress*.

**Local Keycloak demo flow**

1. Sign in once as `employee@example.com` (creates the directory row).
2. Sign in as `admin@example.com` → **Employees** (`/admin/employees`) → open the employee.
3. Set **Employment start date** (a past date, e.g. `2026-01-01`) and **Country** (`UA` if not already filled from the token `country` claim).
4. If requests are still blocked: **Settings** → **Holidays** → ensure a calendar exists for **UA** and the current year (an empty calendar is enough to unblock the form).
5. Sign in again as the employee — dashboard and **New leave request** should be available.

**Bulk / directory sync (not used in the bundled demo):**

| Method | When |
| --- | --- |
| **LDAP sync** | Production with a real directory — set `LDAP_SYNC_ENABLED=true` and `ldaps://…` in `.env`; admins can run sync from Settings. Login still goes through OIDC. |
| **Excel import** | Admin → Settings → Import — hire date, country, balances, etc. |
| **Demo Keycloak only** | No LDAP — provision on first login, then admin completes each profile as above. |

To also run the API container:

```bash
docker compose up --build
```

## Configuration

Secrets live only in the gitignored `.env` (or real `process.env`). Start from [`.env.example`](.env.example).

Loading order, highest first: process environment, then `.env`, then optional `.env.<APP_ENV>`.

Frontend only receives `VITE_*` variables at build time.

### Identity provider (OIDC)

The API reads claims from the ID token after login. Mapping is in [`AuthOidcUserProfileMapper`](apps/api/src/host/auth-oidc-user-profile-mapper.ts).

**Required ID token claims**

| Claim | Required | Purpose |
| --- | --- | --- |
| `sub` | Yes | Stable subject (user id) |
| `email` | Yes | Login email |
| `name` | No | Display name; falls back to `email` |
| `roles` | Yes* | Realm role names — see below |
| `country` | No | ISO 3166-1 alpha-2 (e.g. `UA`) |

\* At least one app role must appear in `roles`. Keycloak system roles alone (`default-roles-*`, `offline_access`, …) → 403.

**Role mapping** (env overrides in `.env.example`):

| Env | Default | App role |
| --- | --- | --- |
| `OIDC_EMPLOYEE_ROLE` | `lrs-employees` | Employee |
| `OIDC_ADMIN_ROLE` | `lrs-admins` | Administrator |

Admin does **not** imply employee — that is decided in the IdP.

**Your own Keycloak realm**

1. Confidential client, authorization code, redirect `{FRONTEND_URL}/api/auth-oidc/callback`, post-logout `{FRONTEND_URL}/*`, web origin `{FRONTEND_URL}`.
2. Realm roles `lrs-employees` and `lrs-admins` (or match your env overrides).
3. Protocol mapper: realm roles → flat claim **`roles`** (multivalued, in ID token). Optional: user attribute `country` → claim `country`.
4. Set `OIDC_*`, `JWT_SECRET`, `SESSION_SECRET` (min 32 chars), `FRONTEND_URL` in `.env`.

LDAP sync is optional (`LDAP_SYNC_ENABLED=true`, `ldaps://` only) — it upserts users from directory groups; login still goes through OIDC.

## API (overview)

Controllers have no `/api` prefix — put a reverse proxy in front if you want `/api`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/dashboard/me` | Current employee's dashboard |
| `GET` | `/leave-requests/me` | List own requests |
| `POST` | `/leave-requests` | Create a request |
| `GET` | `/leave-requests/:requestId` | Request detail |
| `POST` | `/leave-requests/:requestId/approval` | Approve / reject |
| `POST` | `/leave-requests/:requestId/cancel` | Cancel own pending request |
| `GET` | `/admin/activity` | Activity feed |
| `GET` | `/admin/employees` | Employees directory |
| `GET` `PUT` | `/admin/settings` | Settings |
| `GET` `PUT` | `/admin/holidays` | Holiday calendar |

Swagger UI: `/api-docs`.

## Documentation

- [White paper](WHITEPAPER.md) — business problem, industry context, design approach, and how Leave Management System implements it.

## Database

Schema changes go through TypeORM migrations (`npm run migration:generate` / `migration:run`). `synchronize` is off. Run migrations **before** deploying code that needs them.

## Security

See [SECURITY.md](SECURITY.md). Do not file public issues for vulnerabilities.
