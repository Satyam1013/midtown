import { UsersModule } from './users/users.module';
import { RoomTypesModule } from './room-types/room-types.module';
import { FolioModule } from './folio/folio.module';
import { CashTransactionsModule } from './cash-transactions/cash-transactions.module';
import { DaybookModule } from './daybook/daybook.module';
import { EntriesModule } from './entries/entries.module';
import { RoomsModule } from './rooms/rooms.module';
import { StaysModule } from './stays/stays.module';
import { MenuModule } from './menu/menu.module';
import { KotsModule } from './kots/kots.module';
import { OnlineOrdersModule } from './online-orders/online-orders.module';
import { BookingsModule } from './bookings/bookings.module';
import { StockModule } from './stock/stock.module';
import { StaffModule } from './staff/staff.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ExpensesModule } from './expenses/expenses.module';
import { InvoicesModule } from './invoices/invoices.module';
import { FeedbackModule } from './feedback/feedback.module';
import { ServiceRequestsModule } from './service-requests/service-requests.module';
import { ReportsModule } from './reports/reports.module';
import { GuestModule } from './guest/guest.module';
import { PublicModule } from './public/public.module';

export const DOMAIN_MODULES = [
  PublicModule,
  UsersModule,
  RoomTypesModule,
  FolioModule,
  CashTransactionsModule,
  DaybookModule,
  EntriesModule,
  RoomsModule,
  StaysModule,
  MenuModule,
  KotsModule,
  OnlineOrdersModule,
  BookingsModule,
  StockModule,
  StaffModule,
  AttendanceModule,
  ExpensesModule,
  InvoicesModule,
  FeedbackModule,
  ServiceRequestsModule,
  ReportsModule,
  GuestModule,
];
