// POST /api/assets/:id/early-exit
// Ends a lease before its term (Smart Problem 2): an early buyout (the asset becomes 'sold') or
// an early return (it becomes 'returned', in the inspected condition). The body carries the
// contract terms, not an amount: the server prices the exit itself and audits the breakdown.
// A return also carries the return inspection (condition, usage reading, inspector).
import { z } from 'zod';
import { assetConditionSchema, isoDateSchema } from '@/data/schemas';
import { fail, handleRoute, ok, readJsonBody } from '@/server/api-response';
import { db } from '@/server/db';
import { executeEarlyExit } from '@/server/early-exit';

const contractFields = {
  termMonths: z.number().int().positive(),
  downPaymentCents: z.number().int().min(0),
  signedOn: isoDateSchema,
  exitMonth: z.number().int().min(1),
  actor: z.string().trim().min(1).max(100).default('customer'),
};

const bodySchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('buyout'), ...contractFields }),
  z.strictObject({
    choice: z.literal('return'),
    ...contractFields,
    inspection: z.strictObject({
      condition: assetConditionSchema,
      usageValue: z.number().int().min(0),
      inspectedBy: z.string().trim().min(1).max(100),
    }),
  }),
]);

export const POST = handleRoute(
  async (request, { params }: RouteContext<'/api/assets/[id]/early-exit'>) => {
    const { id } = await params;
    const body = await readJsonBody(request, bodySchema);

    const result = await executeEarlyExit(db, { assetId: id, ...body });
    if (result.ok) return ok({ asset: result.asset, receipt: result.receipt });

    switch (result.reason) {
      case 'not_found':
        return fail(404, 'ASSET_NOT_FOUND', `No asset with id "${id}"`);
      case 'lease_ended':
        return fail(409, 'LEASE_ALREADY_ENDED', 'This lease has already ended');
      case 'invalid_contract':
        return fail(422, 'INVALID_CONTRACT', 'These contract terms cannot be priced');
      case 'invalid_inspection':
        return fail(
          422,
          'INVALID_INSPECTION',
          result.problem === 'usage_decreased'
            ? 'The usage reading is below the reading recorded at the start of the lease'
            : result.problem === 'condition_improved'
              ? 'The condition is better than the condition recorded at the start of the lease'
              : 'A return needs a valid inspection'
        );
    }
  }
);
