---
id: architecture
type: architecture-design
status: draft
title: Lease Loop — Architecture Design
parent: goal-and-requirements
---

# Lease Loop: architecture and spec

**Status:** draft for team review (5 Nov 2026). Built from [CHALLENGE.md](CHALLENGE.md), [RULES.md](RULES.md), [data/DATA.md](data/DATA.md) and the starter code. It also absorbs the earlier `architecture.md` from the spec graph. This is the single `architecture` node: its parent is [goal-and-requirements.md](goal-and-requirements.md), and the module specs in `src/*/SPEC.md` point here as their `parent`.

Items marked **[Decision]** were not settled in the notes and are proposed here. Agree or change them in review before the plan is written.

---

## 1. Goal and scope

Create a fully functional lease app for the hackathon. That means a Spine that works end to end (all 7 steps, one item around the full loop), real depth on the chosen Smart Problems, and a live 4-minute demo. Deadline: **Fri 6 Nov 2026, 16:00 Helsinki**.

| In scope                              | Smart Problem                                                      |
| ------------------------------------- | ------------------------------------------------------------------ |
| Spine steps 1–7                       | required                                                           |
| Fair early exit                       | #2                                                                 |
| Smart question flow                   | #4                                                                 |
| Money that adds up                    | #5                                                                 |
| Second-life matchmaking + passport    | #3, **without refurbishment**                                      |
| Circular impact (CO₂ and money saved) | #7, shown on the passport. Nothing in the money core depends on it |

**Out of scope for phase 1:** admin/back-office view (manual review queue, returned-items desk, audit viewer beyond a simple list) is **phase 2**. Also out: refurbishment (costs, upgrades, the mandatory laptop data wipe), and fleet contracts with more than one physical item.

**Out of scope entirely:** authentication, user sessions and roles; background jobs and message queues; external payment, bank or identity-provider integrations. All reference data stays in `data/` and local SQLite.

**Scenario cards outside our Smart Problems must not crash** (cards 2, 3, 6, 9, 10). §12 says what each one shows.

### Drivers

- **Explainable, repeatable financial decisions.** Every pricing, eligibility, invoicing and second-life calculation is deterministic and testable without a database, network or clock.
- **Transactional auditability.** No change to an asset, application, contract or invoice commits without its audit row in the same SQLite transaction.
- **Boundaries enforced by tooling.** ESLint, the coverage gate and the CI scripts check the module boundaries automatically (`npm run check:all`).

## 2. Hard constraints (from RULES.md and the starter)

- No AI/ML/LLM in the product. Everything is rules, data and algorithms. `npm run check:no-ai` fails on an AI package, import or API key in `package.json`, `src/` or `prisma/`.
- Business logic in `src/domain/` as pure functions with co-located Vitest tests. `eslint.config.mjs` forbids `src/domain/**` from importing `node:*`, `next/*`, `react`, `@prisma/*`, `@/generated/*`, `@/server/*`, `@/data/load` or `@/app/*`, and from using `fetch`, `process`, `Date.now()`, `new Date()` or `Math.random()`.
- Money is integer euro cents. Rates are integers (see §6). One rounding rule, written down.
- API routes use `handleRoute()`, `ok()`, `fail()`, `ApiError` and `readJsonBody()` from `src/server/api-response.ts`. They always answer `{ success: true, data, meta: { timestamp } }` or `{ success: false, error: { code, message, details? }, meta: { timestamp } }`. An unhandled exception becomes a generic `500 INTERNAL_ERROR` and leaks nothing.
- Every data change goes through `withAudit(db, entry, (tx) => …)` from `src/server/audit.ts`, with every write on `tx`, so the business write and the `AuditLog` row commit or roll back together.
- Schema changes: edit `prisma/schema.prisma`, then `npm run db:migrate -- --name <what>`. Never hand-write SQL.
- UI strings in `src/i18n/messages/{en,fi,sv,et}.json`, same keys in all four. `src/i18n/messages.test.ts` checks this.
- Source files under 600 lines. Conventional commits. Hooks on. `npm run check:all` green, with at least 60 % coverage on domain, server, data and i18n.

**Stack (verified):** Next.js 16 App Router (read `node_modules/next/dist/docs/` before writing routes), React 19, Prisma 7 on **SQLite** (`@prisma/adapter-better-sqlite3`), Zod 4, Vitest 5, Tailwind 4.

## 3. Team split

