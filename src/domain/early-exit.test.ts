import { describe, expect, it } from 'vitest';
import {
  loadCoefficientTable,
  loadRefurbishmentCosts,
  loadResidualCurves,
  loadVatRates,
} from '@/data/load';
import type { AssetCondition } from '@/data/schemas';
import {
  billedMonthsAsOf,
  calculateEarlyExit,
  checkReturnInspection,
  worseCondition,
  earlyExitForContract,
  type EarlyExitInput,
  outstandingBalanceCents,
} from './early-exit';
import { calculateContractQuote } from './contract-pricing';

// Scenario card 1 / card 8: ebike-003, 36 months, no down payment, signed 5 Nov 2026.
// Net list price 389 000, band B (7.9 %), rent 10 730, buyout 58 350 (data/DATA.md).
const CARD_1 = {
  signedOn: '2026-11-05',
  termMonths: 36,
  monthlyNetRentCents: 10_730,
  buyoutNetCents: 58_350,
  annualInterestPercent: 7.9,
  firstListPriceCents: 389_000,
  category: 'e_bike',
  usage: { unit: 'km', value: 0 },
  usageAtStartValue: 0,
} as const;

async function cardInput(
  asOf: string,
  overrides: Partial<EarlyExitInput> = {}
): Promise<EarlyExitInput> {
  return {
    ...CARD_1,
    asOf,
    condition: 'good',
    refurbishmentRules: (await loadRefurbishmentCosts()).e_bike.fixed,
    residualCurves: await loadResidualCurves(),
    vatRates: await loadVatRates(),
    ...overrides,
  };
}

describe('billedMonthsAsOf', () => {
  it('counts the first row on the signing day', () => {
    expect(billedMonthsAsOf('2026-11-05', 36, '2026-11-05')).toBe(1);
  });

  it('counts a row on its due date and not a day earlier', () => {
    expect(billedMonthsAsOf('2026-11-05', 36, '2027-05-04')).toBe(6);
    expect(billedMonthsAsOf('2026-11-05', 36, '2027-05-05')).toBe(7);
  });

  it('is 0 before the lease starts', () => {
    expect(billedMonthsAsOf('2026-11-05', 36, '2026-11-04')).toBe(0);
  });

  it('stops at the term, however late the date is', () => {
    expect(billedMonthsAsOf('2026-11-05', 36, '2029-10-05')).toBe(36);
    expect(billedMonthsAsOf('2026-11-05', 36, '2040-01-01')).toBe(36);
  });

  it('clamps the due day in short months (31 January start)', () => {
    expect(billedMonthsAsOf('2027-01-31', 12, '2027-02-27')).toBe(1);
    expect(billedMonthsAsOf('2027-01-31', 12, '2027-02-28')).toBe(2);
  });

  it('rejects bad dates and terms', () => {
    expect(() => billedMonthsAsOf('5.11.2026', 36, '2027-05-05')).toThrow(RangeError);
    expect(() => billedMonthsAsOf('2026-11-05', 36, 'soon')).toThrow(RangeError);
    expect(() => billedMonthsAsOf('2026-11-05', 0, '2027-05-05')).toThrow(RangeError);
  });
});

