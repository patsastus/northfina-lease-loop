// Early exit (Smart Problem 2): shows what ending the lease in a chosen month costs, line by
// line, for both options (buy it out, or return it). A server component: the month and the
// return inspection (condition, usage reading, inspector) are entered with a plain GET form,
// so it works without client JavaScript.
import type { ReactNode } from 'react';
import { type AssetCondition, assetConditionSchema, type UsageUnit } from '@/data/schemas';
import type {
  EarlyExitLine,
  EarlyExitOption,
  EarlyExitQuote,
  InspectionProblem,
  ReturnInspection,
} from '@/domain/early-exit';
import { formatEuro } from '@/domain/money';
import { getT } from '@/i18n/get-t';
import { intlLocale, type Locale } from '@/i18n/locales';
import { EarlyExitAction } from './early-exit-action';

const CONDITIONS = assetConditionSchema.options;

export type EarlyExitOptionsProps = {
  locale: Locale;
  quote: EarlyExitQuote;
  /** The contract the page was opened with: sent back unchanged by the form. */
  contract: { asset: string; term: number; down: number; signedOn: string };
  exitMonth: number;
  /** The inspection the quote is priced with. `inspectedBy` is empty until it is entered. */
  inspection: ReturnInspection & { inspectedBy: string };
  /** Set when the entered inspection was impossible and the record was used instead. */
  inspectionProblem?: InspectionProblem;
  /** The asset's record from the start of the lease: the inspection cannot beat it. */
  recorded: { condition: AssetCondition; usage: { unit: UsageUnit; value: number } };
  /** One entry per month of the term, with the formatted date of that month's rent row. */
  monthChoices: { month: number; date: string }[];
  firstListPriceCents: number;
  /** The asset was already bought out or returned, so the lease cannot be exited again. */
  leaseEnded: boolean;
};

/** A percentage with the locale's decimal separator, e.g. 7.9 -> "7,9" in Finnish. */
function percent(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale[locale], { maximumFractionDigits: 2 }).format(value);
}

/** A usage reading with its unit, e.g. "4 000 km". */
function usageText(unit: UsageUnit, value: number, locale: Locale): string {
  return getT(locale)(`usage.${unit}`, {
    value: new Intl.NumberFormat(intlLocale[locale]).format(value),
  });
}

function lineLabel(line: EarlyExitLine, unit: UsageUnit, locale: Locale): string {
  const t = getT(locale);
  switch (line.key) {
    case 'remainingRents':
      return t('invoices.earlyExit.line.remainingRents', {
        months: line.params.months ?? 0,
        rent: formatEuro(line.params.rentCents ?? 0, intlLocale[locale]),
      });
    case 'buyout':
      return t('invoices.earlyExit.line.buyout');
    case 'interestNotCharged':
      return t('invoices.earlyExit.line.interestNotCharged', {
        rate: percent(line.params.annualInterestPercent ?? 0, locale),
      });
    case 'returnCredit':
      return t('invoices.earlyExit.line.returnCredit', {
        months: line.params.ageMonths ?? 0,
        usage: usageText(unit, line.params.usageValue ?? 0, locale),
      });
    case 'refurbishment':
      return t('invoices.earlyExit.line.refurbishment');
    case 'returnAdjustment':
      return line.amountCents > 0
        ? t('invoices.earlyExit.line.returnAdjustmentFloor')
        : t('invoices.earlyExit.line.returnAdjustmentCap');
  }
}

