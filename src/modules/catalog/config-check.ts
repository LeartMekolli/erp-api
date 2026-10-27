import { Prisma } from '../../generated/prisma/client';
import type { MeasureUnit } from '../files/measurers';
import type { REFUSAL_CODES } from './check-response';
import type { Rule } from './options.service';
import type { ProductForCheck } from './products.service';
import { scaleMeasures } from './scaling';
import type { ScalableMeasure, Sizing } from './scaling';
import { FILES_UNIT_TO_CATALOG } from './units';

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  code: RefusalCode;
  message: string;
  rule_id?: string;
}

export interface CheckInput {
  product: ProductForCheck;
  /** Every option value of the workspace, so unknown keys and rule targets can be named. */
  values: { id: string; key: string; groupId: string; materialId: string | null }[];
  rules: Rule[];
  /** Chosen value key by group key. */
  options: Record<string, string>;
  size?: { scale: Prisma.Decimal } | { named: string };
  /** The design to check: the product's own, or the customer's version; `null` when there is none. */
  file: { status: string; measures: ScalableMeasure[] } | null;
}

export type CheckResult =
  | {
      accepted: true;
      values: { group: string; value: string }[];
      /** The chosen and defaulted value ids, for what they add to or remove from a step chain (Pricing). */
      valueIds: string[];
      materialId: string;
      scale: Prisma.Decimal;
      /** Scaled, in catalog units. */
      measures: ScalableMeasure[];
    }
  | { accepted: false; reasons: Refusal[] };

const ONE = new Prisma.Decimal(1);

/**
 * Accepts or refuses a configuration of a product (Catalog spec C4, B2, B8–B11). Pure: the caller
 * loads everything. Every problem is reported, not just the first.
 */
