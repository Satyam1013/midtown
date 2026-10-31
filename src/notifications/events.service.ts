import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

export const HOTEL_ROOM = 'hotel';
export const stayRoom = (stayId: unknown) => `stay:${String(stayId)}`;

export type HotelEvent =
  | 'kot.created'
  | 'kot.updated'
  | 'stay.updated'
  | 'folio.updated'
  | 'room.status.changed'
  | 'entry.created'
  | 'entry.updated'
  | 'daybook.closed'
  | 'service-request.created'
  | 'service-request.updated'
  | 'booking.created';

// Call only from TxContext.afterCommit (or after a completed write), so
// nothing is broadcast for work that rolled back.
@Injectable()
export class EventsService {
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  /** To all staff. */
  toHotel(event: HotelEvent, payload: unknown) {
    this.server?.to(HOTEL_ROOM).emit(event, payload);
  }

  /** To all staff and to the one guest's stay room. */
  toHotelAndStay(event: HotelEvent, stayId: unknown, payload: unknown) {
    this.server?.to([HOTEL_ROOM, stayRoom(stayId)]).emit(event, payload);
  }

  /** The stay has ended: drop the guest's open sockets. */
  endStay(stayId: unknown) {
    this.server?.in(stayRoom(stayId)).disconnectSockets(true);
  }
}
