import { PERMISSION_AREAS, PERMISSION_CATALOGUE, permissionList, permissionListResponseSchema } from './permission-catalogue';
import { TENANT_PERMISSIONS } from './permissions';

describe('permission catalogue', () => {
  const entries = Object.entries(PERMISSION_CATALOGUE) as [string, { requires: readonly string[]; sensitive: boolean }][];

  it('describes every tenant permission and nothing else', () => {
    expect(Object.keys(PERMISSION_CATALOGUE).sort()).toEqual([...TENANT_PERMISSIONS].sort());
  });

  it('only requires keys that exist, and never itself', () => {
    for (const [key, info] of entries) {
      expect(info.requires).not.toContain(key);
      for (const required of info.requires) expect(TENANT_PERMISSIONS as readonly string[]).toContain(required);
    }
  });

  it('marks exactly the sensitive permissions', () => {
    const sensitive = entries.filter(([, info]) => info.sensitive).map(([key]) => key);
    expect(sensitive.sort()).toEqual(
      [
        'role.write',
        'role.assign',
        'user.deactivate',
        'material.price.override',
        'payment.setup',
        'payment.write',
        'payment.refund',
        'payment.payout',
        'credit.grant',
        'report.export',
        'plan.write',
      ].sort(),
    );
  });

  it('lists 40 permissions by area order, then in TENANT_PERMISSIONS order', () => {
    const list = permissionList();
    expect(list).toHaveLength(40);
    expect(permissionListResponseSchema.safeParse({ data: list }).success).toBe(true);

    const areaOrder = PERMISSION_AREAS.map((area) => area.key as string);
    const areaIndexes = list.map((row) => areaOrder.indexOf(row.area.key));
    expect(areaIndexes).toEqual([...areaIndexes].sort((a, b) => a - b));
    expect(new Set(list.map((row) => row.area.key))).toEqual(new Set(areaOrder));

    for (const area of areaOrder) {
      const keys = list.filter((row) => row.area.key === area).map((row) => row.key);
      const expected = TENANT_PERMISSIONS.filter((key) => keys.includes(key));
      expect(keys).toEqual(expected);
    }
  });
});
