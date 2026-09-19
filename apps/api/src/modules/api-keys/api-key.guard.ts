// @payswitch/api — garde X-API-Key (spec §7.1).
// Publique uniquement si @Public(). Attache la clé vérifiée à req.apiKey
// ({name, mode, testMode, scopes}). Échec = 401, sans distinguer les causes.

import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ApiKeysService, type VerifiedKey } from "./api-keys.service";

export const IS_PUBLIC_KEY = "payswitch:public";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const raw = req.header("X-API-Key");
    if (!raw) throw new UnauthorizedException("Missing X-API-Key");
    const verified = await this.keys.verify(raw);
    (req as unknown as { apiKey?: VerifiedKey }).apiKey = verified;
    return true;
  }
}

/** Lit la clé vérifiée posée par ApiKeyGuard. */
export function apiKeyOf(req: unknown): VerifiedKey {
  const key = (req as { apiKey?: VerifiedKey } | null)?.apiKey;
  if (!key) throw new UnauthorizedException("Missing X-API-Key");
  return key;
}