function OptionCard({
  locale,
  unit,
  option,
  title,
  description,
  note,
  action,
}: {
  locale: Locale;
  unit: UsageUnit;
  option: EarlyExitOption;
  title: string;
  description: string;
  note?: string;
  action: ReactNode;
}) {
  const t = getT(locale);
  const money = (cents: number) => formatEuro(cents, intlLocale[locale]);

  return (
    <div className="flex flex-col rounded-[8px] border border-[#dad9d8] bg-[#f7f7f7] p-[20px] dark:border-stone-800 dark:bg-stone-900/60">
      <h3 className="text-[1.125rem] font-bold text-[#353331] dark:text-stone-100">{title}</h3>
      <p className="mt-[6px] text-[0.875rem] text-[#615b57] dark:text-stone-400">{description}</p>

      <ul className="mt-[16px] space-y-[8px] text-[0.875rem]">
        {option.lines.map((line) => (
          <li key={line.key} className="flex items-baseline justify-between gap-[16px]">
            <span className="text-[#615b57] dark:text-stone-400">
              {lineLabel(line, unit, locale)}
            </span>
            <span className="font-mono font-medium whitespace-nowrap tabular-nums">
              {money(line.amountCents)}
            </span>
          </li>
        ))}
      </ul>

      {note ? (
        <p className="mt-[12px] text-[0.75rem] text-[#615b57] dark:text-stone-400">{note}</p>
      ) : null}

      <dl className="mt-[16px] space-y-[8px] border-t border-[#dad9d8] pt-[12px] text-[0.875rem] dark:border-stone-700">
        <div className="flex justify-between gap-[16px]">
          <dt className="text-[#615b57] dark:text-stone-400">
            {t('invoices.earlyExit.total.net')}
          </dt>
          <dd className="font-mono font-medium tabular-nums">{money(option.netCents)}</dd>
        </div>
        <div className="flex justify-between gap-[16px]">
          <dt className="text-[#615b57] dark:text-stone-400">
            {t('invoices.earlyExit.total.vat', {
              rate: percent(option.settlement.vatRatePercent, locale),
            })}
          </dt>
          <dd className="font-mono font-medium tabular-nums">
            {money(option.settlement.vatCents)}
          </dd>
        </div>
        <div className="flex justify-between gap-[16px] text-[1rem] font-bold">
          <dt>{t('invoices.earlyExit.total.gross')}</dt>
          <dd className="font-mono text-[#1354a5] tabular-nums dark:text-sky-400">
            {money(option.settlement.grossCents)}
          </dd>
        </div>
      </dl>
      {action}
    </div>
  );
}

const selectClass =
  'mt-[4px] block w-full rounded-[8px] border border-[#dad9d8] bg-[#FFFFFF] px-[12px] py-[8px] text-[0.875rem] focus:border-[#2877d7] dark:border-stone-700 dark:bg-stone-900';

