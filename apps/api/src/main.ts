// @payswitch/api — entrée NestJS (spec §14 : API NestJS + runtime Bun).
// Validation globale (DTOs class-validator → 422 spec §7.2), erreurs uniformes
// spec §7.3, request_id/correlation_id par requête (header X-Request-Id),
// Swagger /docs. setupApp() est réutilisé par l'E2E.

import "reflect-metadata";
import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import { AppModule } from "./app.module";
import { UniformExceptionFilter } from "./common/uniform-exception.filter";
import { requestIdMiddleware } from "./common/request-id.middleware";

export function setupApp(app: INestApplication): void {
  // Corps brut conservé pour verifyWebhookSignature AVANT normalisation (§8.1).
  app.use(
    json({
      limit: "256kb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(requestIdMiddleware);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );
  app.useGlobalFilters(new UniformExceptionFilter());

  const doc = new DocumentBuilder()
    .setTitle("Payswitch API")
    .setDescription("Orchestrateur mobile-money mono-tenant (collect v1)")
    .setVersion("1.0")
    .addApiKey({ type: "apiKey", name: "X-API-Key", in: "header" }, "api-key")
    .build();
  const document = SwaggerModule.createDocument(app, doc);
  SwaggerModule.setup("docs", app, document);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  setupApp(app);
  const port = Number(process.env.API_PORT ?? 3456);
  await app.listen(port, "127.0.0.1");
  // eslint-disable-next-line no-console
  console.log(`payswitch api listening on 127.0.0.1:${port}`);
}

// Démarrage direct uniquement (importé par l'E2E pour setupApp() sans boot).
if (require.main === module) {
  void bootstrap();
}
