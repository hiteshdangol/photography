# LensFlow

Multi-tenant photography management and client platform: photographers run their
business, clients browse and pick their photographs, and every shoot moves
through a timeline from booking to final delivery.

- **Client** — React 19 + Vite + TypeScript + Tailwind, React Query for server
  state, Socket.IO for realtime.
- **Server** — Express 5 + TypeScript, Mongoose, Socket.IO, JWT auth with
  refresh rotation, background jobs, pluggable storage and payment providers.

## Requirements

- Node.js **>= 22.12**
- MongoDB (optional in development — see below)

## Quick start

```bash
npm install
cp .env.example .env      # then set JWT_SECRET and JWT_REFRESH_SECRET
npm run seed              # demo photographer, client, admin and projects
npm run dev               # API on :5000, client on :5173
```

Open <http://localhost:5173>.

Generate real secrets before anything else:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### No MongoDB? It still runs

If `MONGO_URI` is unreachable and `NODE_ENV` is not `production`, the server
falls back to an ephemeral in-process MongoDB. Data is discarded on restart, but
`npm run dev` works on a clean checkout with nothing installed. Set
`DB_STRICT=true` to make an unreachable database a hard failure instead.

## Scripts

Run from the repository root; each delegates to the right workspace.

| Command | What it does |
| --- | --- |
| `npm run dev` | API with watch mode and the Vite dev server |
| `npm run dev:all` | Adds the dedicated job worker (`CRON_IN_API=false`) |
| `npm run dev:server` / `npm run dev:client` / `npm run dev:worker` | One at a time |
| `npm run build` | Compile server, then build the client bundle |
| `npm run typecheck` | `tsc --noEmit` in both workspaces |
| `npm run lint` | ESLint in both workspaces |
| `npm test` | Vitest in both workspaces |
| `npm run seed` | Demo data (`npm run seed:reset` drops it first) |

`npm run test` runs each workspace's suite in turn. There is no root Vitest
config, so invoking `vitest` from the root is not meaningful.

## Demo accounts

Created by `npm run seed`. These have fixed, published passwords — development
only. The seed refuses to run against a production database without `--force`.

| Role | Email | Password |
| --- | --- | --- |
| Photographer | `photographer@lensflow.test` | `ChangeMe!Client123` |
| Client | `client@lensflow.test` | `ChangeMe!Client123` |
| Admin | `admin@lensflow.test` | `ChangeMe!Admin123` |

The photographer and client share one password on purpose (`SEED_PASSWORD`) —
logging in as each in turn is the fastest way to see the same project from both
sides. Override with `--password` / `--admin-password`, or the `SEED_*`
variables.

## How the pieces fit

### Tenancy

Every photographer is a tenant. Authorization is centralised in
`server/src/services/authorization.ts` rather than spread through route
handlers, so a query cannot forget to scope itself. A photographer's tenant is
derived from their verified token and can never be supplied by a request.

Cross-tenant reads return **404, not 403** — telling a caller that a resource
exists elsewhere is itself a leak.

### Private galleries and share links

A gallery is private by default. Two ways to reach one:

1. **Participation** — the photographer, the booked client, or an admin.
2. **A share link** — `/g/:token`, at <http://localhost:5173/g/TOKEN>.

Share links are the reason `sends a gallery to a friend` works: the recipient is
often not the person who booked the shoot and frequently has no account. A live
token grants read access to exactly one published gallery, and the server
re-checks it on every metadata request *and* every image byte, so the token
cannot be edited into someone else's gallery.

Two subtleties worth knowing, both covered by tests in
`server/src/tests/share-access.test.ts`:

- **`maxAccesses` counts gallery *opens*, not image requests.** A 60-photo
  gallery issues 120+ image requests per page view; counting those would exhaust
  any limit on the first visit.
- **Opening a gallery returns a short-lived `viewToken`.** Echoed back on photo
  reads, it lets someone who has already opened a gallery keep browsing once the
  limit is spent, without letting anyone else in.

Revoking a link stops it immediately: liveness, expiry and access limits are all
enforced on read, not on a schedule.

### The project timeline

Projects move through fixed stages (requested, confirmed, deposit, shoot,
editing, highlights, gallery, selection, delivery, complete). Transitions are
driven by real events by `server/src/services/timeline/engine.ts`, and
`reconcileProject` catches up stages whose trigger was missed — a stalled cron
tick is invisible to the user. Clients see only stages marked client-visible.

### Payments and email

`PAYMENT_PROVIDER=mock` exercises the real create/verify/refund code paths with
no gateway credentials, so checkout is fully testable offline. eSewa and Khalti
adapters are present for Nepalese gateways; set the credentials and switch the
provider to use them.

With `EMAIL_HOST` empty, outbound mail is written to `server/uploads/mail/*.eml`
so verification and notification emails can be read without a mailbox.

## Testing

```bash
npm test                      # both workspaces
npm test --workspace server   # API: models, auth, tenancy, realtime, payments
npm test --workspace client   # React: routing, harness-driven integration tests
```

Server tests use an isolated in-process MongoDB. Client tests drive the real
component tree through `MemoryRouter` with the API module mocked by
`src/tests/harness.ts`; that harness can also inject failures, which is how the
expired-link and error states are tested rather than assumed.

## Project layout

```
server/src
  config/         env parsing and validation
  models/         Mongoose schemas, indexes and denormalised counters
  routes/         HTTP surface, one router per resource
  services/       authorization, shares, timeline, storage, payments, notifications
  middleware/     auth, validation, uploads, rate limits, error envelope
  scripts/        seed
client/src
  components/     UI primitives, photo grid, viewer, timeline
  pages/          one file per route
  context/        auth session
  lib/            api client, socket, query, formatting
  tests/          harness and integration tests
```

## Configuration

Every variable is documented inline in `.env.example`. The ones most likely to
need changing:

| Variable | Notes |
| --- | --- |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Must be replaced. 15-minute access tokens, 30-day refresh with rotation |
| `MONGO_URI` | Falls back to in-memory MongoDB when unreachable in development |
| `STORAGE_DRIVER` | `local` writes to `UPLOAD_DIR`; `s3` is wired but needs `STORAGE_*` credentials |
| `ALLOW_CLIENT_DOWNLOADS` / `ALLOW_ORIGINAL_DOWNLOADS` | Project defaults; originals are off because they are full-resolution masters |
| `CRON_IN_API` | Set `false` when a dedicated worker owns the scheduler, so a scaled-out API does not run every job per replica |

Uploaded images are stored under `server/uploads/` when `STORAGE_DRIVER=local`.
That directory is disposable: every byte is also referenced by key in MongoDB and
re-derivable from a re-upload.