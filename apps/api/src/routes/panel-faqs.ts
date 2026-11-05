// apps/api/src/routes/panel-faqs.ts — admin CRUD for FAQ categories + articles.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, AppError } from '../lib/core';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { adminAuthMiddleware } from '../middleware';
import { writeAudit } from '../lib/audit';
import { prisma } from '../db/prisma';

const categoryBody = z.object({
  nameEn: z.string().trim().min(1).max(80),
  nameUr: z.string().trim().max(80).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug must be lowercase letters, numbers, hyphens'
    )
    .optional(),
});

const faqBody = z.object({
  categoryId: z.string().trim().min(1).max(64),
  questionEn: z.string().trim().min(1).max(200),
  questionUr: z.string().trim().max(200).optional(),
  answerEn: z.string().trim().min(1).max(8000),
  answerUr: z.string().trim().max(8000).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isPublished: z.boolean().optional(),
});

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return s || 'category';
}

async function uniqueSlug(base: string, exceptId?: string): Promise<string> {
  const root = slugify(base);
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? root : `${root}-${n + 1}`.slice(0, 48);
    const hit = await prisma.faqCategory.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!hit || hit.id === exceptId) return slug;
  }
  return `${root}-${Date.now().toString(36)}`.slice(0, 48);
}

export async function panelFaqRoutes(app: FastifyInstance) {
  app.get('/faq-categories', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const rows = await prisma.faqCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { faqs: true } } },
    });
    return ok(
      rows.map((c) => ({
        id: c.id,
        slug: c.slug,
        nameEn: c.nameEn,
        nameUr: c.nameUr,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        faqCount: c._count.faqs,
        updatedAt: c.updatedAt,
      })),
      request.requestId!
    );
  });

  app.post(
    '/faq-categories',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const parsed = categoryBody.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          parsed.error.issues[0]?.message ?? 'Invalid category'
        );
      const slug = parsed.data.slug
        ? await uniqueSlug(parsed.data.slug)
        : await uniqueSlug(parsed.data.nameEn);
      const created = await prisma.faqCategory.create({
        data: {
          nameEn: parsed.data.nameEn,
          nameUr: parsed.data.nameUr ?? '',
          sortOrder: parsed.data.sortOrder ?? 0,
          isActive: parsed.data.isActive ?? true,
          slug,
        },
      });
      await writeAudit({
        adminId: request.admin!.id,
        action: 'faq.category.create',
        targetType: 'faq-category',
        targetId: created.id,
        afterState: { nameEn: created.nameEn, slug: created.slug },
        ip: request.ip,
      });
      return ok(created, request.requestId!);
    }
  );

  app.patch(
    '/faq-categories/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const parsed = categoryBody.partial().safeParse(request.body ?? {});
      if (!parsed.success)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          parsed.error.issues[0]?.message ?? 'Invalid category'
        );
      const existing = await prisma.faqCategory.findUnique({ where: { id } });
      if (!existing)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Category not found');
      let slug = existing.slug;
      if (parsed.data.slug && parsed.data.slug !== existing.slug)
        slug = await uniqueSlug(parsed.data.slug, id);
      const updated = await prisma.faqCategory.update({
        where: { id },
        data: {
          ...(parsed.data.nameEn !== undefined ? { nameEn: parsed.data.nameEn } : {}),
          ...(parsed.data.nameUr !== undefined ? { nameUr: parsed.data.nameUr } : {}),
          ...(parsed.data.sortOrder !== undefined
            ? { sortOrder: parsed.data.sortOrder }
            : {}),
          ...(parsed.data.isActive !== undefined
            ? { isActive: parsed.data.isActive }
            : {}),
          slug,
        },
      });
      await writeAudit({
        adminId: request.admin!.id,
        action: 'faq.category.update',
        targetType: 'faq-category',
        targetId: id,
        afterState: parsed.data,
        ip: request.ip,
      });
      return ok(updated, request.requestId!);
    }
  );

  app.delete(
    '/faq-categories/:id',
    { preHandler: [adminAuthMiddleware] },
    async (request) => {
      const { id } = request.params as { id: string };
      const cascade = (request.query as { cascade?: string }).cascade;
      const existing = await prisma.faqCategory.findUnique({
        where: { id },
        include: { _count: { select: { faqs: true } } },
      });
      if (!existing)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Category not found');
      const n = existing._count.faqs;
      const wipe = cascade === '1' || cascade === 'true';
      if (n > 0 && !wipe)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          `This category has ${n} FAQ${n === 1 ? '' : 's'}. Delete them first, or confirm cascade.`
        );
      await prisma.$transaction(async (tx) => {
        if (n > 0) await tx.faq.deleteMany({ where: { categoryId: id } });
        await tx.faqCategory.delete({ where: { id } });
      });
      await writeAudit({
        adminId: request.admin!.id,
        action: 'faq.category.delete',
        targetType: 'faq-category',
        targetId: id,
        afterState: { nameEn: existing.nameEn, cascadedFaqs: n },
        ip: request.ip,
      });
      return ok({ deleted: true, faqsRemoved: n }, request.requestId!);
    }
  );

  app.get('/faqs', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const q = request.query as { categoryId?: string };
    const rows = await prisma.faq.findMany({
      where: q.categoryId ? { categoryId: q.categoryId } : {},
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        category: { select: { id: true, nameEn: true, nameUr: true, slug: true } },
      },
    });
    return ok(rows, request.requestId!);
  });

  app.post('/faqs', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const parsed = faqBody.safeParse(request.body);
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        parsed.error.issues[0]?.message ?? 'Invalid FAQ'
      );
    const cat = await prisma.faqCategory.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true },
    });
    if (!cat) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Category not found');
    const created = await prisma.faq.create({
      data: {
        categoryId: parsed.data.categoryId,
        questionEn: parsed.data.questionEn,
        questionUr: parsed.data.questionUr ?? '',
        answerEn: parsed.data.answerEn,
        answerUr: parsed.data.answerUr ?? '',
        sortOrder: parsed.data.sortOrder ?? 0,
        isPublished: parsed.data.isPublished ?? true,
      },
    });
    await writeAudit({
      adminId: request.admin!.id,
      action: 'faq.create',
      targetType: 'faq',
      targetId: created.id,
      afterState: { questionEn: created.questionEn, categoryId: created.categoryId },
      ip: request.ip,
    });
    return ok(created, request.requestId!);
  });

  app.patch('/faqs/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = faqBody.partial().safeParse(request.body ?? {});
    if (!parsed.success)
      throw new AppError(
        ERROR_CODES.GEN_VALIDATION_ERROR,
        422,
        parsed.error.issues[0]?.message ?? 'Invalid FAQ'
      );
    const existing = await prisma.faq.findUnique({ where: { id } });
    if (!existing) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'FAQ not found');
    if (parsed.data.categoryId && parsed.data.categoryId !== existing.categoryId) {
      const cat = await prisma.faqCategory.findUnique({
        where: { id: parsed.data.categoryId },
        select: { id: true },
      });
      if (!cat)
        throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Category not found');
    }
    const updated = await prisma.faq.update({
      where: { id },
      data: {
        ...(parsed.data.categoryId !== undefined
          ? { categoryId: parsed.data.categoryId }
          : {}),
        ...(parsed.data.questionEn !== undefined
          ? { questionEn: parsed.data.questionEn }
          : {}),
        ...(parsed.data.questionUr !== undefined
          ? { questionUr: parsed.data.questionUr }
          : {}),
        ...(parsed.data.answerEn !== undefined
          ? { answerEn: parsed.data.answerEn }
          : {}),
        ...(parsed.data.answerUr !== undefined
          ? { answerUr: parsed.data.answerUr }
          : {}),
        ...(parsed.data.sortOrder !== undefined
          ? { sortOrder: parsed.data.sortOrder }
          : {}),
        ...(parsed.data.isPublished !== undefined
          ? { isPublished: parsed.data.isPublished }
          : {}),
      },
    });
    await writeAudit({
      adminId: request.admin!.id,
      action: 'faq.update',
      targetType: 'faq',
      targetId: id,
      afterState: parsed.data,
      ip: request.ip,
    });
    return ok(updated, request.requestId!);
  });

  app.delete('/faqs/:id', { preHandler: [adminAuthMiddleware] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.faq.findUnique({
      where: { id },
      select: { id: true, questionEn: true },
    });
    if (!existing) throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'FAQ not found');
    await prisma.faq.delete({ where: { id } });
    await writeAudit({
      adminId: request.admin!.id,
      action: 'faq.delete',
      targetType: 'faq',
      targetId: id,
      afterState: { questionEn: existing.questionEn },
      ip: request.ip,
    });
    return ok({ deleted: true }, request.requestId!);
  });
}
