import {
  type PaginationQuery,
  createCursorPageSchema,
  creditTransactionSchema,
} from "@loomic/shared";

import { apiFetch } from "../api-client";
import { paginationPath } from "./projects";

const creditTransactionPageSchema = createCursorPageSchema(
  creditTransactionSchema,
);

export function fetchCreditTransactionsPage(
  accessToken: string,
  page: Partial<PaginationQuery>,
  options: { signal?: AbortSignal } = {},
) {
  return apiFetch({
    method: "GET",
    path: paginationPath("/api/v2/credits/transactions", page),
    accessToken,
    responseSchema: creditTransactionPageSchema,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
