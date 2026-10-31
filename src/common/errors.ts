import { HttpException, HttpStatus } from '@nestjs/common';

/** HttpException carrying the API's machine-readable code and any extra fields. */
export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ code, message, ...extra }, status);
  }
}

export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new ApiError(HttpStatus.CONFLICT, code, message, extra);
export const notFound = (what: string) =>
  new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
export const badRequest = (code: string, message: string) =>
  new ApiError(HttpStatus.BAD_REQUEST, code, message);
export const forbidden = (code: string, message: string) =>
  new ApiError(HttpStatus.FORBIDDEN, code, message);
export const unauthorized = (code: string, message: string) =>
  new ApiError(HttpStatus.UNAUTHORIZED, code, message);
