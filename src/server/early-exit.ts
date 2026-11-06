// Executes a fair early exit (Smart Problem 2, scenario card 8).
//
// The price is recalculated here from the contract terms with the same pure functions the
// invoices page uses (`earlyExitForContract`), so the browser never sends an amount that we
// then trust. The asset change and its audit row, which carries the whole breakdown, commit in
// one transaction.
//
// A return needs the return inspection: the condition and usage reading found when the item
// came back, and who inspected it. They price the credit for the item and become the asset's
// new record. The app has no login, so this records and checks the inspection (it cannot go
// below the reading or above the condition on record) but cannot prove who made it.
import {
  loadCoefficientTable,
  loadPriceLists,
  loadRefurbishmentCosts,
  loadResidualCurves,
  loadVatRates,
} from '@/data/load';
import type { Asset, AssetStatus } from '@/data/schemas';
import { calculateContractQuote } from '@/domain/contract-pricing';
import {
  checkReturnInspection,
  earlyExitForContract,
  type InspectionProblem,
  type ReturnInspection,
} from '@/domain/early-exit';
import { listPriceOn } from '@/domain/price-list';
import { toAsset } from './assets';
import { withAudit } from './audit';
import type { PrismaClient } from './prisma-client';

export type EarlyExitChoice = 'buyout' | 'return';

export type ExecuteEarlyExitInput = {
  assetId: string;
  choice: EarlyExitChoice;
  /** The signed contract, as the invoices page has it. */
  termMonths: number;
  downPaymentCents: number;
  signedOn: string;
  /** Leave on the due date of this rent row (1 = the first rent). */
  exitMonth: number;
  /** Required for a return; on a return it becomes the asset's condition and usage. */
  inspection?: ReturnInspection & { inspectedBy: string };
  actor: string;
};

export type EarlyExitReceipt = {
  choice: EarlyExitChoice;
  exitDate: string;
  remainingMonths: number;
  netCents: number;
  vatRatePercent: number;
  vatCents: number;
  grossCents: number;
};

export type ExecuteEarlyExitResult =
  | { ok: true; asset: Asset; receipt: EarlyExitReceipt }
  | { ok: false; reason: 'not_found' | 'lease_ended' | 'invalid_contract' }
  | { ok: false; reason: 'invalid_inspection'; problem: InspectionProblem | 'missing' };

/** A lease that was bought out or returned has already ended and cannot be exited again. */
const ENDED_STATUSES: readonly AssetStatus[] = ['sold', 'returned'];

class LeaseEndedError extends Error {}

export async function executeEarlyExit(
  db: PrismaClient,
  input: ExecuteEarlyExitInput
): Promise<ExecuteEarlyExitResult> {
  const row = await db.asset.findUnique({ where: { id: input.assetId } });
  if (!row) return { ok: false, reason: 'not_found' };
  const asset = toAsset(row);
  if (ENDED_STATUSES.includes(asset.status)) return { ok: false, reason: 'lease_ended' };

  const { inspection } = input;
  if (input.choice === 'return') {
    if (!inspection) return { ok: false, reason: 'invalid_inspection', problem: 'missing' };
    const check = checkReturnInspection(
      { condition: asset.condition, usageValue: asset.usage.value },
      inspection
    );
    if (!check.ok) return { ok: false, reason: 'invalid_inspection', problem: check.problem };
  }

  const [priceLists, coefficientTable, refurbishmentCosts, residualCurves, vatRates] =
    await Promise.all([
      loadPriceLists(),
      loadCoefficientTable(),
      loadRefurbishmentCosts(),
      loadResidualCurves(),
      loadVatRates(),
    ]);

  const price = listPriceOn(priceLists, asset.id, input.signedOn);
  if (!price.ok) return { ok: false, reason: 'invalid_contract' };
  const quoted = calculateContractQuote({
    listPriceCents: price.priceCents,
    priceListVersion: price.priceListVersion,
    downPaymentCents: input.downPaymentCents,
    termMonths: input.termMonths,
    isoDate: input.signedOn,
    coefficientTable,
    vatRates,
  });
  if (!quoted.ok) return { ok: false, reason: 'invalid_contract' };

  const exit = earlyExitForContract({
    quote: quoted.quote,
    signedOn: input.signedOn,
    exitMonth: input.exitMonth,
    // A buyout's price does not depend on the item, so without an inspection the record is used.
    inspection: inspection ?? { condition: asset.condition, usageValue: asset.usage.value },
    asset,
    refurbishmentCosts,
    residualCurves,
    vatRates,
  });
  const option = input.choice === 'buyout' ? exit.buyout : exit.returnItem;
  const nextStatus: AssetStatus = input.choice === 'buyout' ? 'sold' : 'returned';
  const receipt: EarlyExitReceipt = {
    choice: input.choice,
    exitDate: exit.asOf,
    remainingMonths: exit.remainingMonths,
    netCents: option.netCents,
    vatRatePercent: option.settlement.vatRatePercent,
    vatCents: option.settlement.vatCents,
    grossCents: option.settlement.grossCents,
  };

  try {
    const updated = await withAudit(
      db,
      {
        actor: input.actor,
        action: input.choice === 'buyout' ? 'lease.early_buyout' : 'lease.early_return',
        entityType: 'asset',
        entityId: asset.id,
        details: {
          from: asset.status,
          to: nextStatus,
          contract: {
            signedOn: input.signedOn,
            termMonths: input.termMonths,
            downPaymentCents: input.downPaymentCents,
            priceListVersion: quoted.quote.priceListVersion,
            monthlyNetRentCents: quoted.quote.monthlyNetRentCents,
            buyoutNetCents: quoted.quote.buyoutNetCents,
          },
          exitMonth: exit.billedMonths,
          ...(input.choice === 'return' && inspection
            ? {
                inspection: {
                  condition: inspection.condition,
                  usage: { unit: asset.usage.unit, value: inspection.usageValue },
                  inspectedBy: inspection.inspectedBy,
                },
                recordedAtStart: { condition: asset.condition, usage: asset.usage },
                refurbishment: exit.refurbishment,
                returnCreditCents: exit.returnCreditCents,
              }
            : {}),
          balanceCents: exit.balanceCents,
          marketValueCents: exit.marketValue.valueCents,
          lines: option.lines.map(({ key, amountCents }) => ({ key, amountCents })),
          ...receipt,
        },
      },
      async (tx) => {
        // Re-check inside the transaction so two clicks cannot both end the same lease.
        const { count } = await tx.asset.updateMany({
          where: { id: asset.id, status: { notIn: [...ENDED_STATUSES] } },
          data:
            input.choice === 'return' && inspection
              ? {
                  status: nextStatus,
                  condition: inspection.condition,
                  usage_value: inspection.usageValue,
                }
              : { status: nextStatus },
        });
        if (count === 0) throw new LeaseEndedError();
        return tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      }
    );
    return { ok: true, asset: toAsset(updated), receipt };
  } catch (error) {
    if (error instanceof LeaseEndedError) return { ok: false, reason: 'lease_ended' };
    throw error;
  }
}
