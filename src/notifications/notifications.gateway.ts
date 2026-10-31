import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';
import { ALL_STAFF, Role } from '../common/enums';
import { EventsService, HOTEL_ROOM, stayRoom } from './events.service';

// Room membership comes only from the verified token. There is deliberately no
// "join" message, so a client has no way to ask for another stay's room.
// CORS is checked per request: this decorator runs before .env has been loaded.
@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
      cb(null, !origin || originsFromEnv().includes(origin)),
    credentials: true,
  },
})
export class NotificationsGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('Socket');

  constructor(
    private readonly tokens: TokenService,
    private readonly events: EventsService,
  ) {}

  afterInit(server: Server) {
    this.events.attach(server);
  }

  async handleConnection(socket: Socket) {
    try {
      const header = String(socket.handshake.headers.authorization ?? '').replace(/^Bearer /, '');
      const token = String(socket.handshake.auth?.token ?? header);
      const user = await this.tokens.principalFrom(token);
      if (ALL_STAFF.includes(user.role)) await socket.join(HOTEL_ROOM);
      else if (user.role === Role.GUEST) await socket.join(stayRoom(user.stayId));
      else socket.disconnect(true);
    } catch {
      this.logger.debug('rejected socket connection');
      socket.disconnect(true);
    }
  }
}

export function originsFromEnv(): string[] {
  return [process.env.FRONTEND_MANAGER_URL, process.env.FRONTEND_GUEST_URL]
    .flatMap((urls) => (urls ?? '').split(','))
    .map((url) => url.trim())
    .filter(Boolean);
}