describe('outstandingBalanceCents', () => {
  const base = {
    monthlyNetRentCents: 10_730,
    buyoutNetCents: 58_350,
    annualInterestPercent: 7.9,
  };

  it('is exactly the buyout when no months remain', () => {
    expect(outstandingBalanceCents({ ...base, remainingMonths: 0 })).toBe(58_350);
  });

  it('is about the financed amount at signing (388 992 against 389 000)', () => {
    expect(outstandingBalanceCents({ ...base, remainingMonths: 36 })).toBe(388_992);
  });

  it('is 330 666 with 29 months left (card 8)', () => {
    expect(outstandingBalanceCents({ ...base, remainingMonths: 29 })).toBe(330_666);
  });

  it('is the plain sum when the interest rate is 0', () => {
    expect(
      outstandingBalanceCents({ ...base, annualInterestPercent: 0, remainingMonths: 10 })
    ).toBe(10 * 10_730 + 58_350);
  });

  it('rejects values that are not whole cents, negative, or non-finite', () => {
    const ok = { ...base, remainingMonths: 5 };
    expect(() => outstandingBalanceCents({ ...ok, monthlyNetRentCents: 10.5 })).toThrow(RangeError);
    expect(() => outstandingBalanceCents({ ...ok, buyoutNetCents: -1 })).toThrow(RangeError);
    expect(() => outstandingBalanceCents({ ...ok, annualInterestPercent: -0.1 })).toThrow(
      RangeError
    );
    expect(() => outstandingBalanceCents({ ...ok, annualInterestPercent: Number.NaN })).toThrow(
      RangeError
    );
    expect(() => outstandingBalanceCents({ ...ok, remainingMonths: 2.5 })).toThrow(RangeError);
  });

  it('rejects a rate with more than two decimals, which has no exact basis-point value', () => {
    expect(() =>
      outstandingBalanceCents({ ...base, annualInterestPercent: 7.905, remainingMonths: 5 })
    ).toThrow(RangeError);
  });

  it('rounds an exact half cent up', () => {
    // 1200 % a year is 100 % a month, so one rent of 1 or 3 cents is worth exactly 0.5 or 1.5.
    const half = { buyoutNetCents: 0, annualInterestPercent: 1200, remainingMonths: 1 };
    expect(outstandingBalanceCents({ ...half, monthlyNetRentCents: 1 })).toBe(1);
    expect(outstandingBalanceCents({ ...half, monthlyNetRentCents: 3 })).toBe(2);
  });

  it('stays within a cent of the floating-point formula for every month and band rate', () => {
    for (const annualInterestPercent of [0, 4.9, 5.9, 6.9, 7.9, 9.9, 12.5]) {
      const r = annualInterestPercent / 12 / 100;
      for (let m = 0; m <= 48; m += 1) {
        let float = 58_350 / (1 + r) ** m;
        for (let i = 1; i <= m; i += 1) float += 10_730 / (1 + r) ** i;
        const exact = outstandingBalanceCents({
          ...base,
          annualInterestPercent,
          remainingMonths: m,
        });
        expect(Math.abs(exact - float)).toBeLessThanOrEqual(0.5 + 1e-6);
      }
    }
  });
});

