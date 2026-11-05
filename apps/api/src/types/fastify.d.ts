// apps/api/src/types/fastify.d.ts — pulls in fastify plugin type augmentations
import '@fastify/cookie';
import '@fastify/multipart';
import '@fastify/rate-limit';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; role: 'user' | 'demo' | 'admin'; isAdmin?: boolean };
    admin?: import('../generated/prisma/client').AdminUser;
    requestId?: string;
  }
}
