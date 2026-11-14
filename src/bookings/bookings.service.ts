import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  type BookingDto,
  type BookingRow,
  toBookingDto,
} from './dto/booking.dto';

/**
 * Manages clinic bookings using raw SQL queries for exact concurrency control.
 */
@Injectable()
export class BookingsService {
  constructor(private readonly db: DatabaseService) {}

  async findOne(id: string): Promise<BookingDto> {
    const result = await this.db.query<BookingRow>(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings
       WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      throw new NotFoundException('booking not found');
    }

    return toBookingDto(result.rows[0]);
  }
}
