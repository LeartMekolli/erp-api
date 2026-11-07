import { z } from 'zod';
import type { Prisma, Quote } from '../../generated/prisma/client';
import { quoteInputsSchema } from '../pricing/quote-response';

type Tx = Prisma.TransactionClient;

const keyName = z.strictObject({ key: z.string(), name: z.string() });

/**
 * What a line or part was ordered with, copied by name when the order is placed and never changed, so
 * renaming the catalog later leaves placed orders as they were (Order detail spec, goal 1). Stored on
 * `order_line.picks` and `order_line_part.picks`.
 */
export const linePicksSchema = z.strictObject({
  /** Every option group answered, in the product's order. */
  options: z.array(z.strictObject({ group: keyName, value: keyName })),
  /** As chosen; a named size has no display name of its own. */
  size: quoteInputsSchema.shape.size,
  design_file: z
    .strictObject({
      file_id: z.uuid(),
      file_version_id: z.uuid(),
      name: z.string(),
      /** The customer's own file, which the customer may see; staff-only otherwise (goal 6). */
      customer_owned: z.boolean(),
    })
    .nullable(),
});
export type LinePicks = z.infer<typeof linePicksSchema>;

/**
 * A line's or part's picks, from its quote's inputs and the catalog as it is now. A group the product
 * no longer offers goes after its own, by key. The design file is the quote's, else the product's
 * pinned one (a ready-made product, and so every assembly part).
 */
export async function linePicks(tx: Tx, quote: Pick<Quote, 'productId' | 'inputs'>, customerId: string): Promise<LinePicks> {
  const inputs = quoteInputsSchema.parse(quote.inputs);
  const product = await tx.product.findUniqueOrThrow({
    where: { id: quote.productId },
    select: { fileVersionId: true, optionGroups: { select: { position: true, group: { select: { key: true } } } } },
  });
  const groups = await tx.optionGroup.findMany({
    where: { key: { in: Object.keys(inputs.options) } },
    select: { key: true, name: true, values: { where: { key: { in: Object.values(inputs.options) } }, select: { key: true, name: true } } },
  });
  const position = new Map(product.optionGroups.map((row) => [row.group.key, row.position]));
  const options = Object.entries(inputs.options)
    .map(([groupKey, valueKey]) => {
      const group = groups.find((row) => row.key === groupKey);
      const value = group?.values.find((row) => row.key === valueKey);
      return { group: { key: groupKey, name: group?.name ?? groupKey }, value: { key: valueKey, name: value?.name ?? valueKey } };
    })
    .sort((a, b) => {
      const [first, second] = [position.get(a.group.key) ?? Infinity, position.get(b.group.key) ?? Infinity];
      return first !== second ? first - second : a.group.key.localeCompare(b.group.key);
    });

  const versionId = inputs.file_version_id ?? product.fileVersionId;
  const version = versionId
    ? await tx.fileVersion.findUnique({ where: { id: versionId }, select: { id: true, file: { select: { id: true, name: true, ownerType: true, ownerId: true } } } })
    : null;
  return {
    options,
    size: inputs.size,
    design_file: version
      ? {
          file_id: version.file.id,
          file_version_id: version.id,
          name: version.file.name,
          customer_owned: version.file.ownerType === 'customer' && version.file.ownerId === customerId,
        }
      : null,
  };
}
