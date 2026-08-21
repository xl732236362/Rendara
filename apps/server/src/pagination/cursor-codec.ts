import { createHmac, timingSafeEqual } from "node:crypto";

import {
  INVALID_CURSOR_ERROR_CODE,
  PAGINATION_MAX_CURSOR_LENGTH,
} from "@loomic/shared";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import { type KeysetBoundary, keysetBoundarySchema } from "./keyset.js";

export const CURSOR_VERSION = 1 as const;
export const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
// One minute tolerates normal NTP convergence and cross-replica request transit.
export const CURSOR_CLOCK_SKEW_ALLOWANCE_MS = 60_000;

export type CursorScope = {
  userId: string;
  workspaceId: string;
  owner: string;
  filterHash: string;
  direction: "asc" | "desc";
};

export type CursorBoundary = KeysetBoundary;

export type CursorSigningKey = {
  keyId: string;
  secret: string;
};

export type CursorCodecOptions = {
  activeKey: CursorSigningKey;
  previousKey?: CursorSigningKey;
  now: () => number;
};

export type CursorCodec = {
  encode(scope: CursorScope, boundary: CursorBoundary): string;
  decode(cursor: string, expectedScope: CursorScope): CursorBoundary;
};

const scopeSchema = z
  .object({
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
    owner: z.string().min(1),
    filterHash: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  })
  .strict();

const payloadSchema = z
  .object({
    keyId: z.string().min(1),
    version: z.literal(CURSOR_VERSION),
    issuedAt: z.number().int().nonnegative(),
    scope: scopeSchema,
    boundary: keysetBoundarySchema,
  })
  .strict();

type CursorPayload = z.infer<typeof payloadSchema>;

export function createCursorCodec(options: CursorCodecOptions): CursorCodec {
  return {
    encode(scope, boundary) {
      const payload: CursorPayload = {
        keyId: options.activeKey.keyId,
        version: CURSOR_VERSION,
        issuedAt: readClock(options.now),
        scope: scopeSchema.parse(scope),
        boundary: keysetBoundarySchema.parse(boundary),
      };
      const payloadSegment = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      return `${payloadSegment}.${sign(payloadSegment, options.activeKey.secret).toString("base64url")}`;
    },

    decode(cursor, expectedScope) {
      try {
        return decodeCursor(cursor, expectedScope, options);
      } catch {
        // Cursor material is intentionally omitted from both the error and logs.
        throw invalidCursorError();
      }
    },
  };
}

function decodeCursor(
  cursor: string,
  expectedScope: CursorScope,
  options: CursorCodecOptions,
): CursorBoundary {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > PAGINATION_MAX_CURSOR_LENGTH
  ) {
    throw new Error("invalid cursor envelope");
  }

  const segments = cursor.split(".");
  if (segments.length !== 2) {
    throw new Error("invalid cursor envelope");
  }
  const payloadSegment = segments[0];
  const signatureSegment = segments[1];
  if (
    !payloadSegment ||
    !signatureSegment ||
    !isCanonicalBase64Url(payloadSegment) ||
    !isCanonicalBase64Url(signatureSegment)
  ) {
    throw new Error("invalid cursor encoding");
  }

  const untrustedPayload = JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf8"),
  ) as unknown;
  const keyId = readKeyId(untrustedPayload);
  const key = selectKey(keyId, options);
  if (!key) {
    throw new Error("unknown cursor key");
  }

  const providedSignature = Buffer.from(signatureSegment, "base64url");
  const expectedSignature = sign(payloadSegment, key.secret);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new Error("invalid cursor signature");
  }

  const payload = payloadSchema.parse(untrustedPayload);
  const now = readClock(options.now);
  if (
    payload.issuedAt - now > CURSOR_CLOCK_SKEW_ALLOWANCE_MS ||
    now - payload.issuedAt > CURSOR_MAX_AGE_MS ||
    !scopesEqual(payload.scope, expectedScope)
  ) {
    throw new Error("invalid cursor claims");
  }

  return payload.boundary;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Cursor clock must return epoch milliseconds");
  }
  return value;
}

function sign(payloadSegment: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadSegment).digest();
}

function isCanonicalBase64Url(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.length > 0 && bytes.toString("base64url") === segment;
}

function readKeyId(payload: unknown): string | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const keyId = Reflect.get(payload, "keyId");
  return typeof keyId === "string" ? keyId : undefined;
}

function selectKey(
  keyId: string | undefined,
  options: CursorCodecOptions,
): CursorSigningKey | undefined {
  if (keyId === options.activeKey.keyId) return options.activeKey;
  if (keyId === options.previousKey?.keyId) return options.previousKey;
  return undefined;
}

function scopesEqual(actual: CursorScope, expected: CursorScope): boolean {
  return (
    actual.userId === expected.userId &&
    actual.workspaceId === expected.workspaceId &&
    actual.owner === expected.owner &&
    actual.filterHash === expected.filterHash &&
    actual.direction === expected.direction
  );
}

function invalidCursorError(): AppError {
  return new AppError({
    code: INVALID_CURSOR_ERROR_CODE,
    statusCode: 400,
    message: "Invalid pagination cursor.",
    expose: true,
  });
}
