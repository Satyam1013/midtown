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

### 8. Manager app: guest feedback (ADMIN and MANAGER)
`GET /feedback` returns `[{ stayId, roomNumber, guestName, rating, text, createdAt }]`. STAFF gets `403`, so show this only to ADMIN and MANAGER.

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

## Room categories, guest pricing and room shifts (manager and guest apps)

All additive: existing calls keep working.

**Rooms**
- `GET /rooms` now returns `category` (`AC` / `NON_AC`, or `null` on older rooms), `singleRate`, `doubleRate` (`rate` = `singleRate`) and `roomType.category`.
- `POST /rooms`: `{ number, floor, category, roomType: "AC Deluxe", singleRate, doubleRate }`. Both rates are required with a category. Errors: `TYPE_CATEGORY_MISMATCH`, `RATES_REQUIRED`. The old body still works.
- `PATCH /rooms/:id` (ADMIN): any of `category`, `roomType` or `roomTypeId`, `singleRate`, `doubleRate`. Stays in progress keep their rate.
- Types: `Non AC Standard`, `Non AC New Standard` (NON_AC); `AC Standard`, `AC Deluxe`, `AC Executive` (AC). The four original types stay, so existing rooms need moving to the new types.

**Stays**
- `POST /stays`: send `guests` (1–4). Any `rate` sent is ignored; the response has the server's rate.
- `PATCH /stays/:id`: `{ guests, businessDate }` reprices nights from `businessDate` onwards.
- `currentStay` (in `GET /rooms`) and every stay response include `guests`, `rate`, `nights`, `roomCharges[]` and `shifts[]`:
  - `roomCharges[]`: `{ label, roomNumber, guests, rate, nights, amount, billed }`, where `amount` = rate × nights before GST and `billed` = that plus 12% GST.
  - `shifts[]`: `{ fromRoomNumber, toRoomNumber, fromRate, toRate, kind, date, nightsBefore, adjustment }`.
- Check-out returns `bill: { roomCharges, food, otherCharges, payments, total }`.

**Room shift**
- Guest app: `POST /guest/service-requests` with `{ "key": "ROOM_SHIFT", "note": "..." }`. A second open one returns `409 SHIFT_REQUEST_OPEN`.
- Manager app: a ROOM_SHIFT request in the requests list gets two actions:
  - Shift: `POST /stays/:stayId/shift` with `{ requestId, toRoomId, guests, businessDate, time, reason }`. Errors: `400 INVALID_SHIFT_REQUEST`, `409 SHIFT_REQUEST_CLOSED`, `409 ROOM_NOT_VACANT`, `400 NO_NIGHTS_LEFT`.
  - Reject: `PATCH /service-requests/:id` with `{ "status": "REJECTED", "remark": "..." }`. The remark is required.
  - Marking a ROOM_SHIFT request `DONE` through `PATCH` returns `409 USE_SHIFT_ENDPOINT`.
- New request statuses `REJECTED` and `EXPIRED` (open shift requests expire at check-out). Show them, and the `remark`, in both apps.

## Business day, unified register and shortage (manager app)

**⚠️ Required at once:** after this backend deploys, every money action returns `409 DAY_NOT_OPEN` until someone starts a business day. That covers entries, expenses, stay payments, checkout, bills, online orders and request charges.

**Business day**
- `GET /business-day/current` returns `{ status: OPEN|CLOSED|NONE, businessDate, openedAt, openedByName, openingBalance, lastClosingBalance, lastClosedDate, suggestedNextDate }`. Show this in the header in place of the "Today" working-date picker.
- `POST /business-day/start` takes `{ businessDate, openingBalance, time, note }`. `note` is required when the opening balance differs from `lastClosingBalance`. Errors: `409 DAY_ALREADY_OPEN`, `409 DAY_ALREADY_CLOSED`, `400 NOTE_REQUIRED`. STAFF, MANAGER and ADMIN can start.
- `POST /business-day/close` takes `{ businessDate, countedCash, note, time }`. `note` is required when there's a shortage or excess (`400 NOTE_REQUIRED`). ADMIN and MANAGER only.
- `POST /business-day/reopen` takes `{ businessDate, note }`. ADMIN only.
- `GET /daybook?date=` adds `status, openedAt, openedByName, closedAt, closedByName, expectedCash, countedCash, shortage, closeNote`.
- `PATCH /daybook/opening` works only while that day is open and takes an optional `note`.

**Postings**
- The app's `businessDate` is ignored on new postings; the server stamps the open day. Keep sending it if convenient, or drop it.
- `POST /stays` takes an optional `advance: { amount, mode, time, narration }`. It's posted with the check-in, replacing the separate `PATCH` for the advance.
- `POST /stays/:id/checkout` takes `payment: { amount, mode, time, narration }`. The response has `shortfall` (amount still owed) and `bill`. Use this in place of a `PART_PAYMENT` before checkout.
- `POST /service-requests/:id/charge` takes `{ amount, billTo: ROOM|PAY_NOW, mode, time }`. `mode` is required for `PAY_NOW`. One charge per request.

**Register**
- `GET /daybook/register?date=` returns every money line sorted by time: `{ id, kind: entry|expense, source, time, roomNumber, guestName, phone, vehicle, type, mode, dc, amount, narration, shortfall }`.
- Sources: `MANUAL`, `CHECKIN`, `CHECKOUT`, `STAY_PAYMENT`, `RESTAURANT`, `ROOM_SERVICE`, `ONLINE`, `REQUEST`, `EXPENSE`, `REFUND`. This replaces the app's own merge of entries, cash and expenses in `src/api/mappers.js`.
- `GET /entries?date=` adds `source` and `shortfall`. Only `MANUAL` entries can be edited or deleted; others return `400 ENTRY_NOT_EDITABLE` naming their origin, so hide the edit button for them.
- `GET /expenses?date=` now includes `time`.
- `GET /expenses/summary?date=` returns `{ total, count, byHead[] }`.
- `GET /daybook/shortages?from=&to=` returns `{ days[], entries[] }` (ADMIN, MANAGER).

## Customers, ID documents, adding a guest (manager app)

**Check-in**
- Look the phone up first with `GET /customers/lookup?phone=`. It returns `{ customer: { id, name, phone, visits, hasDocument, documentType } }`, or `{ customer: null }` for a new phone.
- `POST /stays` takes an optional `customerId`. Without it, the server matches by phone or creates a customer.
- The response adds `customer: { id }`, and `stay.customerId`.
- Upload the ID afterwards with `POST /customers/:id/documents`, as `multipart/form-data` with fields `type` (`AADHAAR`, `DRIVING_LICENCE`, `PASSPORT`, `VOTER_ID`, `PAN` or `OTHER`), `number` (optional) and `file`.
  - Accepts JPG, PNG, WEBP, HEIC or PDF, at most 5 MB. The real file content is checked, not the extension.
  - Errors: `400 UNSUPPORTED_FILE`, `413` (file too large), `400 FILE_REQUIRED`.

**Documents**
- Every document comes back as `{ id, type, numberLast4, fileName, mimeType, size, fileUrl, fileUrlExpiresIn, createdAt }`. The full ID number is never returned.
- `fileUrl` is a path such as `/api/v1/files/customer-documents/…?exp=…&u=…&sig=…`. Put the API origin in front and use it directly in `<img>` or a new tab; it needs no token. It expires after 5 minutes, so refetch the customer for a fresh link.
- `DELETE /customers/:id/documents/:docId` is ADMIN and MANAGER only.

