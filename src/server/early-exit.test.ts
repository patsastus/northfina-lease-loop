// Runs against a real, migrated SQLite database (see tests/global-setup.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAssets } from '@/data/load';
import { createTestDb } from '../../tests/helpers/test-db';
import { seedAssets } from './assets';
import { executeEarlyExit, type ExecuteEarlyExitInput } from './early-exit';
import type { PrismaClient } from './prisma-client';

let db: PrismaClient;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await db.auditLog.deleteMany();
  await db.asset.deleteMany();
  await seedAssets(db, await loadAssets());
  // Aino signed card 1, which reserved the bike.
  await db.asset.update({ where: { id: 'ebike-003' }, data: { status: 'reserved' } });
});

// Scenario card 8: Aino leaves the card 1 lease (ebike-003, 36 months, signed 5 Nov 2026) in
// month 7, the rent row of 5 May 2027.
const CARD_8: ExecuteEarlyExitInput = {
  assetId: 'ebike-003',
  choice: 'buyout',
  termMonths: 36,
  downPaymentCents: 0,
  signedOn: '2026-11-05',
  exitMonth: 7,
  actor: 'cust-aino',
};

// ebike-003 left in 'new' condition at 0 km. It comes back 'fair' with 4 000 km.
const FAIR_RETURN = {
  choice: 'return',
  inspection: { condition: 'fair', usageValue: 4_000, inspectedBy: 'Workshop Vantaa' },
} as const;

async function auditRows() {
  const rows = await db.auditLog.findMany({ orderBy: { id: 'asc' } });
  return rows.map((row) => ({ ...row, details: JSON.parse(row.details_json ?? '{}') }));
}

describe('executeEarlyExit', () => {
  it('buys out card 8 for the balance, sells the asset and audits the breakdown', async () => {
    const result = await executeEarlyExit(db, CARD_8);

    expect(result).toMatchObject({
      ok: true,
      asset: { id: 'ebike-003', status: 'sold' },
      receipt: {
        choice: 'buyout',
        exitDate: '2027-05-05',
        remainingMonths: 29,
        netCents: 330_666,
        vatRatePercent: 26,
        vatCents: 85_973,
        grossCents: 416_639,
      },
    });

    const [row, ...rest] = await auditRows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      actor: 'cust-aino',
      action: 'lease.early_buyout',
      entity_type: 'asset',
      entity_id: 'ebike-003',
      details: {
        from: 'reserved',
        to: 'sold',
        exitMonth: 7,
        netCents: 330_666,
        contract: { monthlyNetRentCents: 10_730, buyoutNetCents: 58_350, priceListVersion: 1 },
      },
    });
    const lineSum = row!.details.lines.reduce(
      (sum: number, line: { amountCents: number }) => sum + line.amountCents,
      0
    );
    expect(lineSum).toBe(330_666);
  });

  it('returns card 8 as inspected: pays the shortfall and records condition and usage', async () => {
    const result = await executeEarlyExit(db, { ...CARD_8, ...FAIR_RETURN });

    // Market value 389 000 × 80 % × 0.65 (fair) × 0.92 (4 000 km: -8 %) = 186 097.6 -> 186 098.
    // Credit 186 098 - 4 500 inspection = 181 598; 330 666 - 181 598 = 149 068.
    expect(result).toMatchObject({
      ok: true,
      asset: { status: 'returned', condition: 'fair', usage: { unit: 'km', value: 4_000 } },
      receipt: { choice: 'return', netCents: 149_068 },
    });
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'lease.early_return',
      details: {
        inspection: {
          condition: 'fair',
          usage: { unit: 'km', value: 4_000 },
          inspectedBy: 'Workshop Vantaa',
        },
        recordedAtStart: { condition: 'new', usage: { unit: 'km', value: 0 } },
        marketValueCents: 186_098,
        returnCreditCents: 181_598,
        refurbishment: { totalCents: 4_500 },
      },
    });
  });

  it('refuses a return without an inspection, or with an impossible one, and writes nothing', async () => {
    await db.asset.update({
      where: { id: 'ebike-003' },
      data: { condition: 'good', usage_value: 1_000 },
    });
    const inspect = (condition: 'like_new' | 'good', usageValue: number) => ({
      ...CARD_8,
      choice: 'return' as const,
      inspection: { condition, usageValue, inspectedBy: 'Workshop Vantaa' },
    });

    expect(await executeEarlyExit(db, { ...CARD_8, choice: 'return' })).toEqual({
      ok: false,
      reason: 'invalid_inspection',
      problem: 'missing',
    });
    expect(await executeEarlyExit(db, inspect('good', 999))).toEqual({
      ok: false,
      reason: 'invalid_inspection',
      problem: 'usage_decreased',
    });
    expect(await executeEarlyExit(db, inspect('like_new', 1_000))).toEqual({
      ok: false,
      reason: 'invalid_inspection',
      problem: 'condition_improved',
    });
    expect(await auditRows()).toEqual([]);
    expect((await db.asset.findUniqueOrThrow({ where: { id: 'ebike-003' } })).status).toBe(
      'reserved'
    );
  });

  it('refuses a second exit of the same lease and writes nothing', async () => {
    await executeEarlyExit(db, CARD_8);

    expect(await executeEarlyExit(db, { ...CARD_8, ...FAIR_RETURN })).toEqual({
      ok: false,
      reason: 'lease_ended',
    });
    expect(await auditRows()).toHaveLength(1);
    expect((await db.asset.findUniqueOrThrow({ where: { id: 'ebike-003' } })).status).toBe('sold');
  });

  it('lets only one of two simultaneous exits through', async () => {
    const results = await Promise.all([
      executeEarlyExit(db, CARD_8),
      executeEarlyExit(db, { ...CARD_8, ...FAIR_RETURN }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'lease_ended' }]);
    expect(await auditRows()).toHaveLength(1);
  });

  it('reports an unknown asset', async () => {
    expect(await executeEarlyExit(db, { ...CARD_8, assetId: 'nope' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses contract terms that cannot be priced, without writing anything', async () => {
    expect(await executeEarlyExit(db, { ...CARD_8, termMonths: 13 })).toEqual({
      ok: false,
      reason: 'invalid_contract',
    });
    expect(await executeEarlyExit(db, { ...CARD_8, signedOn: '2025-01-01' })).toEqual({
      ok: false,
      reason: 'invalid_contract',
    });
    expect(await auditRows()).toEqual([]);
  });
});
