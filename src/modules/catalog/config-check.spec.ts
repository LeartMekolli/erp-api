import { Prisma } from '../../generated/prisma/client';
import { checkConfiguration } from './config-check';
import type { CheckInput, CheckResult } from './config-check';
import type { ProductForCheck } from './products.service';

const dec = (value: string) => new Prisma.Decimal(value);

// Ids are short labels; the check never parses them.
const MAT_SILVER = 'mat-silver';
const MAT_BRASS = 'mat-brass';
const MAT_NYLON = 'mat-nylon';
const RULE_REQUIRES = 'rule-gold-needs-silver';
const RULE_EXCLUDES = 'rule-brass-no-polish';

const values: CheckInput['values'] = [
  { id: 'v-silver', key: 'silver_925', groupId: 'g-material', materialId: MAT_SILVER },
  { id: 'v-brass', key: 'brass', groupId: 'g-material', materialId: MAT_BRASS },
  { id: 'v-nylon', key: 'nylon', groupId: 'g-material', materialId: MAT_NYLON },
  { id: 'v-raw', key: 'raw', groupId: 'g-finish', materialId: null },
  { id: 'v-polished', key: 'polished', groupId: 'g-finish', materialId: null },
  { id: 'v-gold', key: 'gold_plated', groupId: 'g-finish', materialId: null },
  { id: 'v-engrave', key: 'yes', groupId: 'g-engraving', materialId: null },
];
const offered = (...ids: string[]) =>
  values.filter((value) => ids.includes(value.id)).map(({ id, key, materialId }) => ({ id, key, materialId }));

/** "Custom cast part": sized 0.5–2, material required, finish defaulting to raw, engraving optional. */
function product(overrides: Partial<ProductForCheck> = {}): ProductForCheck {
  return {
    id: 'p-cast',
    key: 'custom_cast_part',
    kind: 'custom',
    sizing: { mode: 'range', min: '0.5', max: '2' },
    materialId: null,
    requiredMeasures: ['volume', 'bounding_box_x'],
    groups: [
      { id: 'g-material', key: 'material', required: true, defaultValueId: null, values: offered('v-silver', 'v-brass') },
      { id: 'g-finish', key: 'finish', required: true, defaultValueId: 'v-raw', values: offered('v-raw', 'v-polished', 'v-gold') },
      { id: 'g-engraving', key: 'engraving', required: false, defaultValueId: null, values: offered('v-engrave') },
    ],
    design: null,
    ...overrides,
  };
}

const cube = (): NonNullable<CheckInput['file']> => ({
  status: 'measured',
  measures: [
    { type: 'volume', value: dec('1000'), unit: 'mm3' },
    { type: 'surface_area', value: dec('600'), unit: 'mm2' },
    { type: 'bounding_box_x', value: dec('10'), unit: 'mm' },
  ],
});

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    product: product(),
    values,
    rules: [
      { id: RULE_REQUIRES, kind: 'requires', valueId: 'v-gold', targetValueIds: ['v-silver'] },
      { id: RULE_EXCLUDES, kind: 'excludes', valueId: 'v-brass', targetValueIds: ['v-polished'] },
    ],
    options: { material: 'silver_925' },
    file: cube(),
    ...overrides,
  };
}

const codes = (result: CheckResult) => (result.accepted ? [] : result.reasons.map((reason) => reason.code));
const measure = (result: CheckResult, type: string) => {
  if (!result.accepted) throw new Error(`refused: ${JSON.stringify(result.reasons)}`);
  return result.measures.find((candidate) => candidate.type === type)?.value.toFixed(6);
};