describe('calculateEarlyExit', () => {
  it('prices scenario card 8: exit in month 7, good condition, 0 km', async () => {
    const quote = calculateEarlyExit(await cardInput('2027-05-05'));

    expect(quote.billedMonths).toBe(7);
    expect(quote.remainingMonths).toBe(29);
    expect(quote.nominalRemainingRentsCents).toBe(29 * 10_730);
    expect(quote.balanceCents).toBe(330_666);
    // 389 000 × 80 % (age 7: 82 % at 6, 70 % at 12) × 0.85 (good) = 264 520
    expect(quote.marketValue).toEqual({
      ageMonths: 7,
      curvePercent: 80,
      usageValue: 0,
      valueCents: 264_520,
    });
    // Under 15 000 km only the 45 € safety inspection is needed: credit 264 520 - 4 500.
    expect(quote.refurbishment.totalCents).toBe(4_500);
    expect(quote.returnCreditCents).toBe(260_020);

    expect(quote.buyout.netCents).toBe(330_666);
    // 330 666 - 260 020
    expect(quote.returnItem.netCents).toBe(70_646);
  });

  it('charges VAT at the rate on the exit date (26 % from 2027)', async () => {
    const quote = calculateEarlyExit(await cardInput('2027-05-05'));

    // 70 646 × 26 % = 18 367.96 -> 18 368
    expect(quote.returnItem.settlement).toMatchObject({
      buyoutNetCents: 70_646,
      vatRatePercent: 26,
      vatCents: 18_368,
      grossCents: 89_014,
    });
    // 330 666 × 26 % = 85 973.16 -> 85 973
    expect(quote.buyout.settlement).toMatchObject({ vatCents: 85_973, grossCents: 416_639 });
  });

  it('uses 25.5 % for an exit in 2026', async () => {
    const quote = calculateEarlyExit(await cardInput('2026-12-05'));
    expect(quote.buyout.settlement.vatRatePercent).toBe(25.5);
  });

  it('shows every line and the lines add up to the net amount', async () => {
    const quote = calculateEarlyExit(await cardInput('2027-05-05'));

    expect(quote.buyout.lines.map((l) => l.key)).toEqual([
      'remainingRents',
      'buyout',
      'interestNotCharged',
    ]);
    expect(quote.returnItem.lines.map((l) => l.key)).toEqual([
      'remainingRents',
      'buyout',
      'interestNotCharged',
      'returnCredit',
      'refurbishment',
    ]);
    // 29 × 10 730 = 311 170; + 58 350 buyout; - interest not charged = balance 330 666
    expect(quote.buyout.lines.map((l) => l.amountCents)).toEqual([311_170, 58_350, -38_854]);
    expect(quote.returnItem.lines.slice(-2)).toEqual([
      { key: 'returnCredit', amountCents: -264_520, params: { ageMonths: 7, usageValue: 0 } },
      { key: 'refurbishment', amountCents: 4_500, params: {} },
    ]);
    for (const option of [quote.buyout, quote.returnItem]) {
      expect(option.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(option.netCents);
    }
  });

  it('month 1: the whole term is still to come', async () => {
    const quote = calculateEarlyExit(await cardInput('2026-11-05'));

    expect(quote.billedMonths).toBe(1);
    expect(quote.remainingMonths).toBe(35);
    expect(quote.balanceCents).toBe(380_823);
    // 389 000 × 97 % (age 1) × 0.85 = 320 730.5, rounded half up to 320 731
    expect(quote.marketValue.valueCents).toBe(320_731);
    expect(quote.returnItem.netCents).toBe(380_823 - (320_731 - 4_500));
  });

  it('final month: the buyout option equals the end-of-term buyout and returning is free', async () => {
    const quote = calculateEarlyExit(await cardInput('2029-10-05'));

    expect(quote.billedMonths).toBe(36);
    expect(quote.remainingMonths).toBe(0);
    expect(quote.buyout.netCents).toBe(CARD_1.buyoutNetCents);
    expect(quote.buyout.lines.map((l) => l.amountCents)).toEqual([0, 58_350, 0]);
    expect(quote.returnItem.netCents).toBe(0);
  });

  it('after the term has ended: same as the final month', async () => {
    const final = calculateEarlyExit(await cardInput('2029-10-05'));
    const later = calculateEarlyExit(await cardInput('2031-03-01'));

    expect(later.billedMonths).toBe(36);
    expect(later.buyout.netCents).toBe(final.buyout.netCents);
    expect(later.returnItem.netCents).toBe(0);
  });

  it('one month before the end costs about the buyout plus one discounted rent', async () => {
    const quote = calculateEarlyExit(await cardInput('2029-09-05'));

    expect(quote.remainingMonths).toBe(1);
    // (10 730 + 58 350) / (1 + 0.079 / 12) = 68 628
    expect(quote.balanceCents).toBe(68_628);
  });

  it('never charges less than nothing: a returned item worth more than the balance is free', async () => {
    // Month 30, as new: 389 000 × 46 % = 178 940, more than the balance (about 120 000).
    const quote = calculateEarlyExit(await cardInput('2029-04-05', { condition: 'new' }));

    expect(quote.remainingMonths).toBe(6);
    expect(quote.marketValue.valueCents).toBeGreaterThan(quote.balanceCents);
    expect(quote.returnItem.netCents).toBe(0);
    const adjustment = quote.returnItem.lines.find((l) => l.key === 'returnAdjustment');
    expect(adjustment?.amountCents).toBeGreaterThan(0);
    expect(quote.returnItem.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(0);
  });

  it('never charges more than the rents still to come, even for a worthless item', async () => {
    const quote = calculateEarlyExit(await cardInput('2027-05-05', { firstListPriceCents: 1_000 }));

    expect(quote.returnItem.netCents).toBe(quote.nominalRemainingRentsCents);
    const adjustment = quote.returnItem.lines.find((l) => l.key === 'returnAdjustment');
    expect(adjustment?.amountCents).toBeLessThan(0);
    expect(quote.returnItem.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(
      quote.returnItem.netCents
    );
  });

  it('a worse condition costs more to return', async () => {
    const results: Record<AssetCondition, number> = {
      new: 0,
      like_new: 0,
      good: 0,
      fair: 0,
      poor: 0,
    };
    for (const condition of Object.keys(results) as AssetCondition[]) {
      results[condition] = calculateEarlyExit(
        await cardInput('2027-05-05', { condition })
      ).returnItem.netCents;
    }
    expect(results.new).toBeLessThanOrEqual(results.like_new);
    expect(results.like_new).toBeLessThanOrEqual(results.good);
    expect(results.good).toBeLessThanOrEqual(results.fair);
    expect(results.fair).toBeLessThanOrEqual(results.poor);
    expect(results.poor).toBeGreaterThan(results.new);
  });

  it('a returned item costs more to return the more it was used', async () => {
    const at = async (km: number) =>
      calculateEarlyExit(await cardInput('2027-05-05', { usage: { unit: 'km', value: km } }))
        .returnItem.netCents;
    expect(await at(2_000)).toBeGreaterThan(await at(0));
    expect(await at(9_000)).toBeGreaterThan(await at(2_000));
  });

  it('from 15 000 km a new battery is deducted and the item is valued as if at 0 km', async () => {
    const quote = calculateEarlyExit(
      await cardInput('2027-05-05', { usage: { unit: 'km', value: 15_000 } })
    );
    expect(quote.refurbishment.steps.map((s) => s.id)).toEqual([
      'battery_replacement',
      'safety_inspection',
    ]);
    expect(quote.marketValue).toMatchObject({ usageValue: 0, valueCents: 264_520 });
    // 264 520 - 35 000 - 4 500
    expect(quote.returnCreditCents).toBe(225_020);
    expect(quote.returnItem.netCents).toBe(330_666 - 225_020);
  });

  it('refurbishment never makes the credit negative', async () => {
    // A 10 € item is worth about 6.80 € at 7 months: the 45 € inspection only cancels it.
    const quote = calculateEarlyExit(await cardInput('2027-05-05', { firstListPriceCents: 1_000 }));
    expect(quote.returnCreditCents).toBe(0);
    const refurbishment = quote.returnItem.lines.find((l) => l.key === 'refurbishment');
    expect(refurbishment?.amountCents).toBe(quote.marketValue.valueCents);
  });

  it('rejects a usage at exit below the usage at the start', async () => {
    await expect(async () =>
      calculateEarlyExit(
        await cardInput('2027-05-05', {
          usage: { unit: 'km', value: 100 },
          usageAtStartValue: 200,
        })
      )
    ).rejects.toThrow(/below the usage at the start/);
    await expect(async () =>
      calculateEarlyExit(await cardInput('2027-05-05', { usageAtStartValue: -1 }))
    ).rejects.toThrow(RangeError);
  });

  it('rejects an exit date before the lease starts', async () => {
    await expect(async () => calculateEarlyExit(await cardInput('2026-11-04'))).rejects.toThrow(
      RangeError
    );
  });

  it('rejects a category without a residual curve', async () => {
    await expect(async () =>
      calculateEarlyExit(await cardInput('2027-05-05', { category: 'spaceship' as never }))
    ).rejects.toThrow(/No residual curve/);
  });

  it('holds its invariants in every month of the term and for every condition', async () => {
    const conditions: AssetCondition[] = ['new', 'like_new', 'good', 'fair', 'poor'];
    for (const condition of conditions) {
      let previousBalance = Number.POSITIVE_INFINITY;
      for (let month = 1; month <= CARD_1.termMonths; month += 1) {
        // The row of month n falls on the 5th: 2026-11-05 plus n - 1 months.
        const asOf = billedDate(month);
        const quote = calculateEarlyExit(await cardInput(asOf, { condition }));

        expect(quote.billedMonths).toBe(month);
        // The early-buyout price never goes up as time passes.
        expect(quote.balanceCents).toBeLessThanOrEqual(previousBalance);
        previousBalance = quote.balanceCents;
        // The return cost is between nothing and the rents still to come.
        expect(quote.returnItem.netCents).toBeGreaterThanOrEqual(0);
        expect(quote.returnItem.netCents).toBeLessThanOrEqual(quote.nominalRemainingRentsCents);
        // The lines always add up to the amount and the gross is net plus VAT.
        for (const option of [quote.buyout, quote.returnItem]) {
          expect(option.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(option.netCents);
          expect(option.settlement.grossCents).toBe(option.netCents + option.settlement.vatCents);
        }
      }
    }
  });
});

/** The due date of rent row `month` for the card 1 contract (signed on the 5th). */
function billedDate(month: number): string {
  const index = 10 + month - 1; // November 2026 is month index 10 of year 2026
  const year = 2026 + Math.floor(index / 12);
  const monthOfYear = (index % 12) + 1;
  return `${year}-${String(monthOfYear).padStart(2, '0')}-05`;
}

describe('earlyExitForContract', () => {
  async function card1(exitMonth: number, usageValue = 0) {
    const [coefficientTable, refurbishmentCosts, residualCurves, vatRates] = await Promise.all([
      loadCoefficientTable(),
      loadRefurbishmentCosts(),
      loadResidualCurves(),
      loadVatRates(),
    ]);
    const result = calculateContractQuote({
      listPriceCents: 389_000,
      priceListVersion: 1,
      downPaymentCents: 0,
      termMonths: 36,
      isoDate: '2026-11-05',
      coefficientTable,
      vatRates,
    });
    if (!result.ok) throw new Error('card 1 quote failed');
    return earlyExitForContract({
      quote: result.quote,
      signedOn: '2026-11-05',
      exitMonth,
      inspection: { condition: 'good', usageValue },
      asset: { category: 'e_bike', usage: { unit: 'km', value: 0 } },
      refurbishmentCosts,
      residualCurves,
      vatRates,
    });
  }

  it('prices card 8 from the signed contract: month 7 is the rent row of 5 May 2027', async () => {
    const quote = await card1(7);
    expect(quote.asOf).toBe('2027-05-05');
    expect(quote.remainingMonths).toBe(29);
    expect(quote.buyout.netCents).toBe(330_666);
    expect(quote.returnItem.netCents).toBe(70_646);
  });

  it('values the item at the inspected usage, not the reading from the start of the lease', async () => {
    // 6 000 km: -12 % usage adjustment. 389 000 × 80 % × 0.85 × 0.88 = 232 777.6 -> 232 778
    const quote = await card1(7, 6_000);
    expect(quote.marketValue).toMatchObject({ usageValue: 6_000, valueCents: 232_778 });
    expect(quote.returnItem.netCents).toBe(330_666 - (232_778 - 4_500));
  });

  it('clamps a month past the term to the last rent row: the end-of-term buyout', async () => {
    const quote = await card1(99);
    expect(quote.asOf).toBe('2029-10-05');
    expect(quote.buyout.netCents).toBe(58_350);
  });

  it('rejects month 0 and fractional months', async () => {
    await expect(card1(0)).rejects.toThrow(RangeError);
    await expect(card1(1.5)).rejects.toThrow(RangeError);
  });
});

describe('checkReturnInspection', () => {
  const recorded = { condition: 'good', usageValue: 1_200 } as const;

  it('accepts the same or a worse condition and the same or a higher reading', () => {
    expect(checkReturnInspection(recorded, { condition: 'good', usageValue: 1_200 })).toEqual({
      ok: true,
    });
    expect(checkReturnInspection(recorded, { condition: 'poor', usageValue: 9_000 })).toEqual({
      ok: true,
    });
  });

  it('rejects a reading below the one recorded at the start of the lease', () => {
    expect(checkReturnInspection(recorded, { condition: 'good', usageValue: 1_199 })).toEqual({
      ok: false,
      problem: 'usage_decreased',
    });
  });

  it('rejects an item that comes back in better condition than it left in', () => {
    expect(checkReturnInspection(recorded, { condition: 'like_new', usageValue: 1_200 })).toEqual({
      ok: false,
      problem: 'condition_improved',
    });
  });

  it('rejects a negative or fractional reading', () => {
    for (const usageValue of [-1, 1_250.5, Number.NaN]) {
      expect(checkReturnInspection(recorded, { condition: 'good', usageValue })).toEqual({
        ok: false,
        problem: 'invalid_usage',
      });
    }
  });
});

describe('worseCondition', () => {
  it('picks the worse of two conditions, in either order', () => {
    expect(worseCondition('good', 'new')).toBe('good');
    expect(worseCondition('new', 'good')).toBe('good');
    expect(worseCondition('poor', 'fair')).toBe('poor');
    expect(worseCondition('like_new', 'like_new')).toBe('like_new');
  });
});
