import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { conflict, notFound } from '../common/errors';
import { toD128 } from '../common/utils/money';
import { UploadedFileLike } from '../customers/customer-documents.service';
import { ImageStorageService } from '../files/image-storage.service';
import { CreateMenuItemDto } from './dto/menu.dto';
import { MenuItem } from './schemas/menu-item.schema';

const COLLATION = { locale: 'en', strength: 2 };
const FIELDS = 'name description price category isVeg photoUrl available';

@Injectable()
export class MenuService {
  constructor(
    @InjectModel(MenuItem.name) private readonly items: Model<MenuItem>,
    private readonly storage: ImageStorageService,
  ) {}

  list(onlyAvailable = false) {
    return this.items.find(onlyAvailable ? { available: true } : {}).select(FIELDS).sort({ category: 1, name: 1 }).lean();
  }

  async create(dto: CreateMenuItemDto) {
    const name = dto.name.trim();
    const category = dto.category.trim();
    const taken = () => conflict('MENU_ITEM_EXISTS', `${name} is already on the menu under ${category}`);
    if (await this.items.exists({ name, category }).collation(COLLATION)) throw taken();
    try {
      return await this.items.create({
        name,
        category,
        description: dto.description?.trim() ?? '',
        price: toD128(dto.price),
        isVeg: dto.isVeg ?? true,
        available: dto.available ?? true,
        photoUrl: null,
      });
    } catch (err: any) {
      if (err?.code === 11000) throw taken();
      throw err;
    }
  }

  /** Saves the photo and points the item at it; the old photo is removed. */
  async setPhoto(id: Types.ObjectId, file: UploadedFileLike | undefined) {
    const item = await this.items.findById(id);
    if (!item) throw notFound('Menu item');
    const saved = await this.storage.save(file, { menuItemId: id });
    const old = ImageStorageService.idOf(item.photoUrl);
    item.photoUrl = saved.url;
    await item.save();
    if (old) await this.storage.remove(new Types.ObjectId(old));
    return item;
  }
}
