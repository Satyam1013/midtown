# The Midtown Hotel: Database Design

Based on the front-end source inspected 2026-10-31: `yashsakhla/midtown-admin` and `yashsakhla/midtown-hotel`, both on `master`.

## Seed data status

| Data | Status |
|---|---|
| Tariffs, room-to-type mapping, 6 staff, 8 stock items | Matches `midtown-admin/src/data/seed.js` |
| 16 menu names, prices, categories | Matches `midtown-admin/src/data/seed.js` |
| Room type beds, size, sleeps, blurb, perks | Matches `midtown-hotel/src/data/seed.js` |
| Menu veg flags | **Inferred from names**; not in either repo |
| Menu descriptions | **Drafts**; not in either repo |

The admin seed's demo records (5 in-house stays, entries, bookings, orders, expenses, attendance, opening balance) are not seeded, so the system starts clean with all rooms vacant.

## Design decisions

- **Folio lines:** separate `folio_lines` collection, with unique indexes on `entryId` and `kotId` so a retry can't post twice.
- **Stay dates:** `checkIn` and `checkOut` are `YYYY-MM-DD` strings, because the apps slice dates to 10 characters and a UTC timestamp would show the wrong day before 05:30 IST.
- **Money:** Decimal128 in the database, decimal.js for arithmetic, JSON numbers in responses (the apps call `Number()` on them).
- **Soft delete:** every collection has `deletedAt`; a shared plugin excludes deleted documents from default queries and aggregations.
- **Additions beyond the spec:** `counters` and `otp_challenges` collections; `rev` on the day book, so a post and a close can't interleave; `Airbnb` booking source (the manager form offers it); default online order status `PREPARING` (the manager form sends none).

Front-end work that remains is listed in [FRONTEND_CHANGES.md](FRONTEND_CHANGES.md).

## Collections

### Attendance (`attendance`)

| Field | Type | Details |
|---|---|---|
| staffId | ObjectId | required; ref Staff |
| businessDate | String | required |
| mark | String | required; enum: P, A, L |
| markedByUserId | ObjectId | ref User |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"staffId":1,"businessDate":1}` (unique, live docs only)
- `{"businessDate":1}`

### OtpChallenge (`otp_challenges`)

| Field | Type | Details |
|---|---|---|
| stayId | ObjectId | required; ref Stay |
| codeHash | String | required; hidden from API |
| expiresAt | Date | required |
| attempts | Number |  |
| consumedAt | Date |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"stayId":1,"createdAt":-1}`
- `{"expiresAt":1}`

### Booking (`bookings`)

| Field | Type | Details |
|---|---|---|
| source | String | required; enum: MakeMyTrip, Booking.com, Goibibo, Agoda, Airbnb, Walk-in, Phone, GuestApp |
| ref | String |  |
| guestName | String | required |
| phone | String |  |
| roomTypeId | ObjectId | required; ref RoomType |
| rooms | Number | required |
| pax | Number | required |
| arrivalDate | String | required |
| departureDate | String | required |
| amount | Decimal128 | required |
| payment | String |  |
| status | String | enum: REQUESTED, CONFIRMED, ARRIVING, CHECKED_IN, CANCELLED |
| note | String |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"arrivalDate":1,"status":1}`
- `{"status":1,"createdAt":-1}`
- `{"phone":1}`
- `{"source":1,"ref":1}` (unique, live docs only + filter)

### CashTxn (`cash_txns`)

| Field | Type | Details |
|---|---|---|
| businessDate | String | required |
| head | String | required |
| mode | String | required; enum: CASH, UPI, CARD, BANK |
| dc | String | required; enum: CREDIT, DEBIT |
| amount | Decimal128 | required |
| narration | String |  |
| entryId | ObjectId | ref DayRegisterEntry |
| expenseId | ObjectId | ref Expense |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"businessDate":1,"dc":1,"mode":1}`
- `{"entryId":1}` (unique, live docs only + filter)
- `{"expenseId":1}` (unique, live docs only + filter)

### Counter (`counters`)

