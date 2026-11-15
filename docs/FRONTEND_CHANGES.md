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

## Room categories, guest pricing and room shifts (manager and guest apps)

All additive: existing calls keep working.

**Rooms**
- `GET /rooms` now returns `category` (`AC` / `NON_AC`, or `null` on older rooms), `singleRate`, `doubleRate` (`rate` = `singleRate`) and `roomType.category`.
- `POST /rooms`: `{ number, floor, category, roomType: "AC Deluxe", singleRate, doubleRate }`. Both rates are required with a category. Errors: `TYPE_CATEGORY_MISMATCH`, `RATES_REQUIRED`. The old body still works.
- `PATCH /rooms/:id` (OWNER, MANAGER): any of `category`, `roomType` or `roomTypeId`, `singleRate`, `doubleRate`. Stays in progress keep their rate.
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
- `POST /business-day/start` takes `{ businessDate, openingBalance, time, note }`. `note` is required when the opening balance differs from `lastClosingBalance`. Errors: `409 DAY_ALREADY_OPEN`, `409 DAY_ALREADY_CLOSED`, `400 NOTE_REQUIRED`. STAFF, MANAGER and OWNER can start.
- `POST /business-day/close` takes `{ businessDate, countedCash, note, time }`. `note` is required when there's a shortage or excess (`400 NOTE_REQUIRED`). OWNER and MANAGER only.
- `POST /business-day/reopen` takes `{ businessDate, note }`. OWNER only.
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
- `GET /daybook/shortages?from=&to=` returns `{ days[], entries[] }` (OWNER, MANAGER).

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
- `DELETE /customers/:id/documents/:docId` is OWNER and MANAGER only.

**Customers screen**
- `GET /customers?search=&filter=repeat|nodoc|all&limit=&cursor=` returns `[{ id, name, phone, email, visits, totalSpent, lastVisitAt, hasDocument, documentType }]`, newest visit first. Pass `meta.nextCursor` as `cursor` for the next page.
- `GET /customers/:id` returns the profile plus:
  - `documents[]`
  - `stays[]`: `{ id, role: MAIN|ADDED, roomNumber, roomType, checkInDate, checkOutDate, nights, guests, total, paid, balance, status }`
  - `payments[]`
- `PATCH /customers/:id` edits `{ name, phone, email, notes }`. A phone belonging to another customer returns `409 CUSTOMER_PHONE_EXISTS` with `existingCustomerId`; offer a merge.
- `POST /customers/:id/merge` takes `{ intoCustomerId }` (OWNER, MANAGER) and moves stays and documents into the other customer.

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
- `GET /rooms/maintenance-history?roomId=` (OWNER, MANAGER) lists past and current maintenance periods.

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
- `GET /stays/:id/bill-prints` (OWNER, MANAGER) lists them.
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
- `POST /menu` (OWNER, MANAGER) takes `{ name, description, price, category, isVeg, available }`. A name already in that category, ignoring case, returns `409 MENU_ITEM_EXISTS`.
- `POST /stock` takes `{ item, category, unit, qty, minQty, rate }`. An opening quantity is recorded as an "Opening stock" movement. A duplicate name, ignoring case, returns `409 STOCK_ITEM_EXISTS`.
- `POST /staff` (OWNER, MANAGER) takes `{ name, role, shift, phone, salary }`. `GET /staff` includes `phone`.

**Customer credit (udhaar)**
- `POST /customers/:id/credit` takes one of:
  - `{ kind: "CHARGE", amount, narration, businessDate, time }`: no money moves, and no open day is needed.
  - `{ kind: "PAYMENT", amount, mode, narration, time }`: needs an open day. It posts a receipt (`source: CUSTOMER_CREDIT`) on the open day.
- It returns `{ entry, creditBalance, receipt }`.
- Errors: `409 CREDIT_EXCEEDED` (more than is owed), `400 MODE_REQUIRED`.
- `GET /customers` items include `creditBalance`. `GET /customers?hasCredit=true` lists only customers who owe money.
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
- `POST /room-types` (OWNER) takes `{ name, category, sleeps (1-4), singleRate, doubleRate, additionalGuestRate, beds, size, blurb, perks, sortOrder }`.
- `PATCH /room-types/:id` (OWNER) takes any of the same fields. `tariff` is still accepted as the older name for `singleRate`.
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

## Behaviour to expect

- **Duplicate rule on stay payments:** a second payment of the same type and amount for the same guest, room and date returns `409 DUPLICATE_ENTRY` with `entryId`. This is the client's rule. Change the amount or edit the existing entry.
- **Closed days:** posting to a closed date returns `409 DAY_CLOSED` for everyone except OWNER.
- **Date limits:** future dates, or dates over 7 days old, return `400` (`FUTURE_DATE`, `DATE_TOO_OLD`) unless OWNER.
- **Rate at check-in:** only OWNER can check in at a rate other than the room's; others get `403 RATE_OVERRIDE_FORBIDDEN`. The app's current behaviour of sending the room rate is fine.
- **Checked-out guests:** the guest's token returns `401 STAY_ENDED`, and the app's existing 401 handling signs them out.
- **Public booking errors:** `400` with `INVALID_OTP`, `BULK_BOOKING`, `INVALID_DATES` or `TOO_MANY_GUESTS`; `429` with `TOO_MANY_REQUESTS`. Show `message` as it is.
- **Guest booking list:** the backend has no endpoint for a guest to list their booking requests, so that list is lost on refresh.
- **Online orders:** these don't post to the day book, because platform payouts aren't cash on the day.

## Not tested yet

The backend's integration tests cover the API these apps call, but neither app has been run against it in a browser. Please check each screen once the backend is deployed.