**Customers screen**
- `GET /customers?search=&filter=repeat|nodoc|all&limit=&cursor=` returns `[{ id, name, phone, email, visits, totalSpent, lastVisitAt, hasDocument, documentType }]`, newest visit first. Pass `meta.nextCursor` as `cursor` for the next page.
- `GET /customers/:id` returns the profile plus:
  - `documents[]`
  - `stays[]`: `{ id, role: MAIN|ADDED, roomNumber, roomType, checkInDate, checkOutDate, nights, guests, total, paid, balance, status }`
  - `payments[]`
- `PATCH /customers/:id` edits `{ name, phone, email, notes }`. A phone belonging to another customer returns `409 CUSTOMER_PHONE_EXISTS` with `existingCustomerId`; offer a merge.
- `POST /customers/:id/merge` takes `{ intoCustomerId }` (ADMIN, MANAGER) and moves stays and documents into the other customer.

**Add a guest to a stay**
- `POST /stays/:id/guests` takes `{ name, phone, guests (new total), businessDate, time }`. Any `rate` sent is ignored.
- The response is `{ stay, guest: { id, customerId }, adjustment }`. `adjustment` is (new rate − old rate) × nights left, before GST. No cash entry is made; the folio changes.
- Errors: `409 GUEST_LIMIT` (already 4, or more than 4), `400 INVALID_GUEST_COUNT` (not more than now), `409 STAY_NOT_IN_HOUSE`.
- `currentStay.guestList[]` in `GET /rooms` lists the added guests with the price change.

## Maintenance, room edit, split checkout, GST bills, bill prints (manager app)

**⚠️ GST change:** new check-ins are charged room GST at 5% (up to ₹7,500 a night) or 18% (above), added on top, in place of the flat 12%. Food stays at 5%; service-request charges now add 18%. Guests already checked in keep 12%. Show the server's figures; don't compute GST in the app.

**Maintenance**
- `PATCH /rooms/:id/status` takes `{ status: "MAINTENANCE", reason, expectedBackDate }`. It's allowed from VACANT or DIRTY; an occupied room returns `409 ROOM_OCCUPIED`.
- To end maintenance, send `{ status: "VACANT" }`. This clears the maintenance fields.
- `GET /rooms` returns `maintenanceReason` and `maintenanceUntil`.
- A maintenance room can't be checked into or shifted to (`409 ROOM_NOT_VACANT`), and isn't counted for bookings (`409 NO_ROOMS_AVAILABLE`).
- Room types gain `totalRooms` (rooms that can be sold) and `availableRooms` (VACANT or DIRTY now). This includes the guest app's `GET /public/room-types`.
- `GET /rooms/maintenance-history?roomId=` (ADMIN, MANAGER) lists past and current maintenance periods.

**Room edit**
- `POST /rooms` and `PATCH /rooms/:id` accept `features` (from the fixed list in `ROOM_FEATURES`: "AC", "TV", "Hot water / geyser", "Wi-Fi", "Attached bathroom", "Balcony", "Double bed", "Twin beds", "Extra bed available", "Fridge", "Sofa / seating", "Work desk", "Power backup", "Window view") and `description`.
- `PATCH /rooms/:id` also takes `floor`, `number` and `rate`:
  - `number` can only change while the room has no stays; otherwise `409 ROOM_HAS_STAYS`.
  - `rate` is the same as `singleRate`.
- Stays in progress keep their rate after a price change.

**Checkout with split payment**
- `POST /stays/:id/checkout` takes `{ payments: [{ mode, amount, time, narration }] }`, with 1–10 rows. Modes can repeat.
- Each row posts its own "Part payment" line; all rows and the checkout succeed or fail together.
- If the total collected is short, the last row carries `shortfall`.
- The response adds `entries[]` and `finalBill`.
- This replaces the separate `PATCH { payment }` calls before checkout. The single `payment` still works, but don't send both.

**Bill**
- `GET /stays/:id/bill` returns:
  - Header: `{ billNo, billDate, provisional, hotel: { name, gstin }, guest and room fields }`
  - `sections: [{ key: STAY|FOOD|OTHER, sac, gstRate, lines: [{ description, qty, rate, amount, gstRate }], taxable, cgst, sgst, total }]`
  - Totals: `taxable, cgst, sgst, total, payments: [{ mode, amount }], paid, balance`
- `billNo` is null (`provisional: true`) until check-out.
- `POST /bills/settle` now returns `taxable, cgst, sgst, gstPct, sac, gstin` too.

**Bill prints**
- `POST /stays/:id/bill-prints` takes `{ type: MANUAL|GENERATED, which: combined|stay|food|other|separate, amounts: { stay, food, other }, actualAmounts: { stay, food, other } }` and returns `201`. It records the print and changes nothing else.
- `GET /stays/:id/bill-prints` (ADMIN, MANAGER) lists them.
- The report `GET /reports/manual-bills?date=` lists manual bills printed that day.

## Guest app: one customer, many bookings

**Sign-in**
- `POST /auth/guest/request-otp` takes `{ phone }`. A `roomNumber` is accepted and ignored.
- `POST /auth/guest/verify-otp` takes `{ phone, otp }` and returns `{ accessToken, customer: { id, name, phone } }`. Any phone can sign in.
- Rate limits: `429 OTP_TOO_SOON` within 30 s of the last OTP, `429 TOO_MANY_REQUESTS` after 5 OTPs in 15 minutes.
- The token lasts 180 days and survives check-out. A bad token returns `401`.

**Endpoints** (customer token)
- `GET /guest/me`
- `GET /guest/bookings` returns `{ bookings: [...] }`, newest first. Each booking has `rooms[]`.
  - Rooms the desk hasn't assigned yet have `stayId: null` and `roomNumber: null`.
  - Each booking also has `billNos[]`.
- `GET /guest/bookings/:id/folio` returns lines with `roomNumber`. Another customer's booking returns `404`.
- `POST /guest/bookings` creates a booking with no OTP. It returns `{ booking: { id, ref, status, amount } }`.
- `POST /guest/orders` takes `{ stayId, items, billTo, note }` and returns `{ kot, roomNumber }`. `GET /guest/orders` gives each order a `roomNumber`.
- `POST /guest/service-requests` takes `{ key, note, stayIds }`. One request is made per room, with a shared batch.
  - Returns one row: `{ id (batch), key, label, status, note, remark, createdAt, rooms: [{ requestId, stayId, roomNumber, status }] }`.
  - The row's `status` is the room status if all rooms match, else the least finished one (SENT before IN_PROGRESS before DONE).
- `POST /guest/checkout-request` takes `{ note, stayIds }` and returns the same row shape.
- `POST /guest/feedback` takes `{ rating, text, bookingId }`.
- Errors:
  - `400 INVALID_STAY`: a room that isn't yours.
  - `400 STAY_NOT_ACTIVE`: a room that isn't checked in.
  - `400 STAY_REQUIRED`: an empty list.
  - `400 BOOKING_NOT_STAYED`: feedback before check-in.
- Removed: `GET /guest/stay` and `GET /guest/folio`.
- A visitor (public) token can no longer `POST /guest/bookings`; visitors use `POST /public/bookings` with an OTP.

## Room photos, menu/stock/staff creation, customer credit, expenses on credit (manager app)

**Photos**
- Room photos: `POST /rooms/:id/images` (multipart, field `file`) returns `{ id, url, sortOrder }`. `DELETE /rooms/:id/images/:imageId` removes one.
- Menu photo: `POST /menu/:id/photo` (multipart, field `file`) returns the item with `photoUrl`.
- Rules for both: JPG, PNG or WEBP, at most 5 MB. The real file content is checked. Errors: `400 UNSUPPORTED_FILE`, `413`.
- `GET /rooms` and the new `GET /rooms/:id` include `images: [{ id, url }]`.
- A `url` is a path (`/api/v1/files/images/…`): put the API origin in front. It's public, needs no token, and doesn't expire.

