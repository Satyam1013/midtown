import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MenuItem } from './schemas/menu-item.schema';

@Injectable()
export class MenuService {
  constructor(@InjectModel(MenuItem.name) private readonly items: Model<MenuItem>) {}

  list(onlyAvailable = false) {
    return this.items.find(onlyAvailable ? { available: true } : {}).sort({ category: 1, name: 1 }).lean();
  }
}
