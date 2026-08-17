import { ZodError, type ZodIssue, type ZodType } from "zod";

export type SafeValidationIssue = {
  code: string;
  message: string;
  path: Array<string | number>;
};

/** Marks a schema failure as originating from untrusted request input. */
export class RequestValidationError extends Error {
  readonly issues: SafeValidationIssue[];

  constructor(issues: ZodIssue[]) {
    super("Request validation failed");
    this.name = "RequestValidationError";
    this.issues = issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.map((segment) =>
        typeof segment === "string" || typeof segment === "number"
          ? segment
          : String(segment),
      ),
    }));
  }
}

export function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationError(error.issues);
    }
    throw error;
  }
}
