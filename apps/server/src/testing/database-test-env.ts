import { z } from "zod";

const databaseUrlSchema = z
  .url()
  .refine(
    (value) =>
      value.startsWith("postgres://") || value.startsWith("postgresql://"),
  );

export function phase2TestDatabaseUrl(): string | undefined {
  const value = process.env.PHASE2_TEST_DATABASE_URL;
  if (!value) return undefined;
  return databaseUrlSchema.parse(value);
}
