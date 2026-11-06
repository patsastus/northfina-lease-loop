import { describe, expect, it, vi } from 'vitest';
import { POST } from './route';

vi.mock('@/server/early-exit', () => ({
  executeEarlyExit: vi.fn(async (_db, input) => {
    if (input.assetId === 'unknown-id') return { ok: false, reason: 'not_found' };
    if (input.assetId === 'ended-id') return { ok: false, reason: 'lease_ended' };
    if (input.termMonths === 13) return { ok: false, reason: 'invalid_contract' };
    if (input.inspection?.usageValue === 1) {
      return { ok: false, reason: 'invalid_inspection', problem: 'usage_decreased' };
    }
    return {
      ok: true,
      asset: { id: input.assetId, status: input.choice === 'buyout' ? 'sold' : 'returned' },
      receipt: { choice: input.choice, netCents: 330_666, grossCents: 416_639 },
    };
  }),
}));

vi.mock('@/server/db', () => ({ db: {} }));

const CARD_8 = {
  choice: 'buyout',
  termMonths: 36,
  downPaymentCents: 0,
  signedOn: '2026-11-05',
  exitMonth: 7,
};

const RETURN = {
  ...CARD_8,
  choice: 'return',
  inspection: { condition: 'fair', usageValue: 4_000, inspectedBy: 'Workshop Vantaa' },
};

async function post(id: string, body: unknown) {
  const request = new Request(`http://localhost/api/assets/${id}/early-exit`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  const res = await POST(request, { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}

describe('POST /api/assets/[id]/early-exit', () => {
  it('executes the exit and returns the asset and the receipt', async () => {
    const { status, json } = await post('ebike-003', CARD_8);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.asset.status).toBe('sold');
    expect(json.data.receipt.grossCents).toBe(416_639);
  });

  it('maps each refusal to its own error code', async () => {
    expect(await post('unknown-id', CARD_8)).toMatchObject({
      status: 404,
      json: { success: false, error: { code: 'ASSET_NOT_FOUND' } },
    });
    expect(await post('ended-id', CARD_8)).toMatchObject({
      status: 409,
      json: { error: { code: 'LEASE_ALREADY_ENDED' } },
    });
    expect(await post('ebike-003', { ...CARD_8, termMonths: 13 })).toMatchObject({
      status: 422,
      json: { error: { code: 'INVALID_CONTRACT' } },
    });
  });

  it('rejects a body that sends an amount instead of contract terms', async () => {
    const { status, json } = await post('ebike-003', { ...CARD_8, netCents: 1 });
    expect(status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('passes a return with its inspection through', async () => {
    const { status, json } = await post('ebike-003', RETURN);
    expect(status).toBe(200);
    expect(json.data.asset.status).toBe('returned');
  });

  it('rejects a return without an inspection, and a buyout with one', async () => {
    expect((await post('ebike-003', { ...CARD_8, choice: 'return' })).status).toBe(400);
    expect((await post('ebike-003', { ...RETURN, choice: 'buyout' })).status).toBe(400);
    const noInspector = { ...RETURN, inspection: { condition: 'fair', usageValue: 4_000 } };
    expect((await post('ebike-003', noInspector)).status).toBe(400);
    const negative = { ...RETURN, inspection: { ...RETURN.inspection, usageValue: -1 } };
    expect((await post('ebike-003', negative)).status).toBe(400);
  });

  it('maps an impossible inspection to INVALID_INSPECTION', async () => {
    const body = { ...RETURN, inspection: { ...RETURN.inspection, usageValue: 1 } };
    expect(await post('ebike-003', body)).toMatchObject({
      status: 422,
      json: { error: { code: 'INVALID_INSPECTION' } },
    });
  });

  it('rejects month 0 and an unknown choice', async () => {
    expect((await post('ebike-003', { ...CARD_8, exitMonth: 0 })).status).toBe(400);
    expect((await post('ebike-003', { ...CARD_8, choice: 'pass_on' })).status).toBe(400);
  });
});
