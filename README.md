# The Midtown Hotel — Backend

One NestJS + MongoDB backend serving both front-ends:

- **midtown-manager-react**: owner and front desk (rooms, day book, restaurant, back office)
- **midtown-guest-react**: guests on their phones (stay, folio, food orders, requests)

> **Status: Phase 1.** Project foundation, MongoDB connection, all Mongoose
> schemas with indexes, and an idempotent seed. No business endpoints yet.

## Stack

NestJS 11 · TypeScript · MongoDB 7 (replica set) · Mongoose 8 · Decimal128 for money (decimal.js in memory) · Docker Compose

## Prerequisites

- Node.js ≥ 20
- Docker with Compose v2

## Local setup

```bash
cp .env.example .env              # then edit secrets / owner details
npm install
npm run db:up                     # MongoDB single-node replica set "rs0"
npm run seed                      # safe to run any number of times
npm run start:dev                 # http://localhost:3000/api/v1/health
```

### MongoDB replica set

Transactions are mandatory, so MongoDB always runs as a replica set, even
locally. `docker compose up -d mongodb` starts `mongo:7.0` with `--replSet rs0`;
its healthcheck runs [docker/mongo/init-replica.js](docker/mongo/init-replica.js),
which calls `rs.initiate()` on first boot and reports healthy once the node is
PRIMARY. Data persists in the `midtown-mongo-data` volume.

The replica-set member is registered as `mongodb:27017`, its compose service name. So:

| Connecting from | `MONGODB_URI` |
|---|---|
| Host machine (`npm run start:dev`) | `mongodb://localhost:27017/midtown_hotel?directConnection=true` |
| Another compose container | `mongodb://mongodb:27017/midtown_hotel?replicaSet=rs0` |

If port 27017 is already in use, set `MONGO_HOST_PORT` (for example `27019`) in `.env`
and use that port in `MONGODB_URI`.

The app and the seed script check `hello.setName` at startup and **refuse to
run against a standalone mongod**. There is no non-transactional fallback.

## Seed

`npm run seed` builds all indexes, then upserts 4 room types, 18 rooms
(101–106, 201–206, 301–306), 16 menu items, 6 staff, 8 stock items and the
OWNER user from `OWNER_*` env vars, all in one transaction. Each document is
matched on its natural key with `$setOnInsert`, so re-running neither
duplicates records nor overwrites values the hotel has since edited.

> ⚠ The fixture values in [src/database/seed/seed-data.ts](src/database/seed/seed-data.ts)
> have **not yet been verified against the React apps**. Replace them with the
> front-ends' local-state data before go-live.

## Data conventions

- **Ids**: ObjectId in the database, `id` string in JSON (`_id` / `__v` never leave the API).
- **Money**: `Decimal128` in the database, `decimal.js` for arithmetic, JSON number on output only.
- **Business dates**: `'YYYY-MM-DD'` strings in the hotel timezone (`HOTEL_TIMEZONE`, Asia/Kolkata), not server dates.
- **Soft delete**: every collection has `deletedAt`. Default queries and
  aggregations exclude deleted docs; opt out with `.setOptions({ withDeleted: true })`.
- **Transactions**: multi-document writes go through `TransactionService.run()`
  (`session.withTransaction()`, auto-retry on transient errors); side effects
  such as socket emits are queued with `afterCommit()` and run only after commit.

## Environment variables

See [.env.example](.env.example). Every variable is validated at startup, and the app won't boot with a missing or invalid one.
