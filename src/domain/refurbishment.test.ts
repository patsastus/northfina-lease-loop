import { describe, expect, it } from 'vitest';
import { loadRefurbishmentCosts } from '@/data/load';
import { fixedRefurbishmentFor, type FixedRefurbishmentRule } from './refurbishment';

const km = (value: number, sinceLastService = value) =>
  ({ unit: 'km', value, sinceLastService }) as const;

describe('fixedRefurbishmentFor', () => {
  it('e-bike under 15 000 km: only the safety inspection (45 €)', async () => {
    const { e_bike } = await loadRefurbishmentCosts();
    const plan = fixedRefurbishmentFor({ rules: e_bike.fixed, usage: km(14_999) });
    expect(plan.steps).toEqual([{ id: 'safety_inspection', count: 1, costCents: 4_500 }]);
    expect(plan.totalCents).toBe(4_500);
    expect(plan.resetsUsage).toBe(false);
  });

  it('e-bike at exactly 15 000 km also needs a battery, which resets the counter', async () => {
    const { e_bike } = await loadRefurbishmentCosts();
    const plan = fixedRefurbishmentFor({ rules: e_bike.fixed, usage: km(15_000) });
    expect(plan.steps.map((step) => step.id)).toEqual(['battery_replacement', 'safety_inspection']);
    expect(plan.totalCents).toBe(35_000 + 4_500);
    expect(plan.resetsUsage).toBe(true);
  });

  it('card 9: ebike-007 at 18 400 km needs a battery and an inspection', async () => {
    const { e_bike } = await loadRefurbishmentCosts();
    expect(fixedRefurbishmentFor({ rules: e_bike.fixed, usage: km(18_400) }).totalCents).toBe(
      39_500
    );
  });

  it('laptop: the data wipe always, the battery from 500 cycles', async () => {
    const { laptop } = await loadRefurbishmentCosts();
    const cycles = (value: number) =>
      ({ unit: 'battery_cycles', value, sinceLastService: 0 }) as const;
    expect(fixedRefurbishmentFor({ rules: laptop.fixed, usage: cycles(499) }).totalCents).toBe(
      2_500
    );
    expect(fixedRefurbishmentFor({ rules: laptop.fixed, usage: cycles(500) }).totalCents).toBe(
      2_500 + 9_000
    );
  });

  it('farm machine: one major service per started 1 000 engine hours of use', async () => {
    const { farm_machine } = await loadRefurbishmentCosts();
    const hours = (value: number, sinceLastService: number) =>
      ({ unit: 'engine_hours', value, sinceLastService }) as const;
    const plan = (value: number, since: number) =>
      fixedRefurbishmentFor({ rules: farm_machine.fixed, usage: hours(value, since) });

    expect(plan(4_000, 0).steps).toEqual([
      { id: 'safety_inspection', count: 1, costCents: 40_000 },
    ]);
    expect(plan(4_001, 1).steps[0]).toEqual({ id: 'major_service', count: 1, costCents: 150_000 });
    expect(plan(5_000, 1_000).steps[0]?.count).toBe(1);
    expect(plan(5_001, 1_001).steps[0]?.count).toBe(2);
    expect(plan(5_001, 1_001).totalCents).toBe(2 * 150_000 + 40_000);
  });

  it('understands every rule in the data pack', async () => {
    const costs = await loadRefurbishmentCosts();
    for (const [category, unit] of [
      ['e_bike', 'km'],
      ['laptop', 'battery_cycles'],
      ['farm_machine', 'engine_hours'],
    ] as const) {
      const usage = { unit, value: 100_000, sinceLastService: 100_000 };
      expect(() => fixedRefurbishmentFor({ rules: costs[category].fixed, usage })).not.toThrow();
    }
  });

  it('throws on a rule it does not understand, instead of skipping a cost', () => {
    const rules: FixedRefurbishmentRule[] = [
      { id: 'paint', cost_cents: 100, when: 'if scratched' },
    ];
    expect(() => fixedRefurbishmentFor({ rules, usage: km(0) })).toThrow(/Unknown refurbishment/);
  });

  it('throws when a rule counts a different unit than the item', () => {
    const rules: FixedRefurbishmentRule[] = [
      { id: 'battery', cost_cents: 100, when: 'usage.value >= 500 battery_cycles' },
    ];
    expect(() => fixedRefurbishmentFor({ rules, usage: km(600) })).toThrow(/counts battery_cycles/);
  });

  it('rejects negative, fractional or inconsistent usage', () => {
    expect(() => fixedRefurbishmentFor({ rules: [], usage: km(-1, 0) })).toThrow(RangeError);
    expect(() => fixedRefurbishmentFor({ rules: [], usage: km(1.5, 0) })).toThrow(RangeError);
    expect(() => fixedRefurbishmentFor({ rules: [], usage: km(10, 11) })).toThrow(RangeError);
    expect(() => fixedRefurbishmentFor({ rules: [], usage: km(10, -1) })).toThrow(RangeError);
  });

  it('no rules: nothing to do', () => {
    expect(fixedRefurbishmentFor({ rules: [], usage: km(0) })).toEqual({
      steps: [],
      totalCents: 0,
      resetsUsage: false,
    });
  });
});
