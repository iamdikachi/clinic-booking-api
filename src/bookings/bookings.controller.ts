import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { API_KEY_SECURITY } from '../config/swagger.config';
import { BookingsService } from './bookings.service';
import { BookingDto } from './dto/booking.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import { BookingsListResponseDto } from './dto/list-bookings.dto';

@ApiTags('Bookings')
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid X-API-Key header',
  type: ErrorResponseDto,
})
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a booking for an available future slot',
    description:
      'Enforces per-email rate limiting (5 attempts / 60s), validates inputs, supports Idempotency-Key replays, and atomically books the slot.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Optional idempotency key for safe request retries',
  })
  @ApiBody({ type: CreateBookingDto })
  @ApiCreatedResponse({ type: BookingDto, description: 'Booking confirmed' })
  @ApiBadRequestResponse({
    description: 'Invalid payload or slot start time is in the past',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Slot not found',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Slot already has a confirmed booking',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Idempotency-Key reused with a different request body',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit exceeded (includes Retry-After header)',
    type: ErrorResponseDto,
  })
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingDto> {
    const outcome = await this.bookingsService.create(body, idempotencyKey);
    if (outcome.statusCode >= 400) {
      throw new HttpException(outcome.body, outcome.statusCode);
    }
    res.status(outcome.statusCode);
    return outcome.body as BookingDto;
  }

  @Get()
  @ApiOperation({
    summary: 'List bookings for an email with cursor pagination',
  })
  @ApiQuery({
    name: 'email',
    required: true,
    type: String,
    description: 'Customer email address',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum rows per page (1-50, default 10)',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'Opaque cursor returned by the previous page',
  })
  @ApiOkResponse({ type: BookingsListResponseDto })
  @ApiBadRequestResponse({
    description: 'Missing email or invalid limit/cursor',
    type: ErrorResponseDto,
  })
  list(
    @Query('email') email: string | string[] | undefined,
    @Query('limit') limit: string | string[] | undefined,
    @Query('cursor') cursor: string | string[] | undefined,
  ): Promise<BookingsListResponseDto> {
    return this.bookingsService.list(email, limit, cursor);
  }

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

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a confirmed booking' })
  @ApiParam({ name: 'id', description: 'Booking identifier' })
  @ApiOkResponse({ type: BookingDto, description: 'Booking cancelled' })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Booking is already cancelled',
    type: ErrorResponseDto,
  })
  cancel(@Param('id') id: string): Promise<BookingDto> {
    return this.bookingsService.cancel(id);
  }
}
