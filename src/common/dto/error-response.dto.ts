import { ApiProperty } from '@nestjs/swagger';

/**
 * Standard JSON error body returned by GlobalExceptionFilter.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 'unauthorized' })
  error: string;
}
