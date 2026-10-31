import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Attendance, AttendanceSchema } from '../attendance/schemas/attendance.schema';
import { OtpChallenge, OtpChallengeSchema } from '../auth/schemas/otp-challenge.schema';
import { Booking, BookingSchema } from '../bookings/schemas/booking.schema';
import { CashTxn, CashTxnSchema } from '../cash-transactions/schemas/cash-txn.schema';
import { DayBook, DayBookSchema } from '../daybook/schemas/day-book.schema';
import { DayRegisterEntry, DayRegisterEntrySchema } from '../entries/schemas/day-register-entry.schema';
import { Expense, ExpenseSchema } from '../expenses/schemas/expense.schema';
import { Feedback, FeedbackSchema } from '../feedback/schemas/feedback.schema';
import { FolioLine, FolioLineSchema } from '../folio/schemas/folio-line.schema';
import { Invoice, InvoiceSchema } from '../invoices/schemas/invoice.schema';
import { Kot, KotSchema } from '../kots/schemas/kot.schema';
import { MenuItem, MenuItemSchema } from '../menu/schemas/menu-item.schema';
import { OnlineOrder, OnlineOrderSchema } from '../online-orders/schemas/online-order.schema';
import { RoomType, RoomTypeSchema } from '../room-types/schemas/room-type.schema';
import { Room, RoomSchema } from '../rooms/schemas/room.schema';
import { ServiceRequest, ServiceRequestSchema } from '../service-requests/schemas/service-request.schema';
import { Staff, StaffSchema } from '../staff/schemas/staff.schema';
import { Stay, StaySchema } from '../stays/schemas/stay.schema';
import { StockItem, StockItemSchema } from '../stock/schemas/stock-item.schema';
import { StockMovement, StockMovementSchema } from '../stock/schemas/stock-movement.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

// Several domains write to each other's collections inside one transaction
// (an entry posts cash and a folio line), so models are registered once here
// rather than through a web of module imports.
const models = MongooseModule.forFeature([
  { name: Attendance.name, schema: AttendanceSchema },
  { name: OtpChallenge.name, schema: OtpChallengeSchema },
  { name: Booking.name, schema: BookingSchema },
  { name: CashTxn.name, schema: CashTxnSchema },
  { name: DayBook.name, schema: DayBookSchema },
  { name: DayRegisterEntry.name, schema: DayRegisterEntrySchema },
  { name: Expense.name, schema: ExpenseSchema },
  { name: Feedback.name, schema: FeedbackSchema },
  { name: FolioLine.name, schema: FolioLineSchema },
  { name: Invoice.name, schema: InvoiceSchema },
  { name: Kot.name, schema: KotSchema },
  { name: MenuItem.name, schema: MenuItemSchema },
  { name: OnlineOrder.name, schema: OnlineOrderSchema },
  { name: RoomType.name, schema: RoomTypeSchema },
  { name: Room.name, schema: RoomSchema },
  { name: ServiceRequest.name, schema: ServiceRequestSchema },
  { name: Staff.name, schema: StaffSchema },
  { name: Stay.name, schema: StaySchema },
  { name: StockItem.name, schema: StockItemSchema },
  { name: StockMovement.name, schema: StockMovementSchema },
  { name: User.name, schema: UserSchema },
]);

@Global()
@Module({ imports: [models], exports: [models] })
export class ModelsModule {}
