import { UsersModule } from './users/users.module';
import { RoomTypesModule } from './room-types/room-types.module';
import { RoomsModule } from './rooms/rooms.module';
import { StaysModule } from './stays/stays.module';
import { FolioModule } from './folio/folio.module';
import { EntriesModule } from './entries/entries.module';
import { CashModule } from './cash/cash.module';
import { DaybookModule } from './daybook/daybook.module';
import { BookingsModule } from './bookings/bookings.module';
import { KotsModule } from './kots/kots.module';
import { MenuModule } from './menu/menu.module';
import { OnlineOrdersModule } from './online-orders/online-orders.module';
import { ServiceRequestsModule } from './service-requests/service-requests.module';
import { StockModule } from './stock/stock.module';
import { StaffModule } from './staff/staff.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ExpensesModule } from './expenses/expenses.module';
import { InvoicesModule } from './invoices/invoices.module';
import { FeedbackModule } from './feedback/feedback.module';

export const DOMAIN_MODULES = [
  UsersModule,
  RoomTypesModule,
  RoomsModule,
  StaysModule,
  FolioModule,
  EntriesModule,
  CashModule,
  DaybookModule,
  BookingsModule,
  KotsModule,
  MenuModule,
  OnlineOrdersModule,
  ServiceRequestsModule,
  StockModule,
  StaffModule,
  AttendanceModule,
  ExpensesModule,
  InvoicesModule,
  FeedbackModule,
];