**Menu, stock, staff**
- `POST /menu` (ADMIN, MANAGER) takes `{ name, description, price, category, isVeg, available }`. A name already in that category, ignoring case, returns `409 MENU_ITEM_EXISTS`.
- `POST /stock` takes `{ item, category, unit, qty, minQty, rate }`. An opening quantity is recorded as an "Opening stock" movement. A duplicate name, ignoring case, returns `409 STOCK_ITEM_EXISTS`.
- `POST /staff` (ADMIN, MANAGER) takes `{ name, role, shift, phone, salary }`. `GET /staff` includes `phone`.

**Customer credit (udhaar)**
- `POST /customers/:id/credit` takes one of:
  - `{ kind: "CHARGE", amount, narration, businessDate, time }`: no money moves, and no open day is needed.
  - `{ kind: "PAYMENT", amount, mode, narration, time }`: needs an open day. It posts a receipt (`source: CUSTOMER_CREDIT`) on the open day.
- It returns `{ entry, creditBalance, receipt }`.
- Errors: `409 CREDIT_EXCEEDED` (more than is owed), `400 MODE_REQUIRED`.
- `GET /customers` items include `creditBalance` and `dueAmount`. `GET /customers?hasCredit=true` (or `hasDue=true`) lists only customers who owe money.
- **`dueAmount`** is what the customer owes, as a 2-decimal string (`"2600.00"`, `"0.00"` when nothing is due).
  - It equals credit (udhaar) charges minus payments against them. A charge is given with `POST /customers/:id/credit` or by moving a checkout's unpaid balance to credit.
  - `GET /customers/:id` returns the same field with the same value.
  - The figure is the customer's `creditBalance`, which is updated in the same transaction as every credit ledger entry. The list reads it straight from the customer record, so there's no per-customer query.
  - It never goes negative, because a payment above what's owed is refused (`409 CREDIT_EXCEEDED`). That's also why there is no `advanceBalance`.
  - It doesn't include the open folio of a stay in progress, because that is the stay's bill (`GET /stays/:id/bill`), not credit.
- **`sort=due_desc`:** lists the customers who owe most first. `meta.nextCursor` follows that order. The default `sort=recent` is by last visit.
- **Merge:** merging customers also moves the credit ledger and adds the balances together.
- `GET /customers/:id` adds `creditBalance` and `creditEntries[]`, newest first.
- `POST /stays/:id/checkout` takes `creditAmount` to move unpaid money onto the customer's credit. The bill shows it under payment mode `CREDIT`. More than is unpaid returns `400 CREDIT_TOO_HIGH`.

**Expenses on credit (udhari)**
- `POST /expenses` with `{ onCredit: true, vendor, dueDate, head, amount, time, narration }` and no `mode`. No money moves.
  - Errors: `400 VENDOR_REQUIRED`, `400 MODE_NOT_ALLOWED`. A normal (cash) expense still needs `mode`.
- In `GET /daybook/register`, a credit expense line has `informational: true`. **Leave it out of totals**; the day-book figures already do.
- `POST /expenses/:id/payments` takes `{ amount, mode, time, narration }` and needs an open day. It posts a DEBIT entry (`source: EXPENSE_PAYMENT`). More than is due returns `400 PAYMENT_TOO_HIGH`.
- `GET /expenses?status=DUE` lists every credit expense with money still due, across dates, for the Payables screen.
- Expenses now include `onCredit`, `paidAmount`, `dueAmount`, `dueDate` and `payments[]`.

**Reports:** `receivables` and `payables`, with ageing (0-30, 31-60, 61-90, 90+ days). Payables also shows overdue amounts and the next due date.

## One register row per check-out (manager app)

**Check-out is one call:** `POST /stays/:id/checkout` with:
```
{ time, narration,
  payments: [{ mode, amount }],
  adjustments: [{ kind, value, section, amount, reason }],
  creditAmount }
```
- **Idempotency:** send an `Idempotency-Key` header. A retry or double tap returns the first result and posts nothing twice.
- **Adjustments:**
  - `kind` is `DISCOUNT`, `COMPLIMENTARY` (both reduce the bill) or `HALF_DAY` (adds to the stay).
  - `section` is `STAY`, `FOOD` or `OTHER`.
  - `amount` is the change to the bill, GST included. GST follows the section's rate.
  - More off than the section's charges returns `400 ADJUSTMENT_TOO_HIGH`.
- **Response:** includes `settlement`, the register-row shape below.
- **Older apps:** `PATCH /stays/:id { payment }` just before check-out still works. Payments made in the two minutes before check-out join that check-out's row.

**Register row for a check-out** (in `GET /daybook/register`, `GET /entries`, customer `payments` and the daily and day-book reports):
```
{ id (settlement), kind: "entry", source: "CHECKOUT", type: "Check-out",
  time, roomNumber, guestName, phone, vehicle, stayId, customerId,
  mode: "CASH" | "MIXED" | null, dc: "CREDIT",
  amount (collected), billTotal, shortfall (null when fully paid), creditAmount,
  narration (what the user typed), payments: [{ mode, amount }] }
```
- There's no separate payment row and no zero-amount row any more. Build the "short by" text from `shortfall`.
- `GET /daybook` adds `checkoutShortfall` and `checkoutsShort`.
- Totals don't change: the per-mode ledger rows are still posted and used for the cash, UPI, card and bank totals and for expected cash.

## Occupancy pricing by room type (guest and manager apps)

**Room types** (in `GET /public/room-types`, `GET /guest/room-types` and `GET /room-types`)
- New fields `singleRate`, `doubleRate`, `additionalGuestRate`, all per night with GST excluded. They're numbers, and `tariff` equals `singleRate`.
- Types not priced yet return `null` rates, and booking them returns `409 NO_PRICE`.
- `POST /room-types` (ADMIN) takes `{ name, category, sleeps (1-4), singleRate, doubleRate, additionalGuestRate, beds, size, blurb, perks, sortOrder }`.
- `PATCH /room-types/:id` (ADMIN) takes any of the same fields. `tariff` is still accepted as the older name for `singleRate`.
- Rules: `doubleRate` must be at least `singleRate` (`400 INVALID_RATES`), and `additionalGuestRate` must be 0 or more.

**Pricing:** every booking is priced on the server.
- Guests are split evenly across rooms, earlier rooms first: 5 guests in 2 rooms is 3 + 2.
- Per room, per night: 1 guest pays `singleRate`, 2 pay `doubleRate`, and 3 or more pay `doubleRate + (guests − 2) × additionalGuestRate`.
- Errors: `400 TOO_FEW_GUESTS` (a room with no guest), `400 TOO_MANY_GUESTS` (more than rooms × sleeps).
- Front-desk `amount` is ignored, except for OTA sources (MakeMyTrip, Booking.com, Goibibo, Agoda, Airbnb), where it's required and kept.
- Bookings store `roomLines: [{ guests, rate }]`. In the guest app this is `booking.rooms[].guests` and `rooms[].rate`.
- At check-in against a booking, the booked rate is charged, even if the tariff changed since. If the desk changes the guest count, the booking's own price card is used.

**Quote:** `POST /public/bookings/quote` (no token) and `POST /guest/bookings/quote`.
- Body: `{ roomTypeId, rooms, pax, arrivalDate, departureDate }`.
- Returns `{ nights, perRoom: [{ guests, ratePerNight }], amount, gstIncluded: false }`.
- It uses the same calculation as the booking.

**GST:** all these rates and amounts exclude GST. GST is added at check-in on the folio: 5% for rooms up to ₹7,500 a night, 18% above. The bill (`GET /stays/:id/bill`) shows CGST and SGST separately.

## Room details and per-room extra-guest price (manager and guest apps)

