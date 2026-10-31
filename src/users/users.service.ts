import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';
import { conflict, notFound } from '../common/errors';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { User } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  list() {
    return this.users.find().sort({ name: 1 }).lean();
  }

  async create(dto: CreateUserDto) {
    const { password, ...rest } = dto;
    try {
      return await this.users.create({ ...rest, passwordHash: await bcrypt.hash(password, 12) });
    } catch (err: any) {
      if (err?.code === 11000) throw conflict('USER_EXISTS', 'A user with this phone or email already exists');
      throw err;
    }
  }

  async update(id: Types.ObjectId, dto: UpdateUserDto) {
    const { password, ...rest } = dto;
    const update: Record<string, unknown> = { $set: { ...rest } };
    if (password) (update.$set as any).passwordHash = await bcrypt.hash(password, 12);
    // Changing credentials, role or status ends the user's existing sessions.
    if (password || rest.role || rest.active !== undefined) update.$inc = { tokenVersion: 1 };
    const user = await this.users.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    if (!user) throw notFound('User');
    return user;
  }
}
