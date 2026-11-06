// The fixed refurbishment steps a returned item needs before it can be leased again, turned
// from the data pack's rules in words (`refurbishment-costs.json`, field `when`) into costs.
//
// Supported rules (every rule in the data pack is one of these; anything else throws, so a new
// rule cannot be silently skipped):
// - "always"                                     -> once, on every return
// - "usage.value >= <n> <unit>"                  -> once, when the usage counter is at least n
// - "per started <n> <unit> since last service"  -> once per started n units of use since the
//   last service. The data has no service history, so the caller passes the use since the item
//   was last ready to lease (for an early exit: the use during this lease).
//
// Optional condition upgrades (e.g. "fair->good") are not included: whether to upgrade is a
// business choice, not a requirement.
import type { RefurbishmentCosts, UsageUnit } from '@/data/schemas';

export type FixedRefurbishmentRule = RefurbishmentCosts['e_bike']['fixed'][number];

export type RefurbishmentStep = {
  id: string;
  /** How many times the step is done (more than 1 only for "per started" rules). */
  count: number;
  /** Cost of all `count` repetitions together. */
  costCents: number;
};

export type RefurbishmentPlan = {
  steps: RefurbishmentStep[];
  totalCents: number;
  /** A step sets the usage counter back to 0 (e.g. a new battery). */
  resetsUsage: boolean;
};

const THRESHOLD = /^usage\.value >= (\d+) ([a-z_]+)$/;
const PER_STARTED = /^per started (\d+) ([a-z_]+) since last service$/;

function checkUnit(rule: FixedRefurbishmentRule, ruleUnit: string, unit: UsageUnit): void {
  if (ruleUnit !== unit) {
    throw new RangeError(`Rule "${rule.id}" counts ${ruleUnit}, but the item counts ${unit}`);
  }
}

/** How many times a rule applies to the item. 0 means the step is not needed. */
function timesRuleApplies(
  rule: FixedRefurbishmentRule,
  usage: { unit: UsageUnit; value: number; sinceLastService: number }
): number {
  if (rule.when === 'always') return 1;

  const threshold = THRESHOLD.exec(rule.when);
  if (threshold) {
    checkUnit(rule, threshold[2] ?? '', usage.unit);
    return usage.value >= Number(threshold[1]) ? 1 : 0;
  }

  const perStarted = PER_STARTED.exec(rule.when);
  if (perStarted) {
    checkUnit(rule, perStarted[2] ?? '', usage.unit);
    const step = Number(perStarted[1]);
    if (step <= 0) throw new RangeError(`Rule "${rule.id}" has a step of ${step}`);
    return Math.ceil(usage.sinceLastService / step);
  }

  throw new RangeError(`Unknown refurbishment rule for "${rule.id}": "${rule.when}"`);
}

/**
 * The fixed steps needed for an item with this usage, and their total cost in cents.
 * `usage.value` is the counter now; `usage.sinceLastService` is the use since the item was last
 * ready to lease (between 0 and `usage.value`).
 */
export function fixedRefurbishmentFor(input: {
  rules: readonly FixedRefurbishmentRule[];
  usage: { unit: UsageUnit; value: number; sinceLastService: number };
}): RefurbishmentPlan {
  const { rules, usage } = input;
  if (!Number.isInteger(usage.value) || usage.value < 0) {
    throw new RangeError(`usage.value must be a non-negative integer, got ${usage.value}`);
  }
  if (
    !Number.isInteger(usage.sinceLastService) ||
    usage.sinceLastService < 0 ||
    usage.sinceLastService > usage.value
  ) {
    throw new RangeError(
      `usage.sinceLastService must be an integer between 0 and ${usage.value}, got ${usage.sinceLastService}`
    );
  }

  const steps: RefurbishmentStep[] = [];
  let resetsUsage = false;
  for (const rule of rules) {
    const count = timesRuleApplies(rule, usage);
    if (count === 0) continue;
    steps.push({ id: rule.id, count, costCents: rule.cost_cents * count });
    if (rule.resets_usage) resetsUsage = true;
  }
  return {
    steps,
    totalCents: steps.reduce((sum, step) => sum + step.costCents, 0),
    resetsUsage,
  };
}