**Room fields:** `POST /rooms` and `PATCH /rooms/:id` take `beds`, `blurb`, `size`, `sizeSqft`, `sleeps` and `additionalGuestPrice`.
- On `PATCH`, a missing field is left unchanged, and `null` or `""` clears it.
- `GET /rooms` and `GET /rooms/:id` return all six fields.
- Validation:
  - `sizeSqft`: null or more than 0.
  - `sleeps`: null or a whole number from 1 to 10.
  - `additionalGuestPrice`: null or 0 or more (a number or a string).
  - `blurb`: at most 500 characters. `beds` and `size`: at most 80.

**Pricing per room** (check-in, adding a guest, room shift):
- 1 guest pays the single rate. 2 or more pay the double rate, plus `(guests − 2) × (room.additionalGuestPrice ?? 300)`.
- A shift uses the **target** room's price and capacity.
- A rate sent by the app is ignored; the server's figure is used.
- Running stays keep their rate. A change to a room's price affects only future check-ins and future added guests.

**Capacity:** a room takes at most `sleeps` guests, or 4 when `sleeps` isn't set.
- Too many guests returns `400 TOO_MANY_GUESTS`, "Room 106 sleeps at most 3 guests".
- When adding a guest, it returns `409 GUEST_LIMIT` with the same message.

**Guest room types:** `GET /guest/room-types` and `GET /public/room-types` also return `additionalGuestPrice`, the same value as `additionalGuestRate`. `beds`, `blurb`, `size`, `sizeSqft` and `sleeps` were already there.

**Bookings** are by room type, since no room is chosen yet, so they use the room type's prices. At check-in, the booked rate is charged.

## Bookings with a line per room (guest, public and desk)

**Request:** `POST /guest/bookings`, `POST /public/bookings` (plus `otp`) and `POST /bookings` take:
```
{ guestName, phone, arrivalDate, departureDate, note, pax,
  rooms: [{ roomTypeId, guests }, ...] }
```
- Room types can be mixed in one booking.
- The older shape (`roomTypeId`, `rooms` as a number, `pax`) is still accepted. Guests are then split evenly, earlier rooms first.

**Validation**
- `400 BULK_BOOKING` for more than 10 rooms: "For bulk booking, please contact the front desk."
- `400 TOO_MANY_GUESTS`: "AC Standard sleeps 4 — max 4 guests per room".
- `400 PAX_MISMATCH` when `pax` isn't the sum of guests.
- `400 TOO_FEW_GUESTS` for an empty room.
- `409 NO_PRICE` for an unpriced room type, and `409 NO_ROOMS_AVAILABLE` for more rooms of a type than can be sold.
- Arrival can't be in the past, and the stay must be 1–30 nights. The front desk has no 30-night limit.
- Errors use the usual `{ statusCode, code, message }`.

**Pricing per line, per night:** 1 guest pays `singleRate`, 2 pay `doubleRate`, and 3 or more pay `doubleRate + (guests − 2) × additionalGuestRate`. The amount is the sum × nights, with GST excluded.

**Response**
```
{ booking: { id, ref, status, amount, nights,
  rooms: [{ lineId, stayId: null, roomTypeId, roomType, guests, rate }] } }
```
- `stayId` is null until the desk checks a room in. Check-in takes the booking's next free line of that room's type, else any free line, and charges its stored rate.
- `GET /guest/bookings` lists checked-in rooms with their `stayId`, and the rest with `stayId: null` and their `lineId`.

**Quote:** `POST /public/bookings/quote` and `POST /guest/bookings/quote` take `{ rooms: [{ roomTypeId, guests }], arrivalDate, departureDate }`. They return `{ nights, rooms: [{ roomTypeId, roomType, guests, ratePerNight }], amount }`; `perRoom` is the same list under its older name.

## Roles: ADMIN and MANAGER (manager app)

The owner account is now `ADMIN` (it was `OWNER`). Hiding controls in the app is not enough on its own; the API enforces every rule below. The role comes only from the verified token and the user record, never from a request body.

**Login:** `POST /auth/staff/login` returns `{ accessToken, refreshToken, user: { id, name, phone, email, role } }`, and the access token carries `role`. A token without a role, or with a role the user no longer has, gets `401 INVALID_TOKEN`; sign in again.

**ADMIN only.** Anyone else gets `403 { code: "FORBIDDEN", message: "Admin access required" }`:
- `POST /rooms`, `PATCH /rooms/:id` (prices, category and type, floor, features, description, beds, size, sleeps)
- `POST /rooms/:id/images`, `DELETE /rooms/:id/images/:imageId`
- `POST /room-types`, `PATCH /room-types/:id`
- `DELETE /rooms/:id` (new)

**Still open to MANAGER:** reading rooms, `PATCH /rooms/:id/status` and `POST /rooms/mark-all-clean`.

**`DELETE /rooms/:id`:**
- Returns `409 ROOM_IN_USE` while a guest is in the room. Check out or shift the guest first.
- A room with history (stays, register lines or maintenance) is soft-deleted. It drops out of `GET /rooms` and can't be checked into, but old bills and registers still show its number. The number can't be reused.
- A room with no history is removed for good.
- Returns `{ id, number, deleted: true, soft }`. Every delete is written to the audit log with who, when and which room. Sockets get `room.deleted` with `{ roomId, number }`.

**Day book and cash: MANAGER and STAFF see only the open business day.** This covers `GET /daybook`, `/daybook/register`, `/daybook/shortages`, `/entries`, `/expenses`, `/expenses/summary`, `/invoices`, `/online-orders` and `/reports/:key`.
- A `date`, `from` or `to` other than the open day returns `403 PAST_DATE_RESTRICTED`.
- With no date, the open day is used. Lists that used to cover every date (`/expenses`, `/expenses?status=DUE`, `/invoices`, `/online-orders`) show the open day only.
- With no day open, these answer empty data: `null` for `/daybook`, `[]` for the register and entries, an empty page for paged lists, and `rows: []` for reports.
- Changing another day returns `403 PAST_DATE_RESTRICTED`. This covers `PATCH` and `DELETE /entries/:id` for an entry from another day, `PATCH /daybook/opening` for another date, and `POST /invoices` dated another day.
- ADMIN can read any date. A closed day still can't be edited by anyone (`409 DAY_CLOSED`), so an ADMIN reopens it first.

## Photos on DigitalOcean Spaces

- **Uploads:** nothing changes for the apps. Uploads use the same endpoints, and every response still carries `url` / `photoUrl`.
- **Links:** with Spaces turned on, a photo's `url` is a full CDN link (`https://midtown-media.sgp1.cdn.digitaloceanspaces.com/images/<id>`) instead of `/api/v1/files/images/<id>`.
  - Use it as it is; don't prefix the API base URL when it already starts with `https://`.
  - Old relative links still work and redirect.
- **ID documents:** unchanged. They open only through the signed links from `GET /customers/:id`.

## Inventory: edit and delete stock items (manager app)

- **Units:** `unit` is free text, kept exactly as sent (kg, g, litre, ml, qty, pcs, box, packet, dozen, bottle, bag, carton, can, roll, set, pair, metre …). It was never limited to a list.
- **`PATCH /stock/:id` (ADMIN, MANAGER):** takes any of `{ item, category, unit, qty, minQty, rate }`.
  - `qty` is the stock level now. If it differs, an `ADJUSTMENT` movement for the difference (reason "Edited from inventory page", who and when) is written in the same transaction.
  - A name already used, in any case, returns `409 STOCK_ITEM_EXISTS`.
  - An empty name or a negative number returns `400`.
  - The response has the same shape as a row of `GET /stock`.
- **`DELETE /stock/:id` (ADMIN only):**
  - Returns `204`, or `404` if not found.
  - Soft delete (`deletedAt`, `deletedByUserId`): the item drops out of `GET /stock` and the stock report, and its movements stay.
  - The name can be used again.
  - The audit log keeps who, when, the item and its last quantity.
