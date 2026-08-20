// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAssetUrlMock, getSessionMock, onAuthStateChangeMock } = vi.hoisted(
  () => ({
    getAssetUrlMock: vi.fn(),
    getSessionMock: vi.fn(),
    onAuthStateChangeMock: vi.fn(),
  }),
);

vi.mock("../src/lib/server-api", () => ({
  getAssetUrl: getAssetUrlMock,
}));

vi.mock("../src/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
      signOut: vi.fn(),
    },
  })),
}));

import { ToolBlockView } from "../src/components/chat/tool-block-view";
import { Providers } from "../src/components/providers";

describe("generated image artifact resolution", () => {
  const assetId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        addListener: vi.fn(),
        addEventListener: vi.fn(),
        matches: false,
        removeListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: "token-1",
          user: { id: "viewer-1", email: "viewer@example.com" },
        },
      },
    });
    onAuthStateChangeMock.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    getAssetUrlMock.mockResolvedValue({
      url: "https://storage.example.com/signed-image.png",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses an authenticated signed URL for an asset-backed generated image", async () => {
    render(
      <Providers>
        <ToolBlockView
          block={{
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "completed",
            artifacts: [
              {
                type: "image",
                source: { kind: "asset", assetId },
                url: `/api/assets/${assetId}`,
                mimeType: "image/png",
                width: 512,
                height: 512,
              },
            ],
          }}
        />
      </Providers>,
    );

    await waitFor(() =>
      expect(getAssetUrlMock).toHaveBeenCalledWith(
        "token-1",
        assetId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      await screen.findByRole("img", { name: "Generated image" }),
    ).toHaveAttribute("src", "https://storage.example.com/signed-image.png");
  });

  it("deduplicates simultaneous asset URL requests", async () => {
    const block = {
      type: "tool" as const,
      toolCallId: "tool-1",
      toolName: "generate_image",
      status: "completed" as const,
      artifacts: [
        {
          type: "image" as const,
          source: { kind: "asset" as const, assetId },
          url: `/api/assets/${assetId}`,
          mimeType: "image/png",
          width: 512,
          height: 512,
        },
      ],
    };
    render(
      <Providers>
        <ToolBlockView block={block} />
        <ToolBlockView block={{ ...block, toolCallId: "tool-2" }} />
      </Providers>,
    );

    await screen.findAllByRole("img", { name: "Generated image" });
    expect(getAssetUrlMock).toHaveBeenCalledTimes(1);
  });
});