export function EarlyExitOptions({
  locale,
  quote,
  contract,
  exitMonth,
  inspection,
  inspectionProblem,
  recorded,
  monthChoices,
  firstListPriceCents,
  leaseEnded,
}: EarlyExitOptionsProps) {
  const t = getT(locale);
  const money = (cents: number) => formatEuro(cents, intlLocale[locale]);
  const termOver = quote.remainingMonths === 0;
  const actionFor = (choice: 'buyout' | 'return', option: EarlyExitOption) => (
    <EarlyExitAction
      locale={locale}
      choice={choice}
      contract={contract}
      exitMonth={exitMonth}
      inspection={inspection}
      grossCents={option.settlement.grossCents}
      leaseEnded={leaseEnded}
    />
  );

  return (
    <section
      aria-labelledby="early-exit-heading"
      className="rounded-[12px] border border-[#dad9d8] bg-[#FFFFFF] p-[24px] text-[#353331] shadow-sm dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100"
    >
      <div className="border-b border-[#ededed] pb-[16px] dark:border-stone-800">
        <h2 id="early-exit-heading" className="text-[1.375rem] leading-tight font-bold">
          {t('invoices.earlyExit.heading')}
        </h2>
        <p className="mt-[4px] text-[0.875rem] text-[#615b57] dark:text-stone-400">
          {t('invoices.earlyExit.subheading')}
        </p>
      </div>

      <form
        method="get"
        action={`/${locale}/invoices`}
        className="mt-[16px] grid grid-cols-1 items-end gap-[16px] sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]"
      >
        <input type="hidden" name="asset" value={contract.asset} />
        <input type="hidden" name="term" value={contract.term} />
        <input type="hidden" name="down" value={contract.down} />
        <input type="hidden" name="signedOn" value={contract.signedOn} />

        <label className="text-[0.875rem] font-semibold">
          {t('invoices.earlyExit.monthLabel')}
          <select name="exitMonth" defaultValue={exitMonth} className={selectClass}>
            {monthChoices.map((choice) => (
              <option key={choice.month} value={choice.month}>
                {t('invoices.earlyExit.monthOption', {
                  month: choice.month,
                  total: quote.termMonths,
                  date: choice.date,
                })}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[0.875rem] font-semibold">
          {t('invoices.earlyExit.conditionLabel')}
          <select name="condition" defaultValue={inspection.condition} className={selectClass}>
            {CONDITIONS.slice(CONDITIONS.indexOf(recorded.condition)).map((value) => (
              <option key={value} value={value}>
                {t(`condition.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[0.875rem] font-semibold">
          {t(`invoices.earlyExit.usageLabel.${recorded.usage.unit}`)}
          <input
            type="number"
            name="usage"
            inputMode="numeric"
            min={recorded.usage.value}
            step={1}
            defaultValue={inspection.usageValue}
            className={selectClass}
          />
        </label>

        <label className="text-[0.875rem] font-semibold">
          {t('invoices.earlyExit.inspectedByLabel')}
          <input
            type="text"
            name="inspectedBy"
            maxLength={100}
            defaultValue={inspection.inspectedBy}
            className={selectClass}
          />
        </label>

        <button
          type="submit"
          className="rounded-[8px] bg-[#1a65c1] px-[16px] py-[8px] text-[0.875rem] font-semibold text-[#FFFFFF] transition-colors hover:bg-[#1354a5] dark:bg-sky-600 dark:hover:bg-sky-500"
        >
          {t('invoices.earlyExit.recalculate')}
        </button>
      </form>
      <p className="mt-[8px] text-[0.75rem] text-[#615b57] dark:text-stone-400">
        {t('invoices.earlyExit.conditionHint')}
      </p>
      {inspectionProblem ? (
        <p role="alert" className="mt-[8px] text-[0.875rem] text-[#DC2626]">
          {t(`invoices.earlyExit.inspectionInvalid.${inspectionProblem}`, {
            recorded:
              inspectionProblem === 'condition_improved'
                ? t(`condition.${recorded.condition}`)
                : usageText(recorded.usage.unit, recorded.usage.value, locale),
          })}
        </p>
      ) : null}

      <p className="mt-[16px] text-[0.875rem]">
        {t('invoices.earlyExit.summary', {
          billed: quote.billedMonths,
          remaining: quote.remainingMonths,
          date: monthChoices.find((c) => c.month === exitMonth)?.date ?? quote.asOf,
          vat: percent(quote.buyout.settlement.vatRatePercent, locale),
        })}
      </p>
      <p className="mt-[4px] text-[0.875rem] text-[#615b57] dark:text-stone-400">
        {termOver
          ? t('invoices.earlyExit.termOver')
          : t('invoices.earlyExit.owedExplain', {
              rate: percent(quote.annualInterestPercent, locale),
            })}
      </p>

      <div className="mt-[20px] grid grid-cols-1 gap-[20px] md:grid-cols-2">
        <OptionCard
          locale={locale}
          unit={recorded.usage.unit}
          option={quote.buyout}
          title={t('invoices.earlyExit.buyout.title')}
          description={t('invoices.earlyExit.buyout.description')}
          action={actionFor('buyout', quote.buyout)}
        />
        <OptionCard
          locale={locale}
          unit={recorded.usage.unit}
          option={quote.returnItem}
          title={t('invoices.earlyExit.return.title')}
          description={t('invoices.earlyExit.return.description')}
          note={t('invoices.earlyExit.marketValue', {
            months: quote.marketValue.ageMonths,
            price: money(firstListPriceCents),
            percent: percent(quote.marketValue.curvePercent, locale),
            condition: t(`condition.${inspection.condition}`),
            usage: usageText(recorded.usage.unit, quote.marketValue.usageValue, locale),
            value: money(quote.marketValue.valueCents),
            refurbishment: money(quote.refurbishment.totalCents),
          })}
          action={actionFor('return', quote.returnItem)}
        />
      </div>
    </section>
  );
}