describe('checkConfiguration', () => {
  it('accepts silver + polished at 1.5 with scaled measures', () => {
    const result = checkConfiguration(
      input({ options: { material: 'silver_925', finish: 'polished' }, size: { scale: dec('1.5') } }),
    );
    expect(result).toMatchObject({
      accepted: true,
      scale: dec('1.5'),
      materialId: MAT_SILVER,
      values: [
        { group: 'material', value: 'silver_925' },
        { group: 'finish', value: 'polished' },
      ],
    });
    expect(measure(result, 'volume')).toBe('3375.000000');
    expect(measure(result, 'surface_area')).toBe('1350.000000');
    expect(measure(result, 'bounding_box_x')).toBe('15.000000');
  });

  it('refuses brass + gold plated naming the rule', () => {
    const result = checkConfiguration(input({ options: { material: 'brass', finish: 'gold_plated' } }));
    expect(result).toEqual({
      accepted: false,
      reasons: [expect.objectContaining({ code: 'rule_requires', rule_id: RULE_REQUIRES })],
    });
  });

  it('applies an excludes rule whichever value was chosen', () => {
    const result = checkConfiguration(input({ options: { finish: 'polished', material: 'brass' } }));
    expect(result).toEqual({
      accepted: false,
      reasons: [expect.objectContaining({ code: 'rule_excludes', rule_id: RULE_EXCLUDES })],
    });
  });

  it('reports every problem at once', () => {
    const engravingRequired = product();
    engravingRequired.groups[2] = { ...engravingRequired.groups[2], required: true };
    const result = checkConfiguration(
      input({ product: engravingRequired, options: { material: 'brass', finish: 'polished' } }),
    );
    expect(codes(result).sort()).toEqual(['required_missing', 'rule_excludes']);
  });

  it('fills defaults, and checks them like chosen values', () => {
    expect(checkConfiguration(input())).toMatchObject({
      accepted: true,
      values: [
        { group: 'material', value: 'silver_925' },
        { group: 'finish', value: 'raw' },
      ],
    });
    const polishedByDefault = product();
    polishedByDefault.groups[1] = { ...polishedByDefault.groups[1], defaultValueId: 'v-polished' };
    expect(codes(checkConfiguration(input({ product: polishedByDefault, options: { material: 'brass' } })))).toEqual([
      'rule_excludes',
    ]);
  });

  it('counts a required target the product does not offer as unmet', () => {
    const brassOnly = product();
    brassOnly.groups[0] = { ...brassOnly.groups[0], values: offered('v-brass') };
    expect(codes(checkConfiguration(input({ product: brassOnly, options: { material: 'brass', finish: 'gold_plated' } })))).toEqual([
      'rule_requires',
    ]);
  });

  it.each([
    ['unknown_group', { material: 'silver_925', colour: 'red' }],
    ['unknown_value', { material: 'gold' }],
    ['value_not_offered', { material: 'nylon' }],
  ])('refuses with %s', (code, options) => {
    expect(codes(checkConfiguration(input({ options })))).toContain(code);
  });

  it('refuses a required group with no choice and no default', () => {
    const result = checkConfiguration(input({ options: {} }));
    expect(codes(result)).toContain('required_missing');
    expect(result.accepted ? '' : result.reasons[0].message).toMatch(/material/);
  });

  describe('size', () => {
    it('accepts a range scale at its bounds and defaults to 1', () => {
      expect(checkConfiguration(input({ size: { scale: dec('0.5') } })).accepted).toBe(true);
      expect(checkConfiguration(input({ size: { scale: dec('2') } })).accepted).toBe(true);
      expect(checkConfiguration(input())).toMatchObject({ accepted: true, scale: dec('1') });
    });

    it('refuses a scale outside the range', () => {
      expect(codes(checkConfiguration(input({ size: { scale: dec('2.5') } })))).toEqual(['size_out_of_range']);
      expect(codes(checkConfiguration(input({ size: { scale: dec('0.4') } })))).toEqual(['size_out_of_range']);
    });

    it('uses a named size, and refuses an unknown one', () => {
      const named = product({
        sizing: {
          mode: 'named',
          sizes: [
            { key: 'S', scale: '0.9' },
            { key: 'L', scale: '1.1' },
          ],
        },
      });
      const result = checkConfiguration(input({ product: named, size: { named: 'L' } }));
      expect(result).toMatchObject({ accepted: true, scale: dec('1.1') });
      expect(measure(result, 'volume')).toBe('1331.000000');
      expect(codes(checkConfiguration(input({ product: named, size: { named: 'XL' } })))).toEqual(['unknown_size']);
      expect(codes(checkConfiguration(input({ product: named, size: { scale: dec('1.1') } })))).toEqual(['unknown_size']);
    });

    it('refuses any size for a product that is not sizeable', () => {
      const fixed = product({ sizing: { mode: 'none' } });
      expect(checkConfiguration(input({ product: fixed })).accepted).toBe(true);
      expect(codes(checkConfiguration(input({ product: fixed, size: { scale: dec('1') } })))).toEqual(['not_sizeable']);
    });
  });

  describe('file', () => {
    it('needs a file', () => {
      expect(codes(checkConfiguration(input({ file: null })))).toEqual(['file_required']);
    });

    it('needs it measured', () => {
      expect(codes(checkConfiguration(input({ file: { status: 'measuring', measures: [] } })))).toEqual(['file_not_measured']);
    });

    it('needs every measure the category requires', () => {
      const result = checkConfiguration(
        input({ file: { status: 'measured', measures: [{ type: 'bounding_box_x', value: dec('10'), unit: 'mm' }] } }),
      );
      expect(codes(result)).toEqual(['measure_missing']);
      expect(result.accepted ? '' : result.reasons[0].message).toMatch(/volume/);
    });
  });

  describe('material', () => {
    it('refuses a configuration that selects none', () => {
      const optionalMaterial = product();
      optionalMaterial.groups[0] = { ...optionalMaterial.groups[0], required: false };
      expect(codes(checkConfiguration(input({ product: optionalMaterial, options: {} })))).toEqual(['no_material']);
    });

    it("uses the product's fixed material", () => {
      const fixed = product({ materialId: MAT_BRASS });
      fixed.groups[0] = { ...fixed.groups[0], required: false };
      expect(checkConfiguration(input({ product: fixed, options: {} }))).toMatchObject({
        accepted: true,
        materialId: MAT_BRASS,
      });
      expect(checkConfiguration(input({ product: fixed, options: { material: 'brass' } }))).toMatchObject({
        accepted: true,
        materialId: MAT_BRASS,
      });
    });

    it('refuses two different materials', () => {
      const fixed = product({ materialId: MAT_BRASS });
      expect(codes(checkConfiguration(input({ product: fixed, options: { material: 'silver_925' } })))).toEqual([
        'conflicting_materials',
      ]);
    });
  });

  it('reports measures in catalog units', () => {
    const result = checkConfiguration(
      input({ file: { status: 'measured', measures: [...cube().measures, { type: 'page_count', value: dec('2'), unit: 'count' }] } }),
    );
    expect(result.accepted && result.measures.map((m) => m.unit)).toEqual(['mm3', 'mm2', 'mm', 'piece']);
  });
});
