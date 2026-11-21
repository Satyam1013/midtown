import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { LEGACY_OWNER, Role } from '../../common/enums';
import { STAFF_ROLES } from '../../users/schemas/user.schema';
import { SeedModule } from './seed.module';

// One-off, idempotent: the ADMIN / MANAGER role split.
//  - the owner account (role OWNER) becomes ADMIN; its sessions stay valid
//  - a user with no role, or one the API doesn't know, becomes MANAGER and is signed out
// STAFF and KITCHEN accounts are left as they are.
const log = new Logger('Migrate');

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn', 'log'] });
  try {
    const users = app.get<Connection>(getConnectionToken()).collection('users');
    const owners = await users.updateMany({ role: LEGACY_OWNER }, { $set: { role: Role.ADMIN, updatedAt: new Date() } });
    const unknown = await users.updateMany(
      { role: { $nin: [...STAFF_ROLES] } },
      { $set: { role: Role.MANAGER, updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
    );
    const counts = await users.aggregate<{ _id: string; n: number }>([{ $match: { deletedAt: null } }, { $group: { _id: '$role', n: { $sum: 1 } } }]).toArray();
    log.log(`owner → ADMIN: ${owners.modifiedCount}; no or unknown role → MANAGER: ${unknown.modifiedCount}`);
    log.log(`users by role now: ${counts.map((c) => `${c._id} ${c.n}`).join(', ')}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
