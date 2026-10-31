# Front-end changes needed for the Midtown backend

For the developers of `midtown-admin` (manager app) and `midtown-hotel` (guest app). File paths are relative to each repo's root, on `master`.

The backend is built to the API your data layers already call, so most screens need no change. The items below are what remains.

API base: `https://midtown-fip9.onrender.com/api/v1`. Swagger is at `/api/docs` on the same host once the new version is deployed.

## Required before go-live

### 1. Guest app: set the API URL (config only)
`VITE_API_URL` is unset on Vercel, so `src/lib/api.js:3` falls back to `/api/v1`, which returns 404 there.

Set `VITE_API_URL=https://midtown-fip9.onrender.com/api/v1` on the Vercel project and redeploy.

### 2. Manager app: load the kitchen queue from the server
`src/store/HotelContext.jsx:17` keeps KOTs in session state because no list endpoint existed. Guest orders therefore never appear, and the queue is lost on refresh.

- Load: `GET /kots?status=PLACED` (also `PREPARING`, `ON_THE_WAY`). Each row has `id`, `number`, `items[{ name, price, qty, note }]`, `status`, `roomNumber`, `guestName`, `tableLabel`, `source`, `billTo`, `total`, `createdAt`.
- Update: `PATCH /kots/:id/status` with `{ "status": "PREPARING" }`. Status only moves forward, otherwise `409 INVALID_KOT_STATUS`.
- Remove the local-only list and the "Preparing" status it assumes.

### 3. Manager app: fix "Room charge" on restaurant bills
`src/store/HotelContext.jsx:271` sends `mode === 'Room charge' ? 'Cash' : mode`. A bill charged to a room is recorded as **cash received**, which overstates the day book.

When "Room charge" is chosen, post `POST /kots` with `stayId` and `billTo: "ROOM"` and skip `/bills/settle`. The screen needs a way to pick the in-house room. If that isn't wanted, remove the option from `src/screens/FoodScreen.jsx:158`.

### 4. Manager app: load attendance
`src/store/HotelContext.jsx:18` keeps marks per session, so they look blank after a refresh. Load them with `GET /attendance?date=YYYY-MM-DD`, which returns `[{ staffId, businessDate, mark }]`.

### 5. Manager app: send the working date at check-in
`src/store/HotelContext.jsx:169` doesn't send the date, so the server uses today. If the front desk has set a different working date, the stay starts on the wrong day.

Add `businessDate: form.date` to the `POST /stays` body.

### 6. Both apps: use the server's GST figures
Food GST is rounded to whole rupees in the apps but calculated to the paisa on the server. On ₹90 the apps show ₹5 and the server charges ₹4.50, so printed bills can differ from stored totals.

Show the `taxable`, `cgst`, `sgst` and `total` returned on each KOT and invoice. Keep the local figure only as a preview.

- Manager: `src/screens/FoodScreen.jsx:28`, `src/lib/print.js:35`, `src/lib/print.js:67`, `src/sheets/OpsSheets.jsx:311`
- Guest: `src/lib/selectors.js:8`

## New screens for features the backend now provides

### 7. Manager app: guest service requests
Guests can send requests, but no staff screen shows them.

- `GET /service-requests?status=SENT` returns `[{ id, stayId, roomNumber, guestName, key, label, note, status, createdAt }]`.
- `PATCH /service-requests/:id` with `{ "status": "IN_PROGRESS" }` or `"DONE"`.
- A `key` of `checkout` is a guest's check-out request.

### 8. Manager app: guest feedback (OWNER and MANAGER)
`GET /feedback` returns `[{ stayId, roomNumber, guestName, rating, text, createdAt }]`. STAFF gets `403`, so show this only to OWNER and MANAGER.

### 9. Manager app: optional owner tools
- User management: `GET /users`, `POST /users`, `PATCH /users/:id`.
- Tariff: `GET /room-types`, `PATCH /room-types/:id` with `{ "tariff": "2800.00" }`.
- Sign out everywhere: `POST /auth/logout`.
- Server reports: `GET /reports/:key?date=&format=xlsx`. The existing browser exports can stay.

## Recommended

### 10. Live updates with Socket.IO (both apps)
Neither app has a Socket.IO client. The guest app polls every 20 seconds and the manager app only reloads after its own actions, so new orders and requests don't appear on their own.

```js
import { io } from 'socket.io-client';
const socket = io('https://midtown-fip9.onrender.com', { auth: { token: accessToken } });
socket.on('kot.created', reload);
```

Staff receive all events. A guest receives only their own stay's `kot.*`, `stay.updated`, `folio.updated` and `service-request.*`. Payloads carry ids and status only, so refetch on receipt.

Other events: `room.status.changed`, `entry.created`, `entry.updated`, `daybook.closed`, `booking.created`.

### 11. Manager app: make check-in with advance one step
`src/store/HotelContext.jsx` calls `POST /stays` and then `PATCH /stays/:id` for the advance. If the second call fails, the guest is checked in with no advance. The toast shows the error, but staff need to re-enter the payment from Edit Stay. Check-out with a final payment has the same two-step pattern.

## Behaviour to expect

- **Duplicate rule on stay payments:** a second payment of the same type and amount for the same guest, room and date returns `409 DUPLICATE_ENTRY` with `entryId`. This is the client's rule. Change the amount or edit the existing entry.
- **Closed days:** posting to a closed date returns `409 DAY_CLOSED` for everyone except OWNER.
- **Date limits:** future dates, or dates over 7 days old, return `400` (`FUTURE_DATE`, `DATE_TOO_OLD`) unless OWNER.
- **Rate at check-in:** only OWNER can check in at a rate other than the room's; others get `403 RATE_OVERRIDE_FORBIDDEN`. The app's current behaviour of sending the room rate is fine.
- **Checked-out guests:** the guest's token returns `401 STAY_ENDED`, and the app's existing 401 handling signs them out.
- **Guest booking list:** the backend has no endpoint for a guest to list their booking requests, so that list is lost on refresh.
- **Online orders:** these don't post to the day book, because platform payouts aren't cash on the day.

## Not tested yet

The backend's integration tests cover the API these apps call, but neither app has been run against it in a browser. Please check each screen once the backend is deployed.
