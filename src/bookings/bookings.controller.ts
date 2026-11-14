import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { API_KEY_SECURITY } from '../config/swagger.config';
import { BookingsService } from './bookings.service';
import { BookingDto } from './dto/booking.dto';

@ApiTags('Bookings')
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid X-API-Key header',
  type: ErrorResponseDto,
})
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a single booking by ID' })
  @ApiParam({ name: 'id', description: 'Booking identifier' })
  @ApiOkResponse({ type: BookingDto })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    type: ErrorResponseDto,
  })
  findOne(@Param('id') id: string): Promise<BookingDto> {
    return this.bookingsService.findOne(id);
  }
}
