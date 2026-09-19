// @payswitch/api — erreurs uniformes spec §7.3 :
// { error: { code, message, details, request_id } }. Mappe CoreError vers le
// bon statut (409 IDEMPOTENCY_KEY_REUSED, 422 métier, 400 validation) sans
// jamais exposer secrets ni traces internes.

import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { CoreError } from "@payswitch/core";
import { requestIdOf } from "./request-id.middleware";

const CORE_STATUS: Record<string, number> = {
  IDEMPOTENCY_KEY_REUSED: HttpStatus.CONFLICT,
  NO_SUPPORTED_PROVIDER: HttpStatus.UNPROCESSABLE_ENTITY,
  UNKNOWN_NETWORK: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_AMOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_ROUTE: HttpStatus.UNPROCESSABLE_ENTITY,
  VERIFICATION_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_TRANSITION: HttpStatus.CONFLICT,
  PAYMENT_FINAL: HttpStatus.CONFLICT,
  WEBHOOK_SIGNATURE_INVALID: HttpStatus.FORBIDDEN,
  WEBHOOK_DUPLICATE: HttpStatus.OK,
  PROVIDER_ERROR: HttpStatus.BAD_GATEWAY,
};

@Catch()
export class UniformExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(UniformExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = requestIdOf(req);

    if (exception instanceof CoreError) {
      const status = CORE_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
      res.status(status).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details ?? {},
          request_id: requestId,
        },
      });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === "string"
          ? body
          : ((body as { message?: unknown }).message ?? exception.message);
      const details =
        typeof body === "object" && body !== null && "details" in body
          ? (body as { details?: unknown }).details
          : typeof body === "object" && body !== null
            ? body
            : {};
      res.status(exception.getStatus()).json({
        error: {
          code: httpCodeToError(exception),
          message: Array.isArray(message) ? message.join("; ") : String(message),
          details: details ?? {},
          request_id: requestId,
        },
      });
      return;
    }
    this.logger.error(`[${requestId}] ${req.method} ${req.url} → 500: ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        details: {},
        request_id: requestId,
      },
    });
  }
}

function httpCodeToError(exception: HttpException): string {
  if (exception instanceof ConflictException) return "CONFLICT";
  if (exception instanceof UnprocessableEntityException) return "UNPROCESSABLE";
  if (exception instanceof BadRequestException) return "BAD_REQUEST";
  return `HTTP_${exception.getStatus()}`;
}
