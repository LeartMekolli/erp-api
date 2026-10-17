import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service';
import { emailSchema } from '../modules/identity/email';
import { hashPassword } from '../modules/identity/passwords';

/**
 * Creates a platform admin with a generated password, returned once for the
 * caller to print (plan 2, P2: no password is ever configured). Null when the
 * email already exists.
 */
export async function createPlatformAdmin(
  prisma: PrismaService,
  input: { email: string; name: string },
): Promise<{ email: string; password: string } | null> {
  const email = emailSchema.parse(input.email);
  if (await prisma.platformAdmin.findUnique({ where: { email } })) {
    return null;
  }

  const password = randomBytes(18).toString('base64url');
  await prisma.platformAdmin.create({
    data: { email, name: input.name, passwordHash: await hashPassword(password) },
  });

  return { email, password };
}