| Field | Type | Details |
|---|---|---|
| key | String | required |
| seq | Number | required |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"key":1}` (unique)

### DayBook (`day_books`)

| Field | Type | Details |
|---|---|---|
| businessDate | String | required |
| openingBalance | Decimal128 | required |
| closingBalance | Decimal128 |  |
| rev | Number |  |
| closedAt | Date |  |
| closedByUserId | ObjectId | ref User |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"businessDate":1}` (unique)

### DayRegisterEntry (`day_register_entries`)

| Field | Type | Details |
|---|---|---|
| businessDate | String | required |
| time | String | required |
| roomId | ObjectId | ref Room |
| stayId | ObjectId | ref Stay |
| guestName | String |  |
| phone | String |  |
| vehicle | String |  |
| type | String | required |
| mode | String | required; enum: CASH, UPI, CARD, BANK |
| dc | String | required; enum: CREDIT, DEBIT |
| amount | Decimal128 | required |
| narration | String |  |
| txnId | ObjectId | ref CashTxn |
| createdByUserId | ObjectId | required; ref User |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"businessDate":1,"createdAt":1}`
- `{"roomId":1,"businessDate":1}`
- `{"stayId":1}`
- `{"businessDate":1,"roomId":1,"type":1,"amount":1,"guestName":1}` (unique, live docs only + filter, no_duplicate_entry)

### Expense (`expenses`)

| Field | Type | Details |
|---|---|---|
| businessDate | String | required |
| head | String | required |
| vendor | String |  |
| mode | String | required; enum: CASH, UPI, CARD, BANK |
| amount | Decimal128 | required |
| narration | String |  |
| txnId | ObjectId | ref CashTxn |
| createdByUserId | ObjectId | required; ref User |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"businessDate":1,"head":1}`

### Feedback (`feedback`)

| Field | Type | Details |
|---|---|---|
| stayId | ObjectId | required; ref Stay |
| rating | Number | required |
| text | String |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"stayId":1,"createdAt":-1}`
- `{"createdAt":-1}`

### FolioLine (`folio_lines`)

| Field | Type | Details |
|---|---|---|
| stayId | ObjectId | required; ref Stay |
| head | String | required |
| amount | Decimal128 | required |
| source | String | required; enum: TARIFF, FOOD, PAYMENT, REFUND, OTHER |
| entryId | ObjectId | ref DayRegisterEntry |
| kotId | ObjectId | ref Kot |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"stayId":1,"createdAt":1}`
- `{"entryId":1}` (unique, live docs only + filter)
- `{"kotId":1}` (unique, live docs only + filter)

### Invoice (`invoices`)

| Field | Type | Details |
|---|---|---|
| number | String | required |
| businessDate | String | required |
| party | String | required |
| partyGstin | String |  |
| lines | Array (embedded) | required |
| taxable | Decimal128 | required |
| cgst | Decimal128 | required |
| sgst | Decimal128 | required |
| total | Decimal128 | required |
| stayId | ObjectId | ref Stay |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"number":1}` (unique)
- `{"businessDate":1}`
- `{"stayId":1}`

### Kot (`kots`)

| Field | Type | Details |
|---|---|---|
| number | Number | required |
| stayId | ObjectId | ref Stay |
| tableLabel | String |  |
| items | Array (embedded) | required |
| taxable | Decimal128 | required |
| cgst | Decimal128 | required |
| sgst | Decimal128 | required |
| total | Decimal128 | required |
| waiterId | ObjectId | ref Staff |
| status | String | enum: PLACED, PREPARING, ON_THE_WAY, SERVED |
| billTo | String | required; enum: ROOM, PAY_NOW |
| source | String | required; enum: FRONT_DESK, GUEST_APP |
| note | String |  |
| settledAt | Date |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"number":1}` (unique)
- `{"status":1,"createdAt":1}`
- `{"stayId":1,"createdAt":-1}`
- `{"createdAt":-1}`

### MenuItem (`menu_items`)

