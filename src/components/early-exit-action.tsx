'use client';

// The button under each early-exit option. Ending a lease cannot be undone, so the first click
// only asks for confirmation with the amount; the second sends the contract terms (never an
// amount) to the server, which prices and records the exit. The page then reloads its data.
// A return also sends the return inspection, and cannot be confirmed until it names who
// inspected the item.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReturnInspection } from '@/domain/early-exit';
import { formatEuro } from '@/domain/money';
import { formatIsoDate } from '@/i18n/format';
import { getT } from '@/i18n/get-t';
import { intlLocale, type Locale } from '@/i18n/locales';

export type EarlyExitActionProps = {
  locale: Locale;
  choice: 'buyout' | 'return';
  contract: { asset: string; term: number; down: number; signedOn: string };
  exitMonth: number;
  /** The inspection shown on the page. Sent with a return; ignored for a buyout. */
  inspection: ReturnInspection & { inspectedBy: string };
  /** Shown on the confirm button. The server recalculates it; this is for the customer only. */
  grossCents: number;
  /** The asset was already bought out or returned when the page loaded. */
  leaseEnded: boolean;
};

type State =
  | { step: 'idle' }
  | { step: 'confirm' }
  | { step: 'saving' }
  | { step: 'done'; exitDate: string; grossCents: number }
  | { step: 'error' };

type Receipt = { exitDate: string; grossCents: number };

export function EarlyExitAction({
  locale,
  choice,
  contract,
  exitMonth,
  inspection,
  grossCents,
  leaseEnded,
}: EarlyExitActionProps) {
  const t = getT(locale);
  const router = useRouter();
  const [state, setState] = useState<State>({ step: 'idle' });
  const money = (cents: number) => formatEuro(cents, intlLocale[locale]);

  async function execute() {
    setState({ step: 'saving' });
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(contract.asset)}/early-exit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choice,
          termMonths: contract.term,
          downPaymentCents: contract.down,
          signedOn: contract.signedOn,
          exitMonth,
          ...(choice === 'return' ? { inspection } : {}),
        }),
      });
      const json = (await response.json()) as { success?: boolean; data?: { receipt: Receipt } };
      if (!response.ok || !json.success || !json.data) throw new Error('early exit failed');
      setState({
        step: 'done',
        exitDate: json.data.receipt.exitDate,
        grossCents: json.data.receipt.grossCents,
      });
      router.refresh();
    } catch {
      setState({ step: 'error' });
    }
  }

  const primary =
    'rounded-[8px] bg-[#1a65c1] px-[16px] py-[8px] text-[0.875rem] font-semibold text-[#FFFFFF] transition-colors hover:bg-[#1354a5] disabled:opacity-60 dark:bg-sky-600 dark:hover:bg-sky-500';
  const secondary =
    'rounded-[8px] border border-[#bfbcbb] px-[16px] py-[8px] text-[0.875rem] font-semibold transition-colors hover:bg-[#ededed] dark:border-stone-600 dark:hover:bg-stone-800';

  if (state.step === 'done') {
    return (
      <p
        role="status"
        className="mt-[16px] text-[0.875rem] font-semibold text-[#14522a] dark:text-emerald-300"
      >
        {t(
          choice === 'buyout'
            ? 'invoices.earlyExit.action.doneBuyout'
            : 'invoices.earlyExit.action.doneReturn',
          {
            date: formatIsoDate(state.exitDate, locale),
            amount: money(state.grossCents),
          }
        )}
      </p>
    );
  }

  if (leaseEnded) {
    return (
      <p className="mt-[16px] text-[0.875rem] text-[#615b57] dark:text-stone-400">
        {t('invoices.earlyExit.action.ended')}
      </p>
    );
  }

  if (choice === 'return' && inspection.inspectedBy.trim() === '') {
    return (
      <p className="mt-[16px] text-[0.875rem] text-[#615b57] dark:text-stone-400">
        {t('invoices.earlyExit.action.needsInspection')}
      </p>
    );
  }

  return (
    <div className="mt-[16px] flex flex-wrap items-center gap-[8px]">
      {state.step === 'idle' || state.step === 'error' ? (
        <button type="button" className={primary} onClick={() => setState({ step: 'confirm' })}>
          {t(
            choice === 'buyout'
              ? 'invoices.earlyExit.action.buyout'
              : 'invoices.earlyExit.action.return'
          )}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={primary}
            disabled={state.step === 'saving'}
            onClick={execute}
          >
            {state.step === 'saving'
              ? t('invoices.earlyExit.action.working')
              : t('invoices.earlyExit.action.confirm', { amount: money(grossCents) })}
          </button>
          <button
            type="button"
            className={secondary}
            disabled={state.step === 'saving'}
            onClick={() => setState({ step: 'idle' })}
          >
            {t('invoices.earlyExit.action.cancel')}
          </button>
        </>
      )}
      {state.step === 'error' ? (
        <p role="alert" className="w-full text-[0.875rem] text-[#DC2626]">
          {t('invoices.earlyExit.action.error')}
        </p>
      ) : null}
    </div>
  );
}