- **`POST /stock/:id/adjust`:** unchanged. A delta that would take stock below zero is refused with `409 INSUFFICIENT_STOCK`, not clamped. Movements now carry `type` (`OPENING` / `ADJUSTMENT`).

## Staff and attendance (manager app)

- **`GET /attendance?date=` or `?from=&to=`, with optional `&staffId=`:**
  - Returns `[{ staffId, businessDate, mark: "P" | "A" | "L", … }]`, one row per marked person-day.
  - Range errors: at most 366 days (`400 RANGE_TOO_LONG`), real dates only (`400 INVALID_DATE`), `from` not after `to` (`400 INVALID_RANGE`), and a date is required (`400 DATE_REQUIRED`).
  - Reading isn't limited to the open day for anyone, and rows of deleted staff are still returned.
- **`PUT /attendance { staffId, businessDate, mark }`:**
  - `mark` is `P`, `A` or `L`; `PRESENT`, `ABSENT` and `LEAVE` are accepted too, and stored as `P`/`A`/`L`.
  - The same person and date replaces the earlier mark, so there is only one row.
  - A future date returns `400 FUTURE_DATE`.
  - ADMIN can mark any past date. Others can mark the open day only (`403 PAST_DATE_RESTRICTED`).
  - An unknown or deleted staff member returns `404`.
  - Every change is audit-logged (`ATTENDANCE_MARK`) with the old and new mark.
- **`POST /attendance/bulk { businessDate, marks: [{ staffId, mark }] }`:** the same rules, all marks or none, and returns the rows.
- **`PATCH /staff/:id` (ADMIN, MANAGER):** takes any of `{ name, role, shift, phone, salary }`.
  - An empty name or a negative salary returns `400`. A phone must have 10 digits, or be `""`.
  - The response has the `GET /staff` shape.
- **`DELETE /staff/:id` (ADMIN only):**
  - Returns `204`, or `404` if not found.
  - Soft delete: the member drops out of `GET /staff` and can't get a new salary advance (`400 STAFF_NOT_FOUND`) or a new mark (`404`).
  - Their attendance and `GET /staff/:id/advances` remain.
  - Audit-logged.
- **`GET /staff`:** returns every live staff member, with phone, role, shift and salary, the same for ADMIN and MANAGER.

## Laundry (manager app)

Laundry routes are for ADMIN and MANAGER, except `GET /laundry/prices`, which the desk can read.

### `POST /laundry/orders`

- **Body:** `{ source, requestId?, stayId?, roomId?, guestName?, phone?, express?, expectedDate?, billTo, mode?, items: [{ name, service, qty, price }], amount?, note?, time? }`.
  - `source` is `ROOM_REQUEST`, `STAFF` or `WALK_IN`.
  - `service` is `WASH`, `IRON`, `WASH_IRON` or `DRY_CLEAN`.
  - `businessDate` is ignored: the order is taken on the open day.
- **Rules:**
  - `ROOM_REQUEST` needs `requestId`, and the stay comes from the request.
  - `STAFF` needs an in-house `stayId` (`400 STAY_REQUIRED` / `STAY_NOT_IN_HOUSE`).
  - `WALK_IN` needs `guestName` (`400 GUEST_NAME_REQUIRED`) and must be `PAY_NOW`.
  - `items` can't be empty.
- **Money, worked out on the server:**
  - `subtotal` = Σ qty × price.
  - `expressCharge` = subtotal × express % (50 by default; see prices below).
  - `amount` = subtotal + expressCharge.
  - GST is added like any other service (18% by default), giving `cgst`, `sgst` and `total`.
  - If you send `amount`, it must equal the server's figure, otherwise `400 AMOUNT_MISMATCH`.
  - `total` is what's charged at delivery.
- **From a request:**
  - The order is linked to the request, and the request moves to `IN_PROGRESS` and gets `laundryOrderId`.
  - A second live order for the same request returns `409 REQUEST_HAS_ORDER`.
  - The request must be a laundry one and still open.
- **On creation:** the status starts at `REQUESTED`, `number` is `LND-0001` and so on, and no money is posted.

### `GET /laundry/orders?status=&date=&stayId=&page=&limit=`

- **Response:** `{ data, meta }`, newest first. Each order has its items and `roomNumber`.
- **Which orders:**
  - ADMIN sees every order, or one business day with `date`.
  - MANAGER sees the open day plus every order not yet `DELIVERED` or `CANCELLED`, from any day. Another `date` returns `403 PAST_DATE_RESTRICTED`.

### `PATCH /laundry/orders/:id` with `{ status?, mode?, time?, items?, express?, amount?, expectedDate?, billTo?, note? }`

- **Status moves:** `REQUESTED → PICKED_UP → IN_PROCESS → READY → DELIVERED`, and steps may be skipped.
  - Going back returns `409 INVALID_STATUS_CHANGE`.
  - Any open order can be `CANCELLED`, but a `READY` one needs ADMIN (`403`).
  - `DELIVERED` and `CANCELLED` are final: `409 ORDER_CLOSED`.
- **Timestamps:** `pickedUpAt`, `readyAt`, `deliveredAt` and `cancelledAt` are set as the order moves.
- **Edits:** allowed only while the order is open. They reprice it, and an edit sent together with `DELIVERED` is applied first.
- **On `DELIVERED`:** the money is posted in the same transaction, exactly once.
  - `ROOM`: a "Laundry LND-0001" charge goes on the guest's folio, in the OTHER section with its GST. If the guest has checked out, the call returns `409 STAY_CLOSED`; switch to `billTo: PAY_NOW`.
  - `PAY_NOW`: a `CREDIT` day-book line (`type: "Laundry"`, `source: "LAUNDRY"`, narration "Laundry LND-0001") is posted on the open day, with `mode` from the order or the PATCH body (`400 MODE_REQUIRED` without one). With no day open, the call returns `409 DAY_NOT_OPEN`.
  - The linked request becomes `DONE` with the remark "Laundry delivered".
- **On `CANCELLED`:** nothing is posted. The linked request becomes `REJECTED` with the remark "Cancelled", and can be ordered again.
- **Picked up or moved on:** the linked request is `IN_PROGRESS`.
- **Audit:** every change is logged (`LAUNDRY_ORDER`).

### Prices

- **`GET /laundry/prices`:** returns `{ expressPct, items: [{ name, service, price }], custom }`. It's a built-in list (`custom: false`) until an ADMIN saves one.
- **`PUT /laundry/prices`:** ADMIN only. Body `{ expressPct, items: [{ name, service, price }] }`. `expressPct` is also what new orders use, and the `LAUNDRY_EXPRESS_PCT` env var sets the default.

### Service requests and reports

- **`GET /service-requests`:** laundry requests come with `roomNumber`, `guestName`, `note`, `createdAt` and `laundryOrderId` (`null` while no live order exists).
- **`GET /reports/summary`:**
  - Laundry paid at delivery is in `totalSales`, because it's a day-book credit.
  - Laundry billed to the room is counted when the guest pays at checkout.
  - The new `totalLaundry` is delivered orders' `total` by delivery day. It includes room-billed orders and never cancelled ones.
- **`GET /reports/entries`:** has `category=LAUNDRY`. Food totals are unaffected.
- **Deleting a stay** cancels its undelivered laundry orders.

## Withdraw entries (day book)

- **`POST /entries` with `type: "Withdraw"`:** the type is matched without case and stored and returned as `"Withdraw"`, with `source: "WITHDRAW"`.
  - `dc` is always `DEBIT`. It may be left out; `CREDIT` returns `400 WITHDRAW_IS_DEBIT`.
  - `mode` defaults to `BANK`; `CASH`, `UPI` and `CARD` also work.
  - `amount` must be above 0 (`400 AMOUNT_REQUIRED`).
  - `roomId`, `phone` and `vehicle` are optional. `guestName` is the person who withdrew.
