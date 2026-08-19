import { createMiddleware, tool } from "langchain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type CreateAgentFn, createExactLoomicAgent } from "./agent-factory.js";
import { createAgentAuthority } from "./capabilities.js";
import { createLoomicAgent } from "./loomic-agent.js";

const schema = z.object({});
const namedTool = (name: string) =>
  tool(async () => `${name}:ok`, { name, description: name, schema });
const governanceMiddleware = createMiddleware({
  name: "LoomicToolGovernance",
  wrapToolCall: (request, handler) => handler(request),
});

describe("exact LangChain Agent factory", () => {
  it("rejects production construction without persisted execution authority", () => {
    expect(() =>
      createLoomicAgent({
        env: {} as never,
        model: "openai:test",
        providerRegistry: {} as never,
      }),
    ).toThrow("persisted_agent_authority_required");
  });

  it("passes only authorized classified tools to createAgent", () => {
    const createAgent = vi.fn<CreateAgentFn>(() => ({
      stream() {},
      streamEvents() {},
    }));
    const authority = createAgentAuthority([
      "canvas.read",
      "image.generate",
      "skill.read",
    ]);

    createExactLoomicAgent({
      authority,
      createAgent,
      model: "openai:test",
      middleware: [governanceMiddleware],
      systemPrompt: "system",
      tools: [
        namedTool("read_builtin_skill"),
        namedTool("execute"),
        namedTool("inspect_canvas"),
        namedTool("generate_image"),
        namedTool("screenshot_canvas"),
      ],
    });

    expect(createAgent).toHaveBeenCalledOnce();
    expect(
      createAgent.mock.calls[0]?.[0].tools.map((registered) => registered.name),
    ).toEqual(authority.mainToolNames);
    expect(createAgent.mock.calls[0]?.[0].middleware).toEqual([
      governanceMiddleware,
    ]);
  });

  it("rejects duplicate and unclassified tools instead of widening authority", () => {
    const base = {
      authority: createAgentAuthority(["canvas.read"]),
      createAgent: vi.fn<CreateAgentFn>(),
      model: "openai:test",
      middleware: [governanceMiddleware],
      systemPrompt: "system",
    };
    expect(() =>
      createExactLoomicAgent({
        ...base,
        tools: [namedTool("inspect_canvas"), namedTool("inspect_canvas")],
      }),
    ).toThrow("duplicate_agent_tool");
    expect(() =>
      createExactLoomicAgent({
        ...base,
        tools: [namedTool("unknown_tool")],
      }),
    ).toThrow("unclassified_agent_tool");
    expect(() =>
      createExactLoomicAgent({
        ...base,
        tools: [],
      }),
    ).toThrow("missing_authorized_tool:inspect_canvas");
  });

  it("constructs a closed task tool with the registered subagent enum", () => {
    const createAgent = vi.fn<CreateAgentFn>(() => ({
      stream() {},
      streamEvents() {},
    }));
    const authority = createAgentAuthority([
      "agent.delegate",
      "video.generate",
    ]);

    createExactLoomicAgent({
      authority,
      createAgent,
      model: "openai:test",
      middleware: [governanceMiddleware],
      systemPrompt: "system",
      subagents: [
        {
          name: "video_generate",
          description: "video",
          systemPrompt: "video",
          tools: [namedTool("generate_video")],
        },
      ],
      tools: [namedTool("generate_video")],
    });

    const mainNames = createAgent.mock.calls
      .at(-1)?.[0]
      .tools.map((item) => item.name);
    const videoCall = createAgent.mock.calls.find(
      ([options]) => options.systemPrompt === "video",
    );
    expect(mainNames).toEqual(["generate_video", "task"]);
    expect(videoCall?.[0].tools.map((item) => item.name)).toEqual([
      "generate_video",
    ]);
    expect(
      createAgent.mock.calls.every(
        ([agentOptions]) =>
          agentOptions.middleware?.[0] === governanceMiddleware,
      ),
    ).toBe(true);
  });

  it("rejects missing or multiple tool execution middleware", () => {
    const base = {
      authority: createAgentAuthority(["canvas.read"]),
      createAgent: vi.fn<CreateAgentFn>(),
      model: "openai:test",
      systemPrompt: "system",
      tools: [namedTool("inspect_canvas"), namedTool("screenshot_canvas")],
    };
    const secondWrapper = createMiddleware({
      name: "SecondToolWrapper",
      wrapToolCall: (request, handler) => handler(request),
    });

    expect(() => createExactLoomicAgent(base as never)).toThrow(
      "single_tool_governance_middleware_required",
    );
    expect(() =>
      createExactLoomicAgent({
        ...base,
        middleware: [governanceMiddleware, secondWrapper],
      }),
    ).toThrow("single_tool_governance_middleware_required");
  });
});