export function checkConfiguration(input: CheckInput): CheckResult {
  const { product } = input;
  const reasons: Refusal[] = [];
  const valueById = new Map(input.values.map((value) => [value.id, value]));

  // 1. Resolve the chosen keys against the groups the product offers.
  const chosen = new Map<string, string>(); // group id → value id
  for (const [groupKey, valueKey] of Object.entries(input.options)) {
    const group = product.groups.find((candidate) => candidate.key === groupKey);
    if (!group) {
      reasons.push({ code: 'unknown_group', message: `This product offers no option group ${groupKey}` });
      continue;
    }
    const value = input.values.find((candidate) => candidate.groupId === group.id && candidate.key === valueKey);
    if (!value) {
      reasons.push({ code: 'unknown_value', message: `Option group ${groupKey} has no value ${valueKey}` });
    } else if (!group.values.some((offered) => offered.id === value.id)) {
      reasons.push({ code: 'value_not_offered', message: `This product does not offer ${valueKey} for ${groupKey}` });
    } else {
      chosen.set(group.id, value.id);
    }
  }

  // 2. Defaults fill unanswered groups (B10); a required group must end up answered.
  for (const group of product.groups) {
    // A group named with a bad value is already reported; a default must not hide that.
    if (chosen.has(group.id) || Object.hasOwn(input.options, group.key)) continue;
    if (group.defaultValueId) {
      chosen.set(group.id, group.defaultValueId);
    } else if (group.required) {
      reasons.push({ code: 'required_missing', message: `Choose a value for ${group.key}` });
    }
  }

  // 3. Rules, on chosen and default values alike (B9).
  const chosenIds = new Set(chosen.values());
  const keyOf = (id: string) => valueById.get(id)?.key ?? id;
  for (const rule of input.rules) {
    if (!chosenIds.has(rule.valueId)) continue;
    if (rule.kind === 'excludes') {
      const clash = rule.targetValueIds.filter((id) => chosenIds.has(id));
      if (clash.length > 0) {
        reasons.push({
          code: 'rule_excludes',
          message: `${keyOf(rule.valueId)} cannot be combined with ${clash.map(keyOf).join(', ')}`,
          rule_id: rule.id,
        });
      }
    } else if (!rule.targetValueIds.some((id) => chosenIds.has(id))) {
      reasons.push({
        code: 'rule_requires',
        message: `${keyOf(rule.valueId)} requires ${rule.targetValueIds.map(keyOf).join(' or ')}`,
        rule_id: rule.id,
      });
    }
  }

  // 4. Size (B8): range bounds are inclusive; no size means the design as it is.
  const scale = resolveScale(product.sizing, input.size, reasons);

  // 5. The design file (B2). An assembly has none: its parts carry their own (Orders spec, B6).
  const file: CheckInput['file'] = product.kind === 'assembly' ? { status: 'measured', measures: [] } : input.file;
  if (!file) {
    reasons.push({ code: 'file_required', message: 'A measured design file is required' });
  } else if (file.status !== 'measured') {
    reasons.push({ code: 'file_not_measured', message: `The design file is ${file.status}, not measured yet` });
  } else {
    const present = new Set(file.measures.map((measure) => measure.type));
    const missing = product.requiredMeasures.filter((type) => !present.has(type));
    if (missing.length > 0) {
      reasons.push({ code: 'measure_missing', message: `The design file lacks ${missing.join(', ')}` });
    }
  }

  // 6. Exactly one material (B11): the product's own, or the one a chosen value selects.
  const materials = new Set<string>();
  if (product.materialId) materials.add(product.materialId);
  for (const id of chosenIds) {
    const materialId = valueById.get(id)?.materialId;
    if (materialId) materials.add(materialId);
  }
  if (materials.size === 0) {
    reasons.push({ code: 'no_material', message: 'The configuration selects no material' });
  } else if (materials.size > 1) {
    reasons.push({ code: 'conflicting_materials', message: 'The configuration selects more than one material' });
  }

  if (reasons.length > 0 || !file || !scale) {
    return { accepted: false, reasons };
  }
  return {
    accepted: true,
    values: product.groups
      .filter((group) => chosen.has(group.id))
      .map((group) => ({ group: group.key, value: keyOf(chosen.get(group.id) ?? '') })),
    valueIds: [...chosenIds],
    materialId: [...materials][0],
    scale,
    measures: scaleMeasures(file.measures, scale).map((measure) => ({
      ...measure,
      unit: FILES_UNIT_TO_CATALOG[measure.unit as MeasureUnit] ?? measure.unit,
    })),
  };
}

/** The scale a size gives under a sizing, or null with the reason added; no size means the design as it is. */
export function resolveScale(sizing: Sizing, size: CheckInput['size'], reasons: Refusal[]): Prisma.Decimal | null {
  if (!size) {
    if (sizing.mode === 'range' && (ONE.lessThan(sizing.min) || ONE.greaterThan(sizing.max))) {
      reasons.push({ code: 'size_out_of_range', message: `Choose a scale from ${sizing.min} to ${sizing.max}` });
      return null;
    }
    return ONE;
  }
  if (sizing.mode === 'none') {
    reasons.push({ code: 'not_sizeable', message: 'This product comes in one size' });
    return null;
  }
  if (sizing.mode === 'range') {
    if (!('scale' in size)) {
      reasons.push({ code: 'unknown_size', message: `This product is sized by a scale from ${sizing.min} to ${sizing.max}` });
      return null;
    }
    if (size.scale.lessThan(sizing.min) || size.scale.greaterThan(sizing.max)) {
      reasons.push({ code: 'size_out_of_range', message: `The scale must be from ${sizing.min} to ${sizing.max}` });
      return null;
    }
    return size.scale;
  }
  const keys = sizing.sizes.map((named) => named.key).join(', ');
  const named = 'named' in size ? sizing.sizes.find((candidate) => candidate.key === size.named) : undefined;
  if (!named) {
    reasons.push({ code: 'unknown_size', message: `Choose one of the sizes ${keys}` });
    return null;
  }
  return new Prisma.Decimal(named.scale);
}
