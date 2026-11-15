import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

@Module({ controllers: [MenuController], providers: [MenuService], exports: [MenuService] })
export class MenuModule implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Drops the old menu-wide unique name index; names are now unique per category. Idempotent. */
  async onModuleInit() {
    try {
      const items = this.connection.collection('menu_items');
      if ((await items.indexes()).some((i) => i.name === 'name_1')) {
        await items.dropIndex('name_1');
        new Logger('MenuModule').log('dropped legacy index menu_items.name_1');
      }
    } catch (err: any) {
      if (err?.codeName !== 'NamespaceNotFound') throw err;
    }
  }
}
