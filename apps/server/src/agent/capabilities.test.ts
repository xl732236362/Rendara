import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_AGENT_TOOL_NAMES,
  agentCapabilitySchema,
  createAgentAuthority,
} from "./capabilities.js";

describe("Agent capability policy", () => {
  it("maps a minimal image run to an exact main tool set", () => {
    const authority = createAgentAuthority([
      "canvas.read",
      "image.generate",
      "skill.read",
    ]);

    expect(authority.mainToolNames).toEqual([
      "generate_image",
      "inspect_canvas",
      "read_builtin_skill",
      "screenshot_canvas",
    ]);
    expect(authority.subagents).toEqual([]);
  });

  it("registers the video subagent only with bounded delegation authority", () => {
    expect(
      createAgentAuthority(["video.generate", "agent.delegate"]).subagents,
    ).toEqual([
      {
        name: "video_generate",
        capabilities: ["video.generate"],
        toolNames: ["generate_video"],
      },
    ]);
    expect(createAgentAuthority(["video.generate"]).subagents).toEqual([]);
    expect(createAgentAuthority(["agent.delegate"]).subagents).toEqual([]);
  });

  it("covers every closed capability combination without forbidden tools", () => {
    const capabilities = agentCapabilitySchema.options;
    for (let mask = 0; mask < 2 ** capabilities.length; mask += 1) {
      const selected = capabilities.filter((_, index) => mask & (1 << index));
      const authority = createAgentAuthority(selected);
      const allToolNames = [
        ...authority.mainToolNames,
        ...authority.subagents.flatMap((subagent) => subagent.toolNames),
      ];
      expect(allToolNames).not.toEqual(
        expect.arrayContaining([...FORBIDDEN_AGENT_TOOL_NAMES]),
      );
      expect(authority.policyVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(authority.mainToolNames)).toBe(true);
    }
  });
});
