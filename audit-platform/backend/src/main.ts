import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: ['error', 'warn', 'log'],
    bodyParser: true,
  });
  // Behind exactly one trusted hop (ALB / CloudFront). Never "true": that would
  // let clients choose req.hostname / req.ip via X-Forwarded-* headers.
  const http = app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void; disable(k: string): void };
  http.set('trust proxy', 1);
  http.disable('x-powered-by');
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

void bootstrap();