- **Other entries:** `mode` and `dc` are still required (`400 MODE_REQUIRED` / `DC_REQUIRED`).
- **Rules:** the same as manual entries.
  - The duplicate check applies (`409 DUPLICATE_ENTRY`).
  - Withdrawals are posted on the open day only. Editing or deleting on a closed day returns `409 DAY_CLOSED`, and non-admins get `403` for another day.
  - Edits can't make it a credit.
  - Every create, edit and delete is audit-logged (`WITHDRAW`).
- **Day book:**
  - A withdrawal is a debit, so it lowers `closingBalance` and its mode's net.
  - `GET /daybook` adds `totalWithdraw`, the day's withdrawals, which are already inside `debits`.
  - `GET /daybook/register` shows each withdrawal as a `DEBIT` line with `source: "WITHDRAW"`.
- **Reports:**
  - `GET /reports/summary` doesn't count withdrawals as sales or expenses. It adds `totalWithdraw` for the range.
  - `GET /reports/entries` has a new `category=WITHDRAW`. Withdrawals are included under "All" and not under `EXPENSE` or `OTHER`.

## Bookings hold a room; PREBOOKED rooms (manager app)

### `POST /bookings` and `PATCH /bookings/:id`

- **`roomId`:** required on `POST /bookings` (`400 VALIDATION_ERROR` without it). The booking is for that one room, so `rooms` is 1. Send `pax` for the guests in it.
  - `roomTypeId` is optional, and must be the room's type when sent.
  - Guest-app and public booking requests still have no room until the desk assigns one, because they go through their own endpoints.
- **Availability rules:** a booking for `[arrivalDate, departureDate)` is refused with `409 ROOM_NOT_AVAILABLE` when:
  - the room is of another type;
  - it sleeps fewer than `pax` (its `sleeps`, default 4);
  - it is `OOO`;
  - it is under `MAINTENANCE` with no back date, or a back date after the arrival;
  - its current guest leaves after the arrival;
  - another `CONFIRMED` or `ARRIVING` booking of the room overlaps the dates.
- **How dates compare:** a departure and an arrival on the same day don't clash.
- **Transaction:** the check runs in one transaction that also writes to the room, so two desks booking the same room at once can't both succeed.
- **Moving a booking:** `PATCH { roomId }` moves the booking to another room, releasing the old one and holding the new one. The booking takes the new room's type and is repriced.
  - Once a room of the booking is checked in, the room is locked like the arrival date (`409 BOOKING_LOCKED`).
  - Changing the dates, guests or status back to `CONFIRMED`/`ARRIVING` checks the rules again.
- **Responses:** `GET /bookings` and the `PATCH` response include `roomId` and `roomNumber`.

### Room status `PREBOOKED` (set by the server only)

- **When it's set:** on the arrival day (the open business day), a `VACANT` room held by a `CONFIRMED` or `ARRIVING` booking becomes `PREBOOKED`.
  - This happens when the booking is saved, when the business day starts, and when the room is cleaned (`mark-all-clean`, or a manual status change back to `VACANT`).
  - An `OCCUPIED` room stays `OCCUPIED` and becomes `PREBOOKED` once checked out and cleaned.
  - Rooms booked for later dates stay `VACANT`.
- **Releasing:** cancelling, `NO_SHOW` (by hand or at day close), deleting the booking, or moving it to another room turns a `PREBOOKED` room back to `VACANT`. Check-in makes it `OCCUPIED`.
- **Walk-ins and shifts:**
  - A `PREBOOKED` room can't take a walk-in (`409 ROOM_NOT_AVAILABLE`) or a room shift (`409 ROOM_NOT_VACANT`).
  - A walk-in or shift whose nights overlap any future hold of the room is refused too (`409 ROOM_NOT_AVAILABLE`). Leaving on the hold's arrival day is fine.
- **Counts:** `PREBOOKED` rooms count as rooms of their type, but not as free rooms or occupied ones.

### `POST /stays` with `bookingId`

- **Room:** `roomId` may be left out, and the booking's room is used.
- **Booking:** the stay is linked to the booking, which becomes `CHECKED_IN`.
- **A different room:** if you send a `roomId` other than the booking's, the guest goes into that room (it must be `VACANT` and free for those nights). The booking moves to it, and its old room is released.

### `GET /rooms`

- **`prebooking`:** each room has `prebooking: { id, guestName, arrivalDate, departureDate, pax, status } | null`. This is the next `CONFIRMED` or `ARRIVING` booking holding the room that hasn't departed.

### `GET /rooms/available?from=&to=&roomTypeId=&guests=`

- **What it returns:** the rooms a booking for `[from, to)` could take, under the same rules as above.
- **Shape:** `[{ id, number, floor, roomTypeId, category, status, sleeps }]`.

## Booking no-shows (manager app)

- **New status:** `NO_SHOW`. It also appears in the guest app's booking list.
- **Automatic rule:** when a business day is closed, every `CONFIRMED` or `ARRIVING` booking arriving on or before that day becomes `NO_SHOW`. Each change gets its own audit entry (`BOOKING_NO_SHOW`) and a `booking.updated` socket event.
  - It runs in the same transaction as the close.
  - A booking with a checked-in room is never touched, and neither are `CHECKED_IN`, `CANCELLED` or `REQUESTED` bookings.
  - There's no separate nightly job: closing the day is the trigger.
- **Late arrival:** `POST /stays` with the `bookingId` still works for a `NO_SHOW` booking, and the booking becomes `CHECKED_IN`.
- **Reviving:** to bring a `NO_SHOW` booking back to `CONFIRMED` or `ARRIVING`, `PATCH /bookings/:id` must include the new `arrivalDate` (and the `departureDate` if needed). Without it the call returns `400 ARRIVAL_REQUIRED`. Staff can also set `NO_SHOW` by hand.
- **`GET /bookings` filters:**
  - `status` and `excludeStatus` each take one status or several, comma-separated, e.g. `?excludeStatus=CHECKED_IN,CANCELLED`.
  - `from` and `to` filter by arrival date, inclusive. `from` after `to` returns `400 INVALID_RANGE`.
  - `date` still means "arriving on this date".
  - The list is now sorted by arrival, soonest first.
- **Reports:** the summary's sales come from money actually received and its guests from actual check-ins, so a `NO_SHOW` booking is never counted. The "Bookings" report lists it with its status.

## KOTs: list, status and cancel (Restaurant & Orders screen)

### `GET /kots` (every staff role; non-admins get the open day only)

- **Filters:** `?date=&status=&stayId=&page=&limit=`. The response is `{ data: [...], meta: { page, limit, total } }`, newest first.
- **Date:** one business day, by default the open day (else today).
  - MANAGER asking for another date gets `403 PAST_DATE_RESTRICTED`.
  - An ADMIN filtering by `stayId` without a `date` gets every day.
- **Each row:**
  - `id`, `number` (still a number, e.g. `42`) and `displayNumber` (`"K-0042"`)
  - `stayId`, `roomNumber`, `guestName`, `tableLabel`, `billTo`, `waiterId`, `waiterName`, `status`
  - `taxable`, `cgst`, `sgst`, `total`, `businessDate`, `createdAt`, `note`
  - `items: [{ name, qty, price, note, menuItemId }]`. Items carry their name and price as they were when ordered.

### `PATCH /kots/:id` with `{ status }`

`PATCH /kots/:id/status` is the older path and still works.

