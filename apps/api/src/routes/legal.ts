// apps/api/src/routes/legal.ts — public legal pages (v4)
import type { FastifyInstance } from 'fastify';
import { ok, AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { prisma } from '../db/prisma';
import { sanitizeRichText } from '../lib/sanitize';

export async function legalRoutes(app: FastifyInstance) {
  app.get('/:slug', async (request) => {
    const { slug } = request.params as { slug: string };
    const page = await prisma.legalPage.findUnique({
      where: { slug_language: { slug, language: 'en' } },
    });
    if (!page) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Page not found');
    // D-078: sanitize before serving — content renders via dangerouslySetInnerHTML
    return ok(
      { slug: page.slug, title: page.title, content: sanitizeRichText(page.content) },
      request.requestId!
    );
  });
}
