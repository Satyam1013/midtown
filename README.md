# The Midtown Hotel: Backend

One NestJS + MongoDB backend for The Midtown Hotel, Raigarh, serving both front-ends:

- **Manager app** ([midtown-admin](https://github.com/yashsakhla/midtown-admin)): front desk, day book, restaurant, back office
- **Guest app** ([midtown-hotel](https://github.com/yashsakhla/midtown-hotel)): stay, bill, food orders, requests

Docs: [database design](docs/DATABASE_DESIGN.md) · [front-end changes](docs/FRONTEND_CHANGES.md) · [endpoints workbook](docs/Midtown_API_Endpoints.xlsx)

## Stack

NestJS 11 · TypeScript · MongoDB 7 replica set · Mongoose 8 · Decimal128 + decimal.js for money · JWT · Socket.IO · Swagger · Jest · Docker Compose

## Prerequisites

Node.js 20 or newer, and Docker with Compose v2.

## Setup

```bash
cp .env.example .env     # set secrets and the OWNER_* details
npm install
npm run db:up            # MongoDB single-node replica set "rs0"
npm run seed             # safe to run repeatedly
npm run start:dev        # http://localhost:3000/api/v1/health
```

Swagger: `/api/docs`.

| Command | Purpose |
|---|---|
| `npm run start:dev` | Development server with reload |
| `npm run build`, `npm run start:prod` | Production build and run |
| `npm test` | All tests (needs the MongoDB container) |
| `npm run typecheck` | TypeScript check |
| `docker compose --profile app up --build` | Run the API in Docker too |

### MongoDB replica set

Transactions are mandatory, so MongoDB always runs as a replica set. The compose healthcheck runs [docker/mongo/init-replica.js](docker/mongo/init-replica.js), which initiates `rs0` on first boot and reports healthy once the node is PRIMARY. The app and seed **refuse to run against a standalone server**.

The member is registered as `mongodb:27017`, so:

| Connecting from | `MONGODB_URI` |
|---|---|
| Host machine | `mongodb://localhost:27017/midtown_hotel?directConnection=true` |
| Another compose container | `mongodb://mongodb:27017/midtown_hotel?replicaSet=rs0` |

If port 27017 is taken, set `MONGO_HOST_PORT` and use that port in the URI.

### Seed

Upserts 4 room types, 18 rooms, 16 menu items, 6 staff, 8 stock items and the OWNER from `OWNER_*`, in one transaction. Existing documents are never overwritten, so re-running keeps the hotel's edits; it also means changed `OWNER_*` values won't update an existing owner.

Values match the front-ends' `src/data/seed.js`. **Menu veg flags and descriptions aren't in either repo and still need confirming with the hotel.**

### Tests

`npm test` runs against the local container, in the dedicated `midtown_test` database, which it wipes. Set `TEST_MONGODB_URI` to use another replica set; the database name must end in `_test`.

## Authentication

| Who | How | Token |
|---|---|---|
| Staff | `POST /auth/staff/login` with phone or email + password | 12h access, 30d refresh via `POST /auth/refresh`; `POST /auth/logout` revokes both |
| Guest | `POST /auth/guest/request-otp`, then `verify-otp`, with room number + phone | Scoped to one stay; dead at check-out |
| Visitor | `POST /auth/guest/public-token` | Menu, room types, booking requests only |
| Public | None | `GET /public/room-types`; booking via `POST /public/bookings/request-otp` then `POST /public/bookings`, with the phone proven by OTP |

Send `Authorization: Bearer <token>`. Guest routes take no ids: the stay always comes from the token.

Responses are `{ data, meta }` and errors `{ statusCode, code, message }`. Login and refresh also repeat their tokens at the top level, because the manager app reads them there.

## Business rules

- **No double entries:** `POST /entries` answers `409 DUPLICATE_ENTRY` with `entryId`; a unique index covers simultaneous submissions.
- **Atomic money:** entry, cash line and folio line go through `TransactionService.run()`. Socket events fire only after commit.
- **Business day (shift):** money is posted only while a business day is open, and only one can be open at a time. Its `businessDate` is chosen at `POST /business-day/start`, not taken from the clock, so a shift can run past midnight. Every posting is stamped with the open day's date, and any date the app sends is ignored; with no open day it's `409 DAY_NOT_OPEN`. Close with `POST /business-day/close` and a cash count: closing = opening + credits − debits (all modes), expected cash = opening + net CASH movements, shortage = expected − counted, and a note is required for any difference. A closed day can't be edited by anyone; only the OWNER can reopen it.
- **Register:** `GET /daybook/register` lists every money line of a business day (entries and expenses) with its `source`; its totals equal `/daybook`'s. Only `MANUAL` entries are edited through `/entries`. At checkout, money still owed is stored as the settlement line's `shortfall` and stays on the folio.
- **Room status:** check-in → OCCUPIED, check-out → DIRTY, housekeeping → VACANT; manual changes only to and from OOO.
- **GST:** rooms 12%, food 5%, calculated on the server from database prices, to the paisa.
- **Business date:** `YYYY-MM-DD`. For money it's the open business day's date. Attendance and invoices still take the app's date: at most 7 days old and not in the future, unless OWNER.
- **Room pricing:** each room has a category (`AC` / `NON_AC`), a single and a double rate. Nightly rate: 1 guest → single, 2 → double, 3–4 → double + ₹300 per extra guest (`EXTRA_GUEST_CHARGE` in `src/config/pricing.ts`). The server always works the rate out; a rate sent by an app is ignored.
- **Room charges:** a stay is billed in segments (`roomCharges[]`), each one TARIFF folio line of rate × nights + 12% GST. A guest-count change or a room shift ends the current segment, so earlier nights keep their price.
- **Room shift:** only in answer to a guest's `ROOM_SHIFT` service request, via `POST /stays/:id/shift`. It moves the stay, swaps room statuses, adjusts the folio and closes the request in one transaction, with no day-book entry. Shifts and guest-count changes are written to `audit_logs`.
- **Soft delete:** every collection has `deletedAt`, excluded from default queries. Opt out with `.setOptions({ withDeleted: true })`.

## Socket.IO

Connect with `io(url, { auth: { token } })`. Staff join `hotel`; a guest joins only `stay:<id>`, and clients can't request a room. Payloads carry ids and status; refetch on receipt.

`kot.created` `kot.updated` `stay.updated` `folio.updated` `room.status.changed` `entry.created` `entry.updated` `daybook.closed` `service-request.created` `service-request.updated` `booking.created`

## Environment variables

See [.env.example](.env.example). Everything is validated at startup.

| Variable | Notes |
|---|---|
| `PORT`, `NODE_ENV`, `HOTEL_TIMEZONE` | |
| `MONGODB_URI`, `MONGODB_MAX_POOL_SIZE` | Must be a replica set |
| `MONGO_HOST_PORT` | Docker host port only |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | 32+ characters, different from each other |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | `12h`, `30d` |
| `OWNER_NAME`, `OWNER_PHONE`, `OWNER_EMAIL`, `OWNER_PASSWORD` | Seeded owner |
| `OTP_EXPIRY_MINUTES` | |
| `OTP_PROVIDER` | `console` (rejected in production), `msg91`, or `bypass` (temporary: no SMS, any 6 digits pass, room + phone must still match) |
| `SMS_API_KEY`, `SMS_TEMPLATE_ID`, `SMS_SENDER_ID` | Needed for `msg91` |
| `FRONTEND_MANAGER_URL`, `FRONTEND_GUEST_URL` | CORS; comma-separated, no trailing slash |

## Deployment: Render and MongoDB Atlas

**Atlas**
1. Create a cluster in Mumbai or Singapore and a database user.
2. Allow Render under Network Access. Without static outbound IPs this means `0.0.0.0/0`, so use a strong password.
3. Use `mongodb+srv://<user>:<password>@<cluster>/midtown_hotel?retryWrites=true&w=majority`.

**Render web service**
- Build: `npm ci --include=dev && npm run build`
- Start: `npm run start:prod`
- Health check path: `/api/v1/health`
- Set the environment variables above, with `NODE_ENV=production` and without `PORT`.

**Seed once**, from your machine, with `.env` holding the Atlas URI and real `OWNER_*` values: `npm run seed`.

**Per-guest pricing migration:** `npm run migrate:room-pricing` gives existing rooms `singleRate = doubleRate = rate` and existing in-house stays one room-charge segment. It is idempotent, and the app falls back the same way without it.

The app builds indexes at startup, shuts down gracefully and reconnects to MongoDB automatically.
