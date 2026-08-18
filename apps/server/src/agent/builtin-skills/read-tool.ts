import { randomBytes } from "node:crypto";

import { tool } from "langchain";
import { z } from "zod";

import type { AgentExecutionRepository } from "../../features/agent-runs/agent-execution-repository.js";
import type { AgentExecutionContext } from "../execution-context.js";
import type { BuiltinSkillCatalog } from "./catalog.js";

const MAX_PAGE_BYTES = 32 * 1024;
const inputSchema = z
  .object({
    skillName: z.string().min(1),
    path: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
  })
  .refine((input) => Boolean(input.cursor) !== Boolean(input.path), {
    message: "skill_read_input_invalid",
  });

type ReadInput = z.infer<typeof inputSchema>;

export async function readBuiltinSkill(options: {
  catalog: BuiltinSkillCatalog;
  context: AgentExecutionContext;
  repository: AgentExecutionRepository;
  input: ReadInput;
}): Promise<{ text: string; nextCursor?: string }> {
  const input = inputSchema.parse(options.input);
  const capabilitySet = new Set(options.context.capabilities);
  if (!capabilitySet.has("skill.read")) throw new Error("capability_denied");
  if (!options.context.effectiveSkillNames.includes(input.skillName)) {
    throw new Error("skill_not_authorized");
  }
  if (options.context.skillCatalogDigest !== options.catalog.digest) {
    throw new Error("skill_catalog_changed");
  }
  const skill = options.catalog.get(input.skillName);
  if (
    !skill.requiredCapabilities.every((capability) =>
      capabilitySet.has(capability),
    )
  ) {
    throw new Error("capability_denied");
  }

  let path: string;
  let byteOffset: number;
  if (input.cursor) {
    const binding = await options.repository.resolveSkillCursor({
      runId: options.context.runId,
      cursor: input.cursor,
    });
    if (!binding || binding.skillName !== input.skillName) {
      throw new Error("skill_cursor_invalid");
    }
    path = binding.path;
    byteOffset = binding.byteOffset;
  } else {
    path = normalizeSkillPath(input.path ?? "");
    byteOffset = 0;
  }

  const file = skill.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error("skill_file_not_found");
  assertText(file.bytes);
  const end = findUtf8PageEnd(file.bytes, byteOffset);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    file.bytes.slice(byteOffset, end),
  );
  const hasMore = end < file.bytes.byteLength;
  const proposedNextCursor = hasMore
    ? randomBytes(32).toString("base64url")
    : undefined;
  const reservation = await options.repository.reserveSkillRead({
    runId: options.context.runId,
    logicalReadKey: `${input.skillName}\0${path}\0${input.cursor ?? "start"}`,
    byteCount: end - byteOffset,
    ...(proposedNextCursor
      ? {
          proposedNextCursor,
          nextCursorBinding: {
            skillName: input.skillName,
            path,
            byteOffset: end,
          },
        }
      : {}),
  });
  return {
    text,
    ...(reservation.nextCursor ? { nextCursor: reservation.nextCursor } : {}),
  };
}

export function createBuiltinSkillReadTool(options: {
  catalog: BuiltinSkillCatalog;
  context: AgentExecutionContext;
  repository: AgentExecutionRepository;
}) {
  return tool(async (input) => readBuiltinSkill({ ...options, input }), {
    name: "read_builtin_skill",
    description: "Read authorized internal Skill instructions as bounded text.",
    schema: inputSchema,
  });
}

function normalizeSkillPath(path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("skill_path_invalid");
  }
  return path;
}

function assertText(bytes: Uint8Array): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("skill_file_not_text");
  }
}

function findUtf8PageEnd(bytes: Uint8Array, offset: number): number {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= bytes.byteLength
  ) {
    throw new Error("skill_cursor_invalid");
  }
  let end = Math.min(offset + MAX_PAGE_BYTES, bytes.byteLength);
  while (end > offset) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.slice(offset, end),
      );
      return end;
    } catch {
      end -= 1;
    }
  }
  throw new Error("skill_file_not_text");
}
