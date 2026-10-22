import { newId } from '../src/common/ids/uuid';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * A design file with one version, written straight to the database as the
 * measuring job would leave it: a 10 mm cube by default.
 */
export async function measuredDesign(
  prisma: PrismaService,
  tenantId: string,
  userId: string,
  options: { status?: string; measures?: [string, string, string][] } = {},
): Promise<{ fileId: string; versionId: string }> {
  const measures = options.measures ?? [
    ['volume', '1000', 'mm3'],
    ['surface_area', '600', 'mm2'],
    ['bounding_box_x', '10', 'mm'],
    ['bounding_box_y', '10', 'mm'],
    ['bounding_box_z', '10', 'mm'],
  ];
  return prisma.inTenant(tenantId, async (tx) => {
    const file = await tx.file.create({
      data: { kind: 'design', name: 'part.stl', declaredUnit: 'mm', createdByUserId: userId },
    });
    const version = await tx.fileVersion.create({
      data: {
        fileId: file.id,
        number: 1,
        storageKey: `test/${tenantId}/${newId()}`,
        originalName: 'part.stl',
        contentType: 'model/stl',
        size: 684,
        status: options.status ?? 'measured',
        uploadedByUserId: userId,
        completedAt: new Date(),
      },
    });
    await tx.measure.createMany({
      data: measures.map(([type, value, unit]) => ({ fileVersionId: version.id, type, value, unit })),
    });
    return { fileId: file.id, versionId: version.id };
  });
}