- **Statuses:** `PLACED`, `PREPARING`, `READY`, `ON_THE_WAY`, `SERVED`, `CANCELLED`.
  - A new KOT starts as `PLACED`; show it as "Preparing" if you only use four steps.
  - `ON_THE_WAY` is used by the kitchen and guest apps for room service.
- **Moves:** forward only, and steps may be skipped. Going back returns `409 INVALID_KOT_STATUS`.
- **Cancelling:** allowed from any status before `SERVED`. The kitchen (`KITCHEN` role) can't cancel (`403`).
- **Final states:** a `SERVED` or `CANCELLED` KOT can't change: `409 KOT_CLOSED`.
- **Audit:** every change is logged (`KOT_STATUS`) with who, when, the old and new status, and any folio charge removed.

**On `CANCELLED`:**
- **ROOM bill:** the KOT's charge is removed from the guest's folio. If the guest has already checked out, the call returns `409 KOT_BILLED`, because that bill is closed.
- **PAY_NOW, already paid:** `409 KOT_SETTLED`. Refund it instead.
- **PAY_NOW, not paid:** the KOT is cancelled, and `POST /bills/settle` refuses it afterwards with `409 KOT_CANCELLED`.
- **Reports:** cancelled KOTs are left out of `totalFoodOrders` and `foodSales` in `GET /reports/summary`.

### Print Bill

No endpoint is needed while CGST and SGST are typed on the client and only printed. If the bill should be stored later, the plan is `POST /kots/:id/bill`:
- It would take `{ cgstAmount, sgstAmount }`, or better, let the server work out GST as it already does (`taxable`, `cgst` and `sgst` are on every KOT).
- It would give a bill number from the same per-year counter as room bills.
- It would keep the bill for audit.

## Online orders: no commission, status and cancel (manager app)

- **`POST /online-orders`:** takes `{ businessDate, platform, orderId, items, amount }`.
  - `amount` is the order value and the only money field. It is posted to the day book as a `BANK` receipt on the open day.
  - `commissionPct` is accepted from older apps and ignored.
  - In responses `payout` and `commissionPct` are `null`.
  - `businessDate` is ignored: the order goes to the open day, like every posting.
- **`GET /online-orders`:** each order has `id, platform, orderId, items, amount, status, time, businessDate`. `status` is one of `PREPARING`, `PICKED_UP`, `DELIVERED` or `CANCELLED`.
- **`PATCH /online-orders/:id`:** body `{ status }`. Same roles as creating an order, so MANAGER can use it.
  - Allowed moves: `PREPARING → PICKED_UP → DELIVERED`, with steps allowed to be skipped. Going back returns `409 INVALID_STATUS_CHANGE`.
  - `PREPARING` or `PICKED_UP` can move to `CANCELLED`.
  - A `DELIVERED` or `CANCELLED` order can't change: `409 ORDER_CLOSED`.
  - `DELIVERED` moves no money.
  - Every change is audit-logged with who, when, and the old and new status.
- **On `CANCELLED`:**
  - A receipt on the open day is voided with its cash line.
  - A receipt on an earlier, closed day is left as it is, and an opposite `BANK` line (`type: "Online order cancelled"`, linked by `reversalOf`) is posted on the open day. With no day open, the call returns `409 DAY_NOT_OPEN`.
  - Cancelled orders are left out of `totalSales`, `foodSales` and `totalFoodOrders` in `GET /reports/summary`.
- **"Online" report:** no longer has a "Net payout" column.

## Expenses: salary advance, edit and delete (manager app)

### Salary advance (`POST /expenses`)

- **`staffId`:** optional on any expense, and required when `head` is `"Salary advance"` (the match ignores case).
  - Without it the call returns `400 STAFF_REQUIRED`.
  - An unknown staff member returns `400 STAFF_NOT_FOUND`.
  - `onCredit: true` returns `400 ADVANCE_ON_CREDIT`, because an advance is paid now.
- **Stored and returned:** `staffId` is saved on the expense and returned by `GET /expenses`. `vendor` is stored exactly as you send it.
- **Advances per staff member:** `GET /staff/:id/advances` (ADMIN, MANAGER) returns `{ staffId, name, salary, total, advances: [{ id, businessDate, time, amount, mode, head, narration }] }`. Payroll can deduct `total`.
- **Salary:** `GET /staff` already returns `salary` for every staff member.

### `PATCH /expenses/:id` (ADMIN only; MANAGER gets `403`)

- **Body:** any of `{ head, vendor, staffId, amount, narration, mode, dueDate }`.
- **Response:** the updated expense, in the same shape as a row of `GET /expenses`. The audit log (`EXPENSE_UPDATE`) records the before and after values.
- **Open day only:** a closed day returns `409 DAY_CLOSED`. Any other day that isn't open returns `409 DAY_NOT_OPEN`. To correct a closed day, the ADMIN reopens it with `POST /business-day/reopen` first.
- **`onCredit`:** can't change, and a different value returns `400 ON_CREDIT_LOCKED`. Sending the same value is accepted.
- **Paid-now expense:** the cash line's amount, mode and head are rewritten in the same transaction, so the day book moves by exactly the difference. A `dueDate` returns `400`.
- **Credit expense:**
  - `mode` returns `400 MODE_NOT_ALLOWED`.
  - An `amount` below what's already been paid returns `409 EXPENSE_PAYMENTS_EXIST`.
  - Otherwise `dueAmount` is recalculated. `dueDate: null` clears the due date.

### `DELETE /expenses/:id` (ADMIN only)

- **Success:** `204`. A repeated call returns `404`. Same open-day rule as PATCH (`409 DAY_CLOSED`).
- **Soft delete:** the expense gets `deletedAt` and `deletedByUserId`. Its cash line is soft-deleted in the same transaction, so no orphan is left.
- **Where it disappears:** `GET /expenses` (including `status=DUE` and payables), `/daybook`, `/daybook/register` and every report.
- **Payments exist:** a credit expense with any payment made against it returns `409 EXPENSE_PAYMENTS_EXIST`. Those payments are day-book lines, possibly on other days, and aren't reversed automatically.
- **Audit:** the audit log (`EXPENSE_DELETE`) keeps who deleted it, when, and the expense as it was.

## Delete a stay created by mistake (manager app, Guest Management)

### `DELETE /stays/:id` (ADMIN only; MANAGER gets `403 FORBIDDEN "Admin access required"`)

- **Body:** optional `{ reason }`, which is kept in the audit log.
- **Success:** `204`, no body. Calling it again returns `404`.
- **Checked out:** a stay that has already checked out returns `409 STAY_CLOSED`.
- **Settled bill:** returns `409 STAY_HAS_PAYMENTS` when a KOT of the stay was paid at the desk, or a service was paid for (pay now). Check the guest out and refund instead.

Everything below happens in one transaction:
- **Money taken for the stay:** this covers the advance at check-in, part payments and refunds.
  - A line on the open day is voided together with its cash line, so the day book and cash go back to what they were.
  - A line on an earlier day is left untouched, because closed days are never edited. An opposite line (`type: "Stay voided"`, linked by `reversalOf`) is posted on the open day instead. If no day is open, the call returns `409 DAY_NOT_OPEN`.
- **Charges:** room charges and the rest of the folio are voided. These were never day-book money.
- **Open items:** open service requests and unpaid KOTs of the stay are voided.
- **Room:** goes back to `VACANT`.
- **Booking:** the booked room is freed, and the booking goes back to `CONFIRMED` if no other room of it is checked in. A walk-in's own one-room booking is voided.
- **Customer:** the customer's visit count goes down by one.
- **The stay itself:** becomes `CANCELLED` and is soft-deleted (`deletedAt`, `deletedByUserId`, `voidReason`). It drops out of `GET /rooms` (`currentStay`), `GET /stays/in-house`, customer history and reports.
- **Audit:** the audit log (`STAY_VOID`) records who, when, the stay, the room, the reason, and the lines voided or reversed.
- **Sockets:** a `stay.voided` event goes out with `{ stayId, roomId }`.