| Person | Role             | Owns                                                                                                                                                                   |
| ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | Frontend         | All customer pages, sliders, question flow UI, contract/invoice views, early-exit and end-of-term screens, demo date control, translations                             |
| B      | Backend          | API routes, `question-flow.ts` + `eligibility.ts` (#4, built), application submit route, `contract/` (signing), `end-of-term/`, `second-life/` flow, integration tests |
| C      | Database + money | Schema, transactions, test DB helper and fixtures, `money/` (#5), `pricing/`, `early-exit/` (#2), buyout price, `second-life/` pricing + matchmaking, `impact/` (#7)   |

- **First ~30 minutes together:** write `src/domain/types.ts` and the API shapes in §11. Then A builds against mocked responses, B builds routes, C builds the money core, in parallel.
- If C falls behind, move `second-life/` pricing to B.

## 4. Architecture

### 4.0 Topology and module boundaries

The app is one Next.js 16 monolith (App Router, TypeScript, React 19, Prisma 7 + SQLite), split into five modules under `src/`. Each has its own `SPEC.md`.

| Module                                         | Spec     | Role                                                                                     | Depends on                                         |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/data`                                     | `data`   | Zod schemas (`schemas.ts`) and server-side JSON loaders (`load.ts`) for the `data/` pack | `zod`, `node:fs` (`load.ts` only)                  |
| `src/domain`                                   | `domain` | Pure business rules (§4.2)                                                               | `data` (`schemas.ts` types only)                   |
| `src/server`                                   | `server` | Prisma client, repositories, `withAudit`, API envelope, clock and `asOf` helpers         | `data` (`schemas.ts`), `@/generated/prisma`, `zod` |
| `src/i18n`                                     | `i18n`   | Four-locale dictionaries, interpolation, locale-aware date and number formatting         | none (leaf)                                        |
| `src/app` (+ `src/components`, `src/proxy.ts`) | `app`    | Pages, UI components, locale routing proxy, `/api/*` route handlers                      | `data`, `domain`, `server`, `i18n`                 |

- **Functional core, imperative shell.** Side effects happen only in `server` and `app`: reading the clock (`todayIso()` / `resolveAsOf()`), loading JSON (`src/data/load.ts`) and reading or writing SQLite.
- **Hybrid storage.** Mutable entities (`Asset`, `AuditLog`, `Quote`, `Application`, `Contract`, `InvoiceRow`, `AssetEvent`) live in SQLite. Immutable reference tables (price lists, coefficient table, VAT rates, questions, residual curves, refurbishment costs, waiting list, CO₂ factors, customers) are read from `data/` and validated by `src/data`.

### 4.1 Layers (each calls only the one below)

1. **UI** (`src/app/[locale]/`, `src/components/`): talks to the API for anything that saves data. It may import pure domain functions for **live previews only** (for example, the price sliders). The server always recomputes before it saves.
2. **API routes** (`src/app/api/`): validate input with Zod, load data, call domain functions, persist inside `withAudit()`, return the envelope. No business rules here.
3. **Domain** (`src/domain/`): pure functions. Time-dependent functions take an `asOf` (`YYYY-MM-DD`).
4. **Server/persistence** (`src/server/`, Prisma): repositories, audit, the `asOf` resolver.

### 4.2 Domain modules

Existing code is kept and built on. `contract-pricing.ts` already does the quote (worked example passes). It moves into `pricing/` and switches to the integer arithmetic in §6.1. Its tests must keep passing. The question flow and eligibility are **built** as single files (PR #4).

| Module                                                                       | Owner                        | Covers        | Status                                                             |
| ---------------------------------------------------------------------------- | ---------------------------- | ------------- | ------------------------------------------------------------------ |
| `money/` (rounding, rates, calendar, schedule generator, allocation)         | C                            | #5 foundation | new                                                                |
| `pricing/` (quote from list price + term + down payment, VAT lookup, buyout) | C                            | Spine         | exists as `contract-pricing.ts`, `coefficient.ts`, `price-list.ts` |
| `question-flow.ts` (visible questions, pruning)                              | B                            | #4            | **built**                                                          |
| `eligibility.ts` (decision with reasons, `ageOn`)                            | B                            | #4 + Spine    | **built**                                                          |
| `business-id.ts` (Y-tunnus check digit)                                      | B                            | #4            | **built**                                                          |
| `date-input.ts` (day/month/year ↔ ISO at the UI edge)                        | A                            | #4 UX         | **built**                                                          |
| `contract/` (snapshot at signing + generated schedule)                       | B, using C's generator       | Spine         | new                                                                |
| `early-exit/` (balance, exit quotes with breakdown)                          | C                            | #2            | new                                                                |
| `end-of-term/` (return / buy out / extend)                                   | B, buyout from C             | Spine         | new                                                                |
| `second-life/` (market value, relist price, waiting-list matchmaking)        | C pricing + matching, B flow | Spine + #3    | new                                                                |
| `lifecycle/` (allowed status transitions)                                    | B                            | safeguards    | new                                                                |
| `impact/` (CO₂ and money saved per life and fleet)                           | C                            | #7            | new                                                                |

A small module is a single file (as the built ones are). It becomes a folder with an `index.ts` when it grows. Every file stays under 600 lines, and every function is tested next to it.

### 4.3 Storage approach: snapshot + stored schedule

The price is frozen when the **quote is saved** (§5), and the contract copies that **snapshot**: price list version, list price, down payment, financed amount, band, factor, interest rate, term, start date, monthly net rent, buyout. A pure function generates the **whole invoice schedule once**. The rows are saved and **never edited**. `asOf` only decides whether a row is upcoming, due or past. That is computed on read, not stored. Early exit and buyout read the stored rows. The item lifecycle is an **append-only event history** on the asset (the passport).

Rejected: computing everything on the fly (old invoices would change when the logic changes), and full event sourcing (too much machinery for the deadline).

## 5. Data flow (the Spine)

| #   | Step         | Route                                                                                                                                  | Domain                               | Saves                                                                       |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| 1   | Catalogue    | page + `GET /api/assets`                                                                                                               | `pricing.listPriceFor`               | nothing                                                                     |
| 2   | Price        | `GET /api/quote?assetId&termMonths&downPaymentCents&asOf` (live preview), `POST /api/quotes` (lock)                                    | `pricing.quote`                      | preview: nothing; lock: `Quote` snapshot                                    |
| 3   | Application  | `POST /api/applications/evaluate` (**built**, stateless) on every change; `POST /api/applications` (planned, with `quoteId`) to submit | `question-flow.ts`, `eligibility.ts` | evaluate: nothing; submit: application (`yes` / `manual_review`)            |
| 4   | Contract     | `POST /api/contracts`                                                                                                                  | `contract.buildContract`             | contract (copies the quote snapshot), invoice rows, asset → `leased`, event |
| 5   | Invoices     | `GET /api/contracts/:id?asOf`                                                                                                          | `money.rowStatus`                    | nothing                                                                     |
| 6a  | Early exit   | `GET /api/contracts/:id/exit-quote?asOf&condition&usage`, `POST /api/contracts/:id/exit`                                               | `early-exit`                         | closing row, contract → `exited`, asset → `returned` or `sold`              |
| 6b  | End of term  | `GET /api/contracts/:id/end-of-term?asOf`, `POST /api/contracts/:id/end-of-term`                                                       | `end-of-term`                        | buyout row or return, contract → `ended`, asset → `returned` / `sold`       |
| 7   | Second life  | `GET /api/assets/:id/relist-quote?asOf&condition&usage`, `GET /api/assets/:id/matches?asOf`, `POST /api/assets/:id/relist`             | `second-life`                        | relist price, asset → `available`                                           |
| 7b  | Second lease | steps 1–5 again on the same asset                                                                                                      | same                                 | passport shows every life                                                   |

**Price lock.** The price is locked **when a quote is created or a contract is created** (goal-and-requirements). While the customer moves the sliders, `GET /api/quote` only previews. "Lock this price and apply" calls `POST /api/quotes`, which saves a `Quote` snapshot: price list version, list price, down payment, financed amount, band, factor, interest rate, term, monthly net rent and buyout, priced on the quote date. The application points to that quote, and signing copies the snapshot into the contract. **Price lists are never read again** for that quote or contract. Changing the term or down payment creates a new quote at that day's prices.

Card 2: the quote saved on 5 Nov locks v1 (349000). Signing on 6 Nov, when v2 (321100) is live, keeps v1. The contract page says "price locked by your quote of 5 Nov (price list v1)". VAT is **not** locked: it always follows the invoice date (§6.3).

**Reserved and out-of-range items.** `ebike-009` is `reserved`. The catalogue shows it as not available, and quotes and applications return `ASSET_NOT_AVAILABLE`. `ebike-010` (€289, below €300) and `farm-006` (€260,000, above €250,000) return `BELOW_MINIMUM` / `ABOVE_MAXIMUM`. `farm-006` becomes leasable with a down payment of at least €10,000, and the UI says so.

**Explain my price.** The price step shows a plain-language breakdown (list price, down payment, financed amount, coefficient, VAT, buyout, total cost) and a side-by-side comparison of every term in the table. Each column is one `pricing.quote` call.

## 6. Money core (#5)

### 6.1 Integers and one rounding rule

- **Cents:** every amount is an integer number of cents. A non-integer reaching a domain function is a bug and throws `RangeError`. That is already the pattern in `coefficient.ts`.
- **Rates as integers, converted once at the data edge:**
  - VAT and interest in **basis points**: 25.5 % → `2550`, 7.9 % → `790`.
  - Coefficient factors in **parts per million**: `0.027584` → `27584`.
  - Buyout percentage as a whole percent: `15`.
- **One rounding helper:** `mulDivRound(a, num, den)` computes `a × num / den` in integer arithmetic and rounds **half up** (amounts are never negative). Every derived amount calls it **once**:
  - monthly net rent = `mulDivRound(financed, factorPpm, 1_000_000)`
  - VAT on a row = `mulDivRound(net, vatBp, 10_000)`
  - buyout = `mulDivRound(financed, buyoutPercent, 100)`

  This matches the worked example exactly (10730 / 2736 / 13466 / 58350) and avoids float error near `.5`. Products stay below 2⁵³ (max 25,000,000 × 60,000).

- **Allocation:** `allocate(total, n)` splits a total into `n` integer parts that differ by at most 1 cent. The leftover cents go to the earliest rows, and the parts always sum to the total. It's used for multi-unit amounts and for any total the business wants split, not for ordinary rent (see §6.3).

### 6.2 Calendar

- Domain dates are `YYYY-MM-DD` strings, never JS `Date`. Helpers: `isValidIsoDate`, `addMonthsClamped`, `daysInMonth`, `isLeapYear`, `compareIso`, `monthsBetween`.
- **The billing day is anchored to the start day and clamped to the month length.** Invoice _k_ (0-based) is dated `addMonthsClamped(start, k)`, always counted from the start date and never chained, so the date doesn't drift: 31 Jan → 28 Feb (or 29 Feb) → 31 Mar → 30 Apr.
- **Rent is billed in advance.** Invoice _k_ covers `[date_k, date_{k+1} − 1 day]`, and the **due date is the invoice date** **[Decision]**. Payment terms are not modelled.
- **A mid-month start is not a partial month.** Periods run from the start day, so every period is one full month and nothing is prorated. That answers the challenge's "is the first month a full month?": yes, by construction.

### 6.3 Schedule generation

`generateSchedule(snapshot, vatRates) → InvoiceRow[]`:

- Optional row 0, `down_payment`, dated on the start date, if down payment > 0.
- `term` rows of kind `rent`, each with `net = monthlyNetRent`. Every rent row is identical net. That is what "locked price" means.
- Every row stores its **own** `vatRateBp` (the rate on **its invoice date**) and `vatCents = mulDivRound(net, vatRateBp, 10_000)`, and `gross = net + vat`. A VAT change mid-contract shows up only in later rows' VAT, never in net. This handles card 3 and Smart Problem #1 at no extra cost.
- **What "adds up" means:**
  - contract net rent total = `monthlyNetRent × term`
  - contract gross total = **sum of row gross**
  - Both are stored on the contract and must equal the sum of the rows. The existing `totalRentGrossCents` (one VAT rate × term) is replaced by the row sum, because the VAT rate can change during the term.
- `rowStatus(row, asOf)`: `upcoming` if after `asOf`, `due` if `asOf` falls inside its period, `past` otherwise. This is derived, not stored. There is no payments model. "Past" means billed.

**Card 1 reference numbers (ebike-003, 36 months, start 5 Nov 2026):** rent 10730 net. Invoices on 5 Nov and 5 Dec 2026 are 10730 + 2736 = **13466**. 5 Jan 2027 is 10730 + 2790 = **13520** (26 %). Net total 386280, gross total **486612**. Buyout 58350 net.

### 6.4 Property tests (fast-check, thousands of random contracts)

Add `fast-check` as a dev dependency. It is not AI, and `check:no-ai` allows it.

- Schedule net sum = `monthly × term (+ down payment)`. Gross sum = stored contract gross total, to the cent.
- No negative amounts. Every row date is a valid ISO date. Dates are strictly increasing. Each row's day equals `min(startDay, daysInMonth)`.
- `allocate` parts sum to the total and differ by at most 1 cent.
- Early-buyout quote never increases as `asOf` moves forward (§7).
- Early-buyout quote on the last day = end-of-term buyout price.
- Every quote breakdown sums to its total.
- Return-exit cost is between 0 and the nominal remaining rents.

## 7. Fair early exit (#2)

There is no official formula in the data, so this is our design. It is built so the lessor recovers what it is owed **financially**, the customer never pays interest for months they don't use, and **it equals the normal buyout at the end of the term**.

**Outstanding balance.** At exit date `asOf`, rows dated on or before `asOf` are billed and owed as normal. The remaining rows, _m_ of them, are discounted at the band's monthly rate `r = annual_interest_bp / 12 / 10_000`:

```text
balance(asOf) = Σ_{i=1..m} rent / (1 + r)^i  +  buyout / (1 + r)^m
```

- The coefficient factor is an annuity at the band rate with the buyout as a balloon. For ebike-003 the annuity gives 10722 against the table's 10730. So `balance` is the true remaining financed amount. At signing it is ≈ the financed amount: 388992 vs 389000. That is a good sanity check to show in the demo.
- When `m = 0` (term over), `balance = buyout`. **Consistency with the end-of-term buyout holds by construction.**
- The present value is computed in double precision and rounded **once** with `Math.round` at the end. This is the only non-integer step in the money core. It is documented and tested.

**The customer chooses one of two exit options:**

1. **Early buyout, keep the item:** pay `balance`. The asset becomes `sold`.
2. **Early return:** pay `max(0, min(balance − returnCredit, nominalRemainingRents))`, where `returnCredit = max(0, marketValue(item at asOf, condition, usage) − fixedRefurbishment)`. Market value uses the same formula as the relist price. `fixedRefurbishment` is the sum of the `fixed` steps in `refurbishment-costs.json` whose rule applies (`domain/refurbishment.ts`: the e-bike safety inspection always, a battery from 15 000 km, and so on). A step that resets usage (a new battery) values the item at 0 usage. Optional condition upgrades are not deducted. The asset becomes `returned`, with the inspected condition and usage as its new record.

The credit is what the returned item is worth to the lessor in cash, not its gross resale value. Without the refurbishment deduction the lessor would pay for the inspection out of its own pocket on every early return.

**The return inspection.** `condition` and `usage` come from the inspection when the item comes back, never from the stored asset: that reading is from the start of the lease, so pricing with it would credit a bike ridden for two years as if it had 0 km. A return needs `{ condition, usageValue, inspectedBy }`, and `checkReturnInspection` refuses a reading below the record or a condition better than the record (refurbishment happens after the return). The page defaults to the worse of `good` and the recorded condition, at the recorded reading, and the return cannot be confirmed until an inspector is named. The app has no login, so this records and bounds the inspection but cannot prove who made it.

**Why late returns can still be free.** The e-bike curve keeps 40 % of the value at 36 months, while the contract buyout is 15 %. Late in the term the item is worth more than everything still owed, so the lessor is ahead when it gets the item back. For a 2,624 € e-bike in good condition at 250 km a month, returns are free from month 30 (before these fixes, it was month 25 at 0 km). The customer gives up the difference; the early buyout lets them keep it instead.

**Card 8 (Aino, ebike-003, exit after the 7th invoice, good condition, 0 km):** 29 rows remain.

- Balance ≈ 330666.
- Market value = 389000 × 80 % (age 7 months, interpolated from 82 % at 6 and 70 % at 12) × 0.85 (good) = 264520.
- Refurbishment before the next lease: the safety inspection, 4500 (under 15 000 km, no battery).
- Credit = 264520 − 4500 = 260020.
- **Early-return cost = 330666 − 260020 = 70646, i.e. €706.46 net + VAT.** For comparison, the nominal remaining rents plus buyout are €3,695.20.

The UI shows every line. The domain fixes the exact figures; tests pin them.

**Breakdown.** Every quote returns `lines: { key, amountCents, params }[]`, for example remaining rents nominal, interest not charged, buyout discounted, return credit. The total is computed **as the sum of the rounded lines**, so they always add up. The UI translates `key` with `params`. Both exit quotes are shown side by side with the "finish the contract" option.

**The closing invoice** is a row of kind `exit_return` or `exit_buyout`, dated `asOf`, with VAT at that date's rate. Unbilled rent rows stay stored but are marked `cancelled_by_exit` (the only status ever set on a row after creation; amounts never change).

**Config [Decision]:** no extra exit fee, and the return credit is the market value minus the fixed refurbishment from the data pack. There is no extra remarketing haircut: it would be a number the data pack does not give.

## 8. Question flow and eligibility (#4)

### 8.1 Engine (built: `question-flow.ts`, `business-id.ts`, `date-input.ts`)

- **Context:** `FlowContext = { deal: { customer_type?, category, financed_amount_cents, term_months }, answers }`. The customer type is read from `answers.q_customer_type` and never sent separately, so the two can't disagree.
- `evaluateCondition` / `isAskable` evaluate `ask_when`. All conditions must hold. `in` compares as text, `gte`/`lte` are inclusive and numeric only, and an unknown value never satisfies a condition.
- `visibleQuestions(questions, ctx)` returns the applicable questions in bank order. It makes **one pass in file order**: conditions only look at earlier questions, and the stored answer of a hidden question is ignored. That's enough for chains like `q_can_sign → q_signatory_email` and `q_pep → q_pep_details`.
- **No "next question" function.** The form shows every visible question at once. On every change it sends the **whole form state** to `POST /api/applications/evaluate`, and draws what comes back: `questions`, the pruned `answers`, the `dropped` IDs and the `decision`.
- **Changing an answer:** `pruneAnswers(questions, ctx) → { kept, dropped }` deletes the answers to questions that no longer apply after an earlier answer or the deal (amount, term, customer type) changes. It also drops answers to unknown IDs. Cascades resolve in the same single pass. The UI uses `dropped` to say "we no longer need: …". If a question comes back, it is asked again.
- **Blocking answers:** `blocks_application_when` (`age_under 18`, `answer_in ['other']`) gives a hard `no` straight away, even while other questions are unanswered (§8.2). A 17-year-old sees the decision as soon as the birth date is in.
- **Validation:** `isValidBusinessId` checks the Finnish Y-tunnus format and check digit (weights 7, 9, 10, 5, 8, 4, 2; remainder 0 → 0; remainder 1 is never valid; else 11 − remainder). `1234567-8` fails, and every other ID in `customers.json` passes. Dates are typed as day/month/year and converted to ISO at the UI edge (`date-input.ts`). An unusable birth date counts as unanswered. Income answers are whole cents.
- **Why we ask:** every question shows its `why_we_ask` in the current locale, straight from `questions.json`.

### 8.2 Decision (built: `eligibility.ts`)

`decideEligibility({ questions, coefficientTable, deal, answers, contractStartDate, monthlyRentInclVatCents? })` returns one of:

- `{ decision: 'yes' | 'no' | 'manual_review', reasons }`
- `{ decision: 'incomplete', missing, reasons }`, while applicable questions are unanswered.

Each reason is `{ rule, outcome: 'no' | 'manual_review', params }`, never prose, so the UI translates `rule` and fills in `params`. The function prunes stale answers itself before deciding.

**Precedence:** a hard `no` wins immediately, even with questions missing. Only the `no` reasons are returned then. Next comes `incomplete`, then `manual_review` if any reason asks for a person, else `yes`.

| Rule                 | Outcome         | When                                                                                                                                                                                 |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `min_age`            | `no`            | Age under 18 on `contractStartDate` (`ageOn`: a birthday counts on its own day, 29 Feb births age on 1 Mar)                                                                          |
| `residency`          | `no`            | `q_country = other`                                                                                                                                                                  |
| `blocked_answer`     | `no`            | Any other `answer_in` block (beyond the data pack)                                                                                                                                   |
| `business_id`        | `no`            | Business ID fails the check digit                                                                                                                                                    |
| `financed_limits`    | `no`            | Financed amount or term not in the coefficient table (`below_minimum`, `above_maximum`, `unknown_term`)                                                                              |
| `affordability`      | `no`            | Consumer: `rent incl. VAT × 100 > income × 30`, integers only. Rent is the quote's monthly gross rent (VAT on the quote date). Skipped when no rent is passed or income wasn't asked |
| `pep_manual_review`  | `manual_review` | `q_pep = yes`                                                                                                                                                                        |
| `signatory_required` | `manual_review` | `q_can_sign = no`: a person contacts the signatory (beyond the data pack)                                                                                                            |

- **Age date:** the evaluate route takes `contract_start_date`, defaulting to `todayIso()`. Planned: default to `resolveAsOf()` (§11), and re-check age at signing.
- **Trust:** today the evaluate route trusts `financed_amount_cents` and the rent from the caller, because the apply page prices the deal server-side and passes them in. Planned: the evaluate and submit routes take a `quoteId` and read the amounts from the locked quote.
- **Submit (planned) [Decision]:** `POST /api/applications` with `quoteId` and answers re-runs `decideEligibility` on the server. It stores the application only for `yes` and `manual_review`. A `no` is returned but not stored (data minimisation). Only a stored `yes` can be signed. `manual_review` waits for the phase-2 review view, and the customer sees "a person will check".
- **Privacy:** the evaluate response echoes the client's own answers and reason params (for example rent and income for `affordability`) back to the same browser only. Nothing is stored or logged. Contract and invoice responses never include income, birth date or address.

## 9. End of term and second life

**End of term** (`asOf` on or after the last row's period end):

- **Buy out:** buyout row (net from the snapshot + VAT on that date). The contract becomes `ended` and the asset `sold`.
- **Return / pass it on:** no charge. The contract becomes `ended` and the asset `returned`, which hands it to second life.
- **Extend [Decision, stretch]:** a new contract on the same asset with financed amount = buyout, priced by the normal coefficient table. Offered only if the buyout fits a band.

**Second life (Spine step 7 + #3, no refurbishment).** Items are relisted **as they come back**. Refurbishment costs and condition upgrades are not modelled in phase 1.

- `marketValue(firstListPrice, ageMonths, condition, usage)` = first list price × curve(age), with linear interpolation and the last value held after the final point, × condition multiplier × usage adjustment (whole steps of `step`, capped at `max_total_percent`). Rounded once.
- **Relist price** = market value on the relist date. It is stored on the asset and used **instead of the price list** for that asset's next quote. After that the normal coefficient pricing applies. A relist price outside the bands (below €300) means the item can't be leased again. It stays `returned` with reason `below_minimum`. Example: `laptop-006` is worth 27577.
- **Who may lease it:** an item must be at least `good`, unless the matched waiting-list entry accepts `fair` (rule from `refurbishment-costs.json`). A `poor` item is never relisted.
- **Age and first list price [Decision]:** taken from the asset's first lease in its passport. Seeded items that already have `previous_lives > 0` get a documented assumption: first lease on 1 January of `model_year`, at the earliest list price in the data.

**Matchmaking (#3).** `matchWaitingList(item, relistPrice, demand, asOf)` returns every waiting-list entry for the item's category. Each entry is either a ranked candidate or excluded with a reason code:

- **Filters:**
  - item condition ≥ `min_condition` (`condition_too_low`)
  - `needed_by` ≥ `asOf` (`deadline_passed`)
  - monthly net rent at the entry's `preferred_term_months` ≤ `max_monthly_net_rent_cents` (`over_budget`)
- **Ranking (deterministic tie-break):** earliest `needed_by` first, then earlier signup. The waiting list has no signup date, so file order (ID) is signup order. `wait-14` is "signed up one day later" than `wait-06`, so `wait-06` wins a tie.
- The relist screen shows the winner, the rent at their term, and why each other entry lost. The match is a recommendation. The lease itself still runs through steps 2–4.

**Card 9 (`ebike-007`, fair, 18,400 km, relisted 5 Nov 2026):**

- Age 46 months → 32.5 %. Fair → × 0.65. Usage −36 %, capped at −20 % → × 0.8.
- Relist price = **92781** (€927.81).
- `wait-13` is excluded: it needs `good`. `wait-02` accepts `fair`, and its 12-month rent is 5198 net, within its 9000 budget. **`wait-02` gets it at €51.98 net a month.**

**Passport and impact (#7).** `AssetEvent` rows (§10.1) are shown on the asset page as a timeline of lives. Each life after the first also shows two things computed by `impact/`:

- **CO₂ avoided** = `manufacturing_new_kg × (1 − refurbishment_share_of_new) × relistPrice / firstListPrice`. A nearly worn-out item has a low relist value, so it saves less. The method is the defence of the challenge question "is the saving the same?". The sum runs in whole grams and is rounded once.
- **Money saved** by the customer = new list price of the same model on the relist date − relist price.

Totals are shown per item and for the whole fleet. Card 10 (`ebike-008`, 2 lives, relist price 32601) shows two seeded summary lives, the new lease and its CO₂.

## 10. Persistence, config and lifecycle

### 10.1 New Prisma models (C)

```text
Quote        id (uuid), asset_id, created_on (asOf), price_list_version (null if relisted),
             list_price_cents, down_payment_cents, financed_cents, band, factor_ppm,
             annual_interest_bp, term_months, monthly_net_rent_cents, buyout_net_cents
Application  id (uuid), quote_id, created_on (asOf), answers_json (pruned),
             decision (yes|manual_review), reasons_json, status
Contract     id (uuid), application_id @unique, quote_id, asset_id, status,
             start_date, price_list_version, list_price_cents, down_payment_cents,
             financed_cents, band, factor_ppm, annual_interest_bp, term_months,
             monthly_net_rent_cents, buyout_net_cents, total_net_cents, total_gross_cents,
             signed_on, closed_on?
InvoiceRow   id, contract_id, seq, kind (down_payment|rent|exit_return|exit_buyout|buyout),
             invoice_date, period_start, period_end, net_cents, vat_rate_bp, vat_cents,
             gross_cents, cancelled_by_exit (bool)    @@unique([contract_id, seq])
AssetEvent   id, asset_id, on_date, from_status, to_status, contract_id?, condition?,
             usage_value?, amount_cents?, note_key?    (append-only)
Asset        + relist_price_cents?, first_lease_date?, first_list_price_cents?
```

- Asset statuses are extended: `available | reserved | leased | returned | sold`.
- The database stores the **customer's answers only as needed for the decision**. Data from `customers.json` is never copied in.

### 10.2 Lifecycle guards

One table in `domain/lifecycle`:

- **Asset:** `available → leased`, `leased → returned | sold`, `returned → available` (relist), `reserved` is fixed.
- **Contract:** `active → exited | ended`.
- **Application:** `submitted → signed` (only when `decision = yes`).

Every route checks the table. Sign, exit, end-of-term and relist each run inside one `withAudit()` transaction that **re-reads and re-checks status** on `tx`, so double-clicks can't create two contracts or two exit invoices.

### 10.3 Config

`src/domain/config.ts` holds tunable numbers: affordability 30 %, minimum age 18, exit fee 0, return credit 100 %, minimum relist condition `good` (`fair` only for entries that accept it), down payment slider step €50. Plain constants, passed into functions as arguments so tests can vary them. Rates, bands and thresholds keep coming from the data files.

## 11. API conventions

- **`asOf`:** every request may send `asOf` (query string for GET, body field for POST). `resolveAsOf(request)` in `src/server/` validates it as a real calendar date and falls back to `todayIso()`. The demo date picker in the header sets it for every request. **[Decision]** It is allowed in all environments for the hackathon; production would disable it.
- **Validation:** Zod at the edge for types, ranges, UUIDs and terms in the table. Out-of-range values are **rejected, not clamped**. The UI slider clamps; the API does not.
- **Errors:** following the domain spec and the existing code, domain functions return `{ ok: false, reason }` with a lower-case `reason` (e.g. `'below_minimum'`). They add extra fields where a caller needs them, such as `reasons: Reason[]` on an eligibility decision. Routes map each `reason` to an upper-case code and answer `fail(status, CODE, message)` (`below_minimum` → `BELOW_MINIMUM`): 404 for unknown IDs, 409 for state conflicts (`CONTRACT_NOT_ACTIVE`, `ASSET_NOT_AVAILABLE`, `APPLICATION_NOT_APPROVED`, `APPLICATION_IN_REVIEW`), 422 for business rejections. The UI translates the **code** (`errors.<CODE>` keys), never the message. Unexpected errors go through `handleRoute` as a generic 500.
- **Second-life screen:** a minimal customer-side "Second life" page lists returned items, shows the relist quote and matches, and relists. It is the demo path for step 7, **not** the phase-2 admin view.
- **Audit actions:** `quote.locked`, `application.submitted`, `contract.signed`, `contract.exited`, `contract.ended`, `asset.relisted`, `asset.status_changed`. Details record what changed, never personal data.
- **Privacy:** random UUIDs, no list endpoints for applications, contracts or customers, minimal response bodies, nothing personal in URLs or logs.
- **Dev only:** a "Fill sample data" button (`NODE_ENV !== 'production'`) fills answers from `customers.json`.

## 12. Scenario card acceptance

| Card               | Expected result in our app                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Happy path       | Rent 10730 net / 13466 gross. Invoices on 5 Nov, 5 Dec, 5 Jan (the 3rd at 26 %: 13520). Total 486612 gross                                                                                                                                                      |
| 2 Price lock       | The quote saved on 5 Nov locks v1 (349000). Signing on 6 Nov keeps v1, not v2 (321100), and the contract page says "locked by your quote of 5 Nov (price list v1)"                                                                                              |
| 3 Tax is not price | ebike-001: net 6957 every month. Dec 2026 VAT 1774 (25.5 %), Jan 2027 VAT 1809 (26 %). The UI explains "rent locked, VAT follows the law on the invoice date"                                                                                                   |
| 4 Calendar traps   | laptop-001 from 31 Jan 2026: invoices on **28 Feb 2026** and **29 Feb 2028**, rent 3432                                                                                                                                                                         |
| 5 Too young        | Flow stops after the birth date. Outcome `no`, reason `min_age`, kind message with alternatives                                                                                                                                                                 |
| 6 Who can sign?    | 4 × 549000 = 2,196,000 financed (band C) → PEP question shown. `q_can_sign = no` → signatory email asked → `manual_review` (`signatory_required`): a person contacts the signatory. Quantity affects pricing and questions only (fleet signing is out of scope) |
| 7 Big ticket       | financed 12,500,000 (band D): annual revenue, beneficial owners, PEP and PEP details all appear, each with its "why". PEP yes → `manual_review` (`pep_manual_review`)                                                                                           |
| 8 Early exit       | §7 numbers, both options with a breakdown                                                                                                                                                                                                                       |
| 9 Second life      | §9: no refurbishment, relist at 92781, `wait-13` excluded (needs good), `wait-02` wins at 5198 net a month for 12 months                                                                                                                                        |
| 10 Third life      | Passport shows 2 earlier lives + the new lease, with CO₂ and money saved per life and in total                                                                                                                                                                  |

These become the full-loop integration test and the demo script.

## 13. Testing

- **Unit tests** (each module's owner): every domain function, edge cases first (band limits 199999 / 200000, 29999 / 30000, 25,000,000 / 25,000,001, 31 Jan, 29 Feb, last day of the term, VAT switch day).
- **Property tests:** §6.4.
- **Integration tests** (B writes them, C provides the helper): each route against a **separate SQLite test file**, migrated fresh and seeded from the data pack, wiped between files. They check the envelope, the stored rows and the matching `AuditLog` rows. They never touch the dev database.
- **Full-loop test** (written last, together): one item through steps 1–7 and into a second lease.
- **CI:** the existing workflow (`check:all`). SQLite needs no database service.

## 14. Order of work

1. Together: `types.ts`, API shapes (§11), Prisma models (§10.1) agreed.
2. C: `money/` (rounding, calendar, schedule, properties) → `pricing/` refactor → migration + test DB helper → `early-exit/` → `second-life/` pricing + matchmaking → `impact/`.
3. B: quote lock route → `quoteId` on the evaluate route + `POST /api/applications` (question flow and eligibility are built) → `POST /api/contracts` → invoices route → exit and end-of-term routes → relist and matches routes.
4. A: demo date picker → catalogue + sliders (exists) + term comparison → question flow UI (built) → contract and invoices views → exit / end-of-term → second-life page → passport with impact.
5. Full-loop test, demo rehearsal against §12.
6. Stretch, in order: extend, refurbishment, admin view (phase 2).

## 15. Open questions for review

1. Quote validity: does a locked quote expire (for example after 30 days), or hold until signed? Proposed: no expiry in phase 1.
2. Early return credit: market value minus the data pack's fixed refurbishment (decided, §7). A remarketing haircut on top is still open.
3. Due date = invoice date (proposed), or invoice date + 14 days?