| Field | Type | Details |
|---|---|---|
| name | String | required |
| price | Decimal128 | required |
| category | String | required |
| isVeg | Boolean | required |
| description | String |  |
| photoUrl | String |  |
| available | Boolean |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"name":1}` (unique, live docs only)
- `{"category":1,"name":1}`

### OnlineOrder (`online_orders`)

| Field | Type | Details |
|---|---|---|
| businessDate | String | required |
| platform | String | required |
| orderId | String | required |
| items | Array (embedded) |  |
| amount | Decimal128 | required |
| commissionPct | Decimal128 | required |
| payout | Decimal128 | required |
| status | String |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"platform":1,"orderId":1}` (unique, live docs only)
- `{"businessDate":1,"platform":1}`

### RoomType (`room_types`)

| Field | Type | Details |
|---|---|---|
| name | String | required |
| tariff | Decimal128 | required |
| beds | String | required |
| size | String | required |
| sleeps | Number | required |
| blurb | String |  |
| perks | Array |  |
| photoUrl | String |  |
| sortOrder | Number |  |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"name":1}` (unique, live docs only)
- `{"sortOrder":1}`

### Room (`rooms`)

| Field | Type | Details |
|---|---|---|
| number | String | required |
| floor | Number | required |
| roomTypeId | ObjectId | required; ref RoomType |
| status | String | enum: VACANT, OCCUPIED, DIRTY, OOO |
| rate | Decimal128 | required |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"number":1}` (unique)
- `{"floor":1,"number":1}`
- `{"status":1}`
- `{"roomTypeId":1}`

### ServiceRequest (`service_requests`)

| Field | Type | Details |
|---|---|---|
| stayId | ObjectId | required; ref Stay |
| key | String | required; enum: housekeeping, laundry, wifi, taxi, call, checkout |
| label | String | required |
| note | String |  |
| status | String | enum: SENT, IN_PROGRESS, DONE |
| handledByUserId | ObjectId | ref User |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"stayId":1,"createdAt":-1}`
- `{"status":1,"createdAt":1}`

### Staff (`staff`)

| Field | Type | Details |
|---|---|---|
| name | String | required |
| role | String | required |
| shift | String | required |
| salary | Decimal128 | required |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"name":1}`

### Stay (`stays`)

| Field | Type | Details |
|---|---|---|
| roomId | ObjectId | required; ref Room |
| guestName | String | required |
| phone | String |  |
| vehicle | String |  |
| checkIn | String | required |
| checkOut | String | required |
| nights | Number | required |
| rate | Decimal128 | required |
| status | String | enum: IN_HOUSE, CHECKED_OUT |
| checkedOutAt | Date |  |
| bookingId | ObjectId | ref Booking |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"roomId":1}` (unique, live docs only + filter, one_in_house_stay_per_room)
- `{"roomId":1,"checkIn":-1}`
- `{"status":1,"checkIn":-1}`
- `{"phone":1}`

### StockItem (`stock_items`)

| Field | Type | Details |
|---|---|---|
| item | String | required |
| category | String | required |
| unit | String | required |
| qty | Decimal128 | required |
| minQty | Decimal128 | required |
| rate | Decimal128 | required |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"item":1}` (unique, live docs only)
- `{"category":1,"item":1}`

### StockMovement (`stock_movements`)

| Field | Type | Details |
|---|---|---|
| stockItemId | ObjectId | required; ref StockItem |
| delta | Decimal128 | required |
| reason | String | required |
| userId | ObjectId | required; ref User |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"stockItemId":1,"createdAt":-1}`
- `{"createdAt":-1}`

### User (`users`)

| Field | Type | Details |
|---|---|---|
| name | String | required |
| phone | String | required |
| email | String |  |
| passwordHash | String | required; hidden from API |
| role | String | required; enum: OWNER, MANAGER, STAFF, KITCHEN |
| active | Boolean |  |
| tokenVersion | Number | hidden from API |
| createdAt | Date |  |
| updatedAt | Date |  |
| deletedAt | Date |  |

**Indexes**

- `{"phone":1}` (unique, live docs only)
- `{"email":1}` (unique, live docs only + filter)