`GET /reports/summary` nets a reversal against the original payment, so `totalSales` doesn't count money that was given back.

### `PATCH /stays/:id` (edit form)

- **Accepted fields:** `guestName`, `phone`, `vehicle`, `guests`, `checkOut`, and an optional `payment: { kind: ADVANCE | PART_PAYMENT | REFUND, amount, mode, time, narration }`.
- **Guests:** at least 1, up to what the room sleeps (`sleeps`, 4 by default). A higher number returns `400 TOO_MANY_GUESTS`.
- **Repricing:** changing `guests` reprices the nights from today on. Changing `checkOut` changes the nights.
- **Response:** `{ stay, entry }`, where `entry` is the payment line or `null`.

## Edit and delete OTA bookings (manager app)

### `PATCH /bookings/:id` (ADMIN, MANAGER)

- **Body:** any of `{ source, ref, guestName, phone, roomTypeId, rooms, pax, arrivalDate, departureDate, amount, payment, status, note }`. A field you leave out stays as it is.
- **Response:** the updated booking, in the same shape as a row of `GET /bookings`.
- **Status:** one of `ARRIVING`, `CONFIRMED`, `CHECKED_IN`, `CANCELLED` or `NO_SHOW`.
- **Validation errors:**
  - `400 INVALID_DATES` unless departure is after arrival.
  - `400 VALIDATION_ERROR` for `rooms` below 1 or above 10, or a negative `amount`.
  - `409 BOOKING_EXISTS` when the `ref` is already used by another booking from the same source.
- **Repricing:**
  - Changing `roomTypeId`, `rooms` or `pax` reprices every room at today's tariff. `roomTypeId` moves every room to that type, and `pax` is split across the rooms.
  - Changing only the dates keeps each room's booked rate and changes the number of nights.
- **Amount:** only an OTA booking (MakeMyTrip, Booking.com, Goibibo, Agoda, Airbnb) takes `amount` from the client. Other bookings are priced by the server, the same as at create.
- **Phone:** a new phone links the booking to that customer, except for guest-app bookings, which stay with the customer who made them.
- **Locked fields:** once a room of the booking is checked in, changing `arrivalDate`, `rooms`, `roomTypeId` or `pax` returns `409 BOOKING_LOCKED`. Sending the same value as before is fine. Other fields, including departure, can still be edited.
- **Audit:** every edit is audit-logged with the before and after values.

### `DELETE /bookings/:id` (ADMIN only for now)

- **Success:** `204`, no body.
- **Not found:** `404` for an unknown or already-deleted booking.
- **Already used:** `409 BOOKING_IN_USE` once a room of the booking is checked in. Use `PATCH { status: "CANCELLED" }` instead.
- **Soft delete:** the booking gets `deletedAt` and drops out of `GET /bookings`. It stays in the database for reports and the audit trail.
- **Reference:** its OTA `ref` can be used again.
- **Audit:** the audit log records who deleted it, when, and which booking.
- **Sockets:** `booking.updated` and `booking.deleted` events go to hotel staff.

## Date-range reports (manager app)

Both endpoints take `from` and `to` as `YYYY-MM-DD` business dates, both inclusive.
- A missing end takes the value of the other one. With neither, the open business day is used.
- Errors are `400`: `INVALID_DATE` for a date that doesn't exist, `INVALID_RANGE` when `from` is after `to`, and `RANGE_TOO_LONG` for more than 366 days. A wrongly formatted date gets `VALIDATION_ERROR`.
- ADMIN and MANAGER can call them; STAFF gets `403`. ADMIN can use any range.
- For MANAGER, `from` and `to` must both be the open day; anything else gets `403 PAST_DATE_RESTRICTED`. With no day open, MANAGER gets zeros and an empty list.
- Money is returned as 2-decimal strings, as asked. This is unlike the rest of the API, which returns numbers.

### `GET /reports/summary?from=&to=`

The response is `{ totalSales, totalGuests, totalFoodOrders, totalExpenses, foodSales, totalWithdraw, totalLaundry }`. The fields are in `data`, and also repeated at the top level.

| Field | Rule used |
|---|---|
| `totalSales` | Sum of `CREDIT` register lines (room, food, online orders, service charges, manual receipts, udhaar paid back) in the range. Refunds and all debits are left out. Udhaar never reaches the register until it is paid, so it is counted once, on the day it's paid. A checkout's shortfall isn't counted. |
| `totalGuests` | Each stay counted once, on its check-in date, at the most guests it ever had. Adding a guest mid-stay doesn't count the stay twice. A room shift is the same stay. |
| `totalFoodOrders` | Restaurant and room-service KOTs plus online orders whose status doesn't contain "cancel". KOTs can't be cancelled, only deleted, and deleted ones are left out. |
| `totalExpenses` | Every expense by its date at its full amount, including ones on credit. Later payments of a credit expense aren't added again. |
| `foodSales` | KOT totals (GST included) plus online order `amount`. Cancelled orders aren't counted. |

### `GET /reports/entries?from=&to=&category=&page=1&limit=25`

- `category` is one of the following. Leave it out for all rows.
  - `ROOM`: check-in, checkout, stay payment, refund
  - `FOOD`: restaurant, room service, online
  - `EXPENSE`: expenses and expense payments
  - `OTHER`: manual entries, service requests, udhaar paid back, and the rest
- `limit` is 25 by default, at most 5000.
- Rows are register lines plus expenses, newest first: by `businessDate` descending, then `time` descending. Paging happens in the database.
- The response is as specified: `{ data: [...], total, page, limit, totals: { credit, debit } }`, plus the usual `meta`. `total` and `totals` cover the whole range and category.
- Each row has `id, businessDate, time, roomNumber, guestName, type, mode, dc, amount, narration, source, category`.
  - Expense rows have `source: "EXPENSE"`, the head as `type`, the vendor as `guestName`, and `onCredit`.
  - A checkout paid by split payment shows one row per payment.
- An expense bought on credit is listed but not counted in `totals.debit`, the same as in the day book. Its payments are the `EXPENSE_PAYMENT` rows, so counting both would add it twice. This is why `totals.debit` can be lower than `totalExpenses` in the summary.

## Behaviour to expect

- **Duplicate rule on stay payments:** a second payment of the same type and amount for the same guest, room and date returns `409 DUPLICATE_ENTRY` with `entryId`. This is the client's rule. Change the amount or edit the existing entry.
- **Closed days:** posting to a closed date returns `409 DAY_CLOSED` for everyone except ADMIN.
- **Date limits:** future dates, or dates over 7 days old, return `400` (`FUTURE_DATE`, `DATE_TOO_OLD`) unless ADMIN.
- **Rate at check-in:** only ADMIN can check in at a rate other than the room's; others get `403 RATE_OVERRIDE_FORBIDDEN`. The app's current behaviour of sending the room rate is fine.
- **Checked-out guests:** the guest's token returns `401 STAY_ENDED`, and the app's existing 401 handling signs them out.
- **Public booking errors:** `400` with `INVALID_OTP`, `BULK_BOOKING`, `INVALID_DATES` or `TOO_MANY_GUESTS`; `429` with `TOO_MANY_REQUESTS`. Show `message` as it is.
- **Guest booking list:** the backend has no endpoint for a guest to list their booking requests, so that list is lost on refresh.
- **Online orders:** each one posts its order value to the day book as a `BANK` receipt, and cancelling it takes that receipt back.

## Not tested yet

The backend's integration tests cover the API these apps call, but neither app has been run against it in a browser. Please check each screen once the backend is deployed.
