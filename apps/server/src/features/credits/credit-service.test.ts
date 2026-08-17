import { describe, expect, it, vi } from "vitest";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createCreditService } from "./credit-service.js";

const command = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  debitTransactionId: "33333333-3333-4333-8333-333333333333",
  compensationKey: "support-case-42",
  operatorUserId: "44444444-4444-4444-8444-444444444444",
  amount: 7,
  reason: "Approved customer support adjustment",
};

describe("credit service generation compensation", () => {
  it("calls the replay-safe audited compensation RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        transaction_id: "55555555-5555-4555-8555-555555555555",
        replayed: false,
      },
      error: null,
    }));
    const service = createCreditService({
      getAdminClient: () => ({ rpc }) as unknown as AdminSupabaseClient,
    });

    await expect(service.compensateGeneration(command)).resolves.toEqual({
      transactionId: "55555555-5555-4555-8555-555555555555",
      replayed: false,
    });
    expect(rpc).toHaveBeenCalledWith("compensate_generation_charge", {
      p_workspace_id: command.workspaceId,
      p_compensation_key: command.compensationKey,
      p_job_id: command.jobId,
      p_debit_transaction_id: command.debitTransactionId,
      p_operator_user_id: command.operatorUserId,
      p_amount: command.amount,
      p_reason: command.reason,
    });
  });

  it("maps a conflicting replay without exposing database text", async () => {
    const secret = "operator token and internal SQL";
    const service = createCreditService({
      getAdminClient: () =>
        ({
          rpc: vi.fn(async () => ({
            data: null,
            error: { details: "compensation_conflict", message: secret },
          })),
        }) as unknown as AdminSupabaseClient,
    });

    const error = await service
      .compensateGeneration(command)
      .catch((value) => value);
    expect(error).toMatchObject({
      code: "compensation_conflict",
      statusCode: 409,
    });
    expect(error.message).not.toContain(secret);
  });

  it("rejects malformed RPC results", async () => {
    const service = createCreditService({
      getAdminClient: () =>
        ({
          rpc: vi.fn(async () => ({ data: {}, error: null })),
        }) as unknown as AdminSupabaseClient,
    });
    await expect(service.compensateGeneration(command)).rejects.toMatchObject({
      code: "credit_refund_failed",
      statusCode: 500,
    });
  });

  it("maps cumulative over-compensation to an actionable business rejection", async () => {
    const service = createCreditService({
      getAdminClient: () =>
        ({
          rpc: vi.fn(async () => ({
            data: null,
            error: { details: "compensation_exceeds_debit" },
          })),
        }) as unknown as AdminSupabaseClient,
    });
    await expect(service.compensateGeneration(command)).rejects.toMatchObject({
      code: "compensation_conflict",
      statusCode: 409,
    });
  });
});
