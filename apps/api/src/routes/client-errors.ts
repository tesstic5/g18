import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../lib/core';
import { rateLimitFactory } from '../middleware';

const clientErrorSchema = z
  .object({
    message: z.string().max(2000),
    name: z.string().max(120).optional(),
    digest: z.string().max(250).optional(),
    componentStack: z.string().max(12000).optional(),
    path: z.string().max(1000).optional(),
    buildId: z.string().max(200).optional(),
    userAgent: z.string().max(1000).optional(),
  })
  .strict();

/** Client render/chunk error telemetry. No credentials or user-entered form data. */
export async function clientErrorRoutes(app: FastifyInstance) {
  app.post(
    '/',
    { preHandler: [rateLimitFactory('api', (request) => request.ip)] },
    async (request) => {
      const report = clientErrorSchema.parse(request.body);
      request.log.error(
        { clientError: report, requestId: request.requestId },
        'client render error'
      );
      return ok({ recorded: true }, request.requestId!);
    }
  );
}
