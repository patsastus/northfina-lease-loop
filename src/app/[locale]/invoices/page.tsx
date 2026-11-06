// The signed contract & monthly invoices page (Spine steps 4 & 5):
// /fi/invoices?asset=ebike-003&term=36&down=0&signedOn=2026-06-01
// Computes the locked contract quote as of `signedOn` so later price list changes never alter it,
// and renders the signed contract summary alongside the monthly invoice schedule.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';
import { EarlyExitOptions } from '@/components/early-exit-options';
import { EndOfTermOptions } from '@/components/end-of-term-options';
import { MonthlyInvoices } from '@/components/monthly-invoices';
import {
  loadCo2Factors,
  loadCoefficientTable,
  loadPriceLists,
  loadRefurbishmentCosts,
  loadResidualCurves,
  loadSecondLifeDemand,
  loadVatRates,
} from '@/data/load';
import { assetConditionSchema, isoDateSchema } from '@/data/schemas';
import { calculateContractQuote } from '@/domain/contract-pricing';
import {
  checkReturnInspection,
  earlyExitForContract,
  type ReturnInspection,
  worseCondition,
} from '@/domain/early-exit';
import {
  calculateAvoidedCo2,
  calculateBuyoutSettlement,
  calculateResidualMarketValue,
  matchSecondLifeWaitingList,
} from '@/domain/end-of-term';
import { addMonthsClamped } from '@/domain/invoice-schedule';
import { formatEuro } from '@/domain/money';
import { listPriceOn } from '@/domain/price-list';
import { formatIsoDate } from '@/i18n/format';
import { getT } from '@/i18n/get-t';
import { intlLocale, isLocale, type Locale } from '@/i18n/locales';
import { listAssets } from '@/server/assets';
import { db } from '@/server/db';
import { todayIso } from '@/server/today';

const querySchema = z.object({
  asset: z.string().min(1),
  term: z.coerce.number().int().positive(),
  down: z.coerce.number().int().min(0).default(0),
  signedOn: isoDateSchema.optional(),
  // Early exit: the month of the term to leave in (1 = the first rent) and the return
  // inspection (condition, usage reading, inspector). Only inputs to the calculation; the
  // early-exit route stores them when a return is confirmed.
  exitMonth: z.coerce.number().int().min(1).optional(),
  condition: assetConditionSchema.optional(),
  usage: z.coerce.number().optional(),
  inspectedBy: z.string().trim().max(100).optional(),
});

