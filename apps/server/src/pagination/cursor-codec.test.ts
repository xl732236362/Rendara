import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../errors/app-error.js";
import {
  CURSOR_MAX_AGE_MS,
  type CursorScope,
  createCursorCodec,
} from "./cursor-codec.js";

const NOW = Date.parse("2026-08-22T08:30:00.000Z");
const ACTIVE_KEY = {
  keyId: "active-2026-08",
  secret: "active-pagination-signing-secret-32-bytes",
};
const PREVIOUS_KEY = {
  keyId: "previous-2026-07",
  secret: "previous-pagination-signing-secret-32-bytes",
};
const SCOPE: CursorScope = {
  userId: "user-1",
  workspaceId: "workspace-1",
  owner: "projects",
  filterHash: "sha256:filter-1",
  direction: "desc",
};
const BOUNDARY = {
  timestamp: "2026-08-22T08:00:00.000Z",
  id: "9d71351d-e116-4c5f-ae82-20fb76ed6a63",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cursor codec", () => {
  it("encodes deterministic base64url JSON signed with the active HMAC key", () => {
    const codec = createCodec();

    const cursor = codec.encode(SCOPE, BOUNDARY);
    const [payloadSegment, signatureSegment] = splitCursor(cursor);
    const payload = decodePayload(payloadSegment);
    const expectedSignature = createHmac("sha256", ACTIVE_KEY.secret)
      .update(payloadSegment)
      .digest("base64url");

    expect(cursor).toBe(codec.encode(SCOPE, BOUNDARY));
    expect(payloadSegment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signatureSegment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signatureSegment).toBe(expectedSignature);
    expect(payload).toEqual({
      keyId: ACTIVE_KEY.keyId,
      version: 1,
      issuedAt: NOW,
      scope: SCOPE,
      boundary: BOUNDARY,
    });
  });

  it("decodes a valid cursor back to its boundary", () => {
    const codec = createCodec();

    expect(codec.decode(codec.encode(SCOPE, BOUNDARY), SCOPE)).toEqual(
      BOUNDARY,
    );
  });

  it("accepts a cursor signed by the configured previous key", () => {
    const oldCodec = createCursorCodec({
      activeKey: PREVIOUS_KEY,
      now: () => NOW,
    });
    const rotatingCodec = createCursorCodec({
      activeKey: ACTIVE_KEY,
      previousKey: PREVIOUS_KEY,
      now: () => NOW,
    });

    expect(
      rotatingCodec.decode(oldCodec.encode(SCOPE, BOUNDARY), SCOPE),
    ).toEqual(BOUNDARY);
  });

  it("rejects a previous-key cursor when that key is not configured", () => {
    const oldCodec = createCursorCodec({
      activeKey: PREVIOUS_KEY,
      now: () => NOW,
    });
    const activeOnlyCodec = createCursorCodec({
      activeKey: ACTIVE_KEY,
      now: () => NOW,
    });

    expectInvalidCursor(() =>
      activeOnlyCodec.decode(oldCodec.encode(SCOPE, BOUNDARY), SCOPE),
    );
  });

  it.each([
    ["user", { userId: "user-2" }],
    ["workspace", { workspaceId: "workspace-2" }],
    ["owner", { owner: "jobs" }],
    ["filter", { filterHash: "sha256:filter-2" }],
    ["direction", { direction: "asc" as const }],
  ])("rejects a cursor used with the wrong %s scope", (_label, mismatch) => {
    const codec = createCodec();

    expectInvalidCursor(() =>
      codec.decode(codec.encode(SCOPE, BOUNDARY), {
        ...SCOPE,
        ...mismatch,
      }),
    );
  });

  it("rejects signed cursors with an unsupported version", () => {
    const cursor = replacePayload(
      createCodec().encode(SCOPE, BOUNDARY),
      (payload) => ({ ...payload, version: 2 }),
    );

    expectInvalidCursor(() => createCodec().decode(cursor, SCOPE));
  });

  it("rejects signed cursors with an unknown key id", () => {
    const cursor = replacePayload(
      createCodec().encode(SCOPE, BOUNDARY),
      (payload) => ({ ...payload, keyId: "unknown-key" }),
    );

    expectInvalidCursor(() => createCodec().decode(cursor, SCOPE));
  });

  it("rejects a tampered payload and a tampered signature", () => {
    const codec = createCodec();
    const cursor = codec.encode(SCOPE, BOUNDARY);
    const [payload, signature] = splitCursor(cursor);
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    const tamperedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;

    expectInvalidCursor(() =>
      codec.decode(`${tamperedPayload}.${signature}`, SCOPE),
    );
    expectInvalidCursor(() =>
      codec.decode(`${payload}.${tamperedSignature}`, SCOPE),
    );
  });

  it.each([
    "",
    "not-a-cursor",
    "a.b.c",
    "%%%.%%%",
    `${Buffer.from("not json").toString("base64url")}.short`,
  ])("maps malformed cursor %j to the canonical error", (cursor) => {
    expectInvalidCursor(() => createCodec().decode(cursor, SCOPE));
  });

  it("rejects a correctly signed malformed payload", () => {
    const payloadSegment = Buffer.from(JSON.stringify({})).toString(
      "base64url",
    );
    const cursor = signPayloadSegment(payloadSegment, ACTIVE_KEY.secret);

    expectInvalidCursor(() => createCodec().decode(cursor, SCOPE));
  });

  it("rejects cursor inputs larger than 4096 characters", () => {
    expectInvalidCursor(() => createCodec().decode("a".repeat(4_097), SCOPE));
  });

  it("accepts a cursor at exactly seven days and rejects it after expiry", () => {
    let now = NOW;
    const codec = createCursorCodec({
      activeKey: ACTIVE_KEY,
      now: () => now,
    });
    const cursor = codec.encode(SCOPE, BOUNDARY);

    now = NOW + CURSOR_MAX_AGE_MS;
    expect(codec.decode(cursor, SCOPE)).toEqual(BOUNDARY);
    now += 1;
    expectInvalidCursor(() => codec.decode(cursor, SCOPE));
  });

  it("rejects a cursor issued in the future", () => {
    const futureCodec = createCursorCodec({
      activeKey: ACTIVE_KEY,
      now: () => NOW + 1,
    });
    const cursor = futureCodec.encode(SCOPE, BOUNDARY);

    expectInvalidCursor(() => createCodec().decode(cursor, SCOPE));
  });

  it("does not log cursor payloads, signatures, or signing keys on failure", () => {
    const spies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const codec = createCodec();
    const cursor = codec.encode(SCOPE, BOUNDARY);

    expectInvalidCursor(() =>
      codec.decode(cursor, { ...SCOPE, userId: "wrong-user" }),
    );

    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});

function createCodec() {
  return createCursorCodec({
    activeKey: ACTIVE_KEY,
    previousKey: PREVIOUS_KEY,
    now: () => NOW,
  });
}

function expectInvalidCursor(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "invalid_cursor",
      statusCode: 400,
      message: "Invalid pagination cursor.",
      expose: true,
      cause: undefined,
      details: undefined,
    });
    return;
  }
  throw new Error("Expected operation to reject the cursor");
}

function splitCursor(cursor: string): [string, string] {
  const segments = cursor.split(".");
  expect(segments).toHaveLength(2);
  return [segments[0] ?? "", segments[1] ?? ""];
}

function decodePayload(payloadSegment: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function replacePayload(
  cursor: string,
  update: (payload: Record<string, unknown>) => Record<string, unknown>,
): string {
  const [payloadSegment] = splitCursor(cursor);
  const nextPayloadSegment = Buffer.from(
    JSON.stringify(update(decodePayload(payloadSegment))),
  ).toString("base64url");
  return signPayloadSegment(nextPayloadSegment, ACTIVE_KEY.secret);
}

function signPayloadSegment(payloadSegment: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(payloadSegment)
    .digest("base64url");
  return `${payloadSegment}.${signature}`;
}
