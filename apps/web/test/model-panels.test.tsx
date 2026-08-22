// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchImageCatalog, fetchVideoCatalog } = vi.hoisted(() => ({
  fetchImageCatalog: vi.fn(async () => ({
    models: [{ id: "image-current", displayName: "Image Current" }],
  })),
  fetchVideoCatalog: vi.fn(async () => ({
    models: [{ id: "video-current", displayName: "Video Current" }],
  })),
}));

vi.mock("../src/lib/api/models", () => ({
  fetchAgentModels: vi.fn(),
  fetchImageModels: fetchImageCatalog,
  fetchVideoModels: fetchVideoCatalog,
}));
vi.mock("../src/lib/api/viewer", () => ({
  fetchViewer: vi.fn(async () => ({
    profile: {
      id: "user-1",
      email: "u@example.com",
      displayName: "U",
      avatarUrl: null,
    },
    workspace: {
      id: "workspace-1",
      name: "W",
      type: "personal",
      ownerUserId: "user-1",
    },
    membership: { workspaceId: "workspace-1", userId: "user-1", role: "owner" },
  })),
}));
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "current-token" },
  }),
}));
vi.mock("../src/hooks/use-generation-error-handler", () => ({
  useGenerationErrorHandler: () => ({
    handleGenerationError: vi.fn(() => false),
  }),
}));

import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import { VideoGeneratorPanel } from "../src/components/canvas/video-generator-panel";
import { queryKeys } from "../src/lib/query/keys";

const api = { getSceneElements: vi.fn(() => []), updateScene: vi.fn() };
const imageProps = {
  elementId: "image-1",
  elementBounds: { x: 0, y: 0, width: 100, height: 100 },
  data: {
    type: "image-generator",
    status: "idle",
    prompt: "",
    model: "image-current",
    aspectRatio: "1:1",
    quality: "standard",
  } as const,
  excalidrawApi: api,
  accessToken: "current-token",
  projectId: "project-1",
  startAttempt: vi.fn(async () => {}),
  canvasScrollZoom: { scrollX: 0, scrollY: 0, zoom: 1 },
  onClose: vi.fn(),
};
const videoProps = {
  elementId: "video-1",
  elementBounds: { x: 0, y: 0, width: 100, height: 100 },
  data: {
    type: "video-generator",
    status: "idle",
    prompt: "",
    model: "video-current",
    aspectRatio: "16:9",
    duration: 4,
    resolution: "720p",
  } as const,
  excalidrawApi: api,
  accessToken: "current-token",
  canvasScrollZoom: { scrollX: 0, scrollY: 0, zoom: 1 },
  onClose: vi.fn(),
};

describe("authenticated canvas model panels", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shares authenticated workspace catalogs across panel remounts", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const first = render(
      <>
        <ImageGeneratorPanel {...imageProps} />
        <VideoGeneratorPanel {...videoProps} />
      </>,
      { wrapper },
    );
    await waitFor(() => expect(fetchImageCatalog).toHaveBeenCalledOnce());
    await waitFor(() => expect(fetchVideoCatalog).toHaveBeenCalledOnce());
    expect(fetchImageCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "current-token" }),
    );
    expect(fetchVideoCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "current-token" }),
    );
    expect(
      client.getQueryData(
        queryKeys.workspace.models.image("user-1", "workspace-1", {}),
      ),
    ).toBeDefined();
    expect(
      client.getQueryData(
        queryKeys.workspace.models.video("user-1", "workspace-1", {}),
      ),
    ).toBeDefined();

    first.unmount();
    render(
      <>
        <ImageGeneratorPanel {...imageProps} />
        <VideoGeneratorPanel {...videoProps} />
      </>,
      { wrapper },
    );
    await Promise.resolve();
    expect(fetchImageCatalog).toHaveBeenCalledOnce();
    expect(fetchVideoCatalog).toHaveBeenCalledOnce();
    expect(client.getQueryState(queryKeys.public.models.agent)).toBeUndefined();
  });
});