export default async function InvoicesPage({
  params,
  searchParams,
}: PageProps<'/[locale]/invoices'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await connection();

  const t = getT(locale);
  const intlTag = intlLocale[locale];
  const query = querySchema.safeParse(await searchParams);
  if (!query.success) return <Message locale={locale} text={t('apply.invalidDeal')} />;

  const { asset: assetId, term, down } = query.data;
  const signedOn = query.data.signedOn ?? todayIso();

  const [
    assets,
    priceLists,
    coefficientTable,
    vatRates,
    residualCurves,
    secondLifeDemand,
    co2Factors,
    refurbishmentCosts,
  ] = await Promise.all([
    listAssets(db),
    loadPriceLists(),
    loadCoefficientTable(),
    loadVatRates(),
    loadResidualCurves(),
    loadSecondLifeDemand(),
    loadCo2Factors(),
    loadRefurbishmentCosts(),
  ]);

  const asset = assets.find((a) => a.id === assetId);
  if (!asset) return <Message locale={locale} text={t('apply.notFound')} />;

  const price = listPriceOn(priceLists, asset.id, signedOn);
  if (!price.ok) return <Message locale={locale} text={t('asset.noPrice')} />;

  const result = calculateContractQuote({
    listPriceCents: price.priceCents,
    priceListVersion: price.priceListVersion,
    downPaymentCents: down,
    termMonths: term,
    isoDate: signedOn,
    coefficientTable,
    vatRates,
  });

  if (!result.ok) {
    return <Message locale={locale} text={t('apply.invalidDeal')} />;
  }

  const { quote } = result;
  const formattedSignedDate = formatIsoDate(signedOn, locale);

  const buyoutSettlement = calculateBuyoutSettlement({
    buyoutNetCents: quote.buyoutNetCents,
    asOf: signedOn,
    vatRates,
  });

  const relistPriceCents = calculateResidualMarketValue({
    firstListPriceCents: quote.listPriceCents,
    ageMonths: quote.termMonths,
    category: asset.category,
    condition: asset.condition,
    usage: asset.usage,
    residualCurves,
  });

  const waitingListMatches = matchSecondLifeWaitingList({
    category: asset.category,
    condition: asset.condition,
    relistPriceCents,
    demand: secondLifeDemand,
    asOf: signedOn,
    coefficientTable,
  });

  const avoidedCo2Kg = calculateAvoidedCo2({
    category: asset.category,
    co2Factors,
    relistPriceCents,
    firstListPriceCents: quote.listPriceCents,
  });

  // Early exit: leave in the chosen month (the date of that month's rent row), default month 1.
  const exitMonth = Math.min(query.data.exitMonth ?? 1, quote.termMonths);
  // The return inspection starts from the asset's record (condition and usage at the start of
  // the lease). An impossible inspection is shown as a problem and priced at the record instead.
  const recorded: ReturnInspection = {
    condition: worseCondition('good', asset.condition),
    usageValue: asset.usage.value,
  };
  const requested: ReturnInspection = {
    condition: query.data.condition ?? recorded.condition,
    usageValue: query.data.usage ?? recorded.usageValue,
  };
  const inspectionCheck = checkReturnInspection(
    { condition: asset.condition, usageValue: asset.usage.value },
    requested
  );
  const inspection = inspectionCheck.ok ? requested : recorded;
  const earlyExit = earlyExitForContract({
    quote,
    signedOn,
    exitMonth,
    inspection,
    asset,
    refurbishmentCosts,
    residualCurves,
    vatRates,
  });
  const exitMonthChoices = Array.from({ length: quote.termMonths }, (_, index) => ({
    month: index + 1,
    date: formatIsoDate(addMonthsClamped(signedOn, index), locale),
  }));

  const summaryRows: [string, string][] = [
    [t('apply.deal.item'), `${asset.make} ${asset.model}`],
    [t('invoices.signedDate'), formattedSignedDate],
    [t('apply.deal.term'), t('apply.deal.termValue', { months: quote.termMonths })],
    [
      t('contract.listPrice', { version: quote.priceListVersion }),
      formatEuro(quote.listPriceCents, intlTag),
    ],
    [t('apply.deal.downPayment'), formatEuro(quote.downPaymentCents, intlTag)],
    [t('apply.deal.financed'), formatEuro(quote.financedCents, intlTag)],
    [t('apply.deal.monthlyNetRent'), formatEuro(quote.monthlyNetRentCents, intlTag)],
    [
      t('contract.buyoutOption', { percent: quote.buyoutPercent }),
      formatEuro(quote.buyoutNetCents, intlTag),
    ],
  ];

  return (
    <div className="mx-auto max-w-6xl px-[16px] py-[32px] text-[#353331] sm:px-[24px] sm:py-[48px] dark:text-stone-100">
      <div>
        <Link
          href={`/${locale}`}
          className="inline-flex items-center gap-[8px] text-[0.875rem] font-semibold text-[#1354a5] underline dark:text-sky-400"
        >
          ← {t('invoices.backToCatalogue')}
        </Link>
        <h1 className="mt-[16px] text-[2.25rem] leading-tight font-bold">
          {t('invoices.pageTitle')}
        </h1>
        <p className="mt-[8px] text-[1.125rem] text-[#615b57] dark:text-stone-400">
          {t('invoices.pageIntro')}
        </p>
      </div>

      <div className="mt-[32px] space-y-[32px]">
        {/* Signed contract summary card */}
        <section
          aria-labelledby="contract-summary-heading"
          className="rounded-[12px] border border-[#dad9d8] bg-[#FFFFFF] p-[24px] text-[#353331] shadow-sm dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100"
        >
          <div className="flex flex-wrap items-start justify-between gap-[16px] border-b border-[#ededed] pb-[16px] dark:border-stone-800">
            <div>
              <p className="text-[0.75rem] font-semibold tracking-wider text-[#1354a5] uppercase dark:text-sky-400">
                {t('contract.eyebrow')}
              </p>
              <h2
                id="contract-summary-heading"
                className="mt-[4px] text-[1.375rem] leading-tight font-bold"
              >
                {t('invoices.contractSummaryTitle')}
              </h2>
              <p className="mt-[4px] text-[0.875rem] text-[#615b57] dark:text-stone-400">
                {asset.make} {asset.model} ·{' '}
                {t('contract.serialNumber', { serial: asset.serial_number })}
              </p>
            </div>

            <span className="inline-flex items-center gap-[8px] rounded-full bg-[#eaf0ec] px-[8px] py-[4px] text-[0.75rem] font-semibold text-[#14522a] ring-1 ring-[#cde5d5] ring-inset dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              <span
                aria-hidden="true"
                className="size-[8px] rounded-full bg-[#16A34A] dark:bg-emerald-400"
              />
              {t('contract.statusSigned')}
            </span>
          </div>

          <div
            role="status"
            className="mt-[16px] rounded-[8px] border border-[#cde5d5] bg-[#eaf0ec] p-[16px] text-[#14522a] dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            <p className="text-[0.875rem] font-semibold">
              {t('contract.signedBannerTitle', { date: formattedSignedDate })}
            </p>
            <p className="mt-[4px] text-[0.875rem]">
              {t('contract.signedBannerBody', {
                netRent: formatEuro(quote.monthlyNetRentCents, intlTag),
                version: quote.priceListVersion,
                months: quote.termMonths,
                downPayment: formatEuro(quote.downPaymentCents, intlTag),
              })}
            </p>
          </div>

          <dl className="mt-[16px] grid grid-cols-1 gap-x-[24px] gap-y-[8px] text-[0.875rem] sm:grid-cols-2">
            {summaryRows.map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-[16px] border-b border-[#ededed] pb-[8px] dark:border-stone-800"
              >
                <dt className="text-[#615b57] dark:text-stone-400">{label}</dt>
                <dd className="font-mono font-semibold text-[#353331] tabular-nums dark:text-stone-200">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Monthly invoice schedule */}
        <MonthlyInvoices
          signedOn={signedOn}
          termMonths={quote.termMonths}
          monthlyNetRentCents={quote.monthlyNetRentCents}
          vatRates={vatRates}
          locale={locale}
          asset={{
            make: asset.make,
            model: asset.model,
            serial_number: asset.serial_number,
          }}
        />

        {/* Early exit: what leaving before the end of the term costs, step by step */}
        <EarlyExitOptions
          locale={locale}
          quote={earlyExit}
          contract={{ asset: asset.id, term: quote.termMonths, down, signedOn }}
          exitMonth={exitMonth}
          inspection={{ ...inspection, inspectedBy: query.data.inspectedBy ?? '' }}
          inspectionProblem={inspectionCheck.ok ? undefined : inspectionCheck.problem}
          recorded={{ condition: asset.condition, usage: asset.usage }}
          monthChoices={exitMonthChoices}
          firstListPriceCents={quote.listPriceCents}
          leaseEnded={asset.status === 'sold' || asset.status === 'returned'}
        />

        {/* End of term options (Buy, Return, Pass on) */}
        <EndOfTermOptions
          assetId={asset.id}
          assetCategory={asset.category}
          assetCondition={asset.condition}
          assetName={`${asset.make} ${asset.model}`}
          initialStatus={asset.status}
          locale={locale}
          buyoutSettlement={buyoutSettlement}
          waitingListMatches={waitingListMatches}
          avoidedCo2Kg={avoidedCo2Kg}
        />
      </div>
    </div>
  );
}

function Message({ locale, text }: { locale: Locale; text: string }) {
  const t = getT(locale);
  return (
    <div className="mx-auto max-w-6xl px-[16px] py-[32px] sm:px-[24px] sm:py-[48px]">
      <Link
        href={`/${locale}`}
        className="inline-flex items-center gap-[8px] text-[0.875rem] font-semibold text-[#1354a5] underline dark:text-sky-400"
      >
        ← {t('invoices.backToCatalogue')}
      </Link>
      <p className="mt-[16px] rounded-[12px] border border-[#e9dac8] bg-[#f8f7f6] p-[24px] text-[#5c360a] dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        {text}
      </p>
    </div>
  );
}
