import { type APIRequestContext, expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const email = process.env.E2E_EMAIL ?? "pro@test.loomic.com";
const password = process.env.E2E_PASSWORD ?? "opensourceloomic";
const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseAnonKey = requireEnv("SUPABASE_ANON_KEY");
const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3101";
const fixtureBaseUrl =
  process.env.E2E_AGENT_FIXTURE_URL ?? "http://127.0.0.1:3199";

let accessToken = "";
let createdProjectId: string | undefined;

test.beforeAll(async ({ request }) => {
  const fixtureHealth = await request.get(`${fixtureBaseUrl}/health`);
  expect(
    fixtureHealth.ok(),
    "deterministic Agent fixture must be running",
  ).toBe(true);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) {
    throw new Error(
      `E2E test account login failed: ${error?.message ?? "missing session"}`,
    );
  }
  accessToken = data.session.access_token;
});

test.afterAll(async ({ request }) => {
  if (!createdProjectId || !accessToken) return;
  const response = await apiRequest(
    request,
    `/api/projects/${createdProjectId}`,
    { method: "DELETE" },
  );
  expect(response.status(), "E2E project cleanup must succeed").toBe(204);
});

test("idle save, Agent attachment, concurrent edit, and next message remain reliable", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const projectResponse = await apiRequest(request, "/api/projects", {
    method: "POST",
    data: { name: `Generated asset reliability ${Date.now()}` },
  });
  const projectResponseText = await projectResponse.text();
  expect(projectResponse.status(), projectResponseText).toBe(201);
  const projectBody = JSON.parse(projectResponseText) as {
    project: { id: string; primaryCanvas: { id: string } };
  };
  createdProjectId = projectBody.project.id;
  const canvasId = projectBody.project.primaryCanvas.id;

  const initialCanvas = await readCanvas(request, canvasId);
  const seedResponse = await apiRequest(request, `/api/canvases/${canvasId}`, {
    method: "PUT",
    data: {
      expectedRevision: initialCanvas.revision,
      content: {
        elements: [seedRectangle()],
        appState: { viewBackgroundColor: "#ffffff", gridModeEnabled: false },
        files: {},
      },
    },
  });
  expect(seedResponse.status()).toBe(200);
  const seededRevision = ((await seedResponse.json()) as { revision: number })
    .revision;

  await signIn(page);
  await page.goto(`/canvas?id=${canvasId}`);
  await expect(page.locator(".excalidraw-container")).toBeVisible();
  await expect(page.getByLabel("输入消息")).toBeEnabled();
  await expect(page.getByText("连接已断开，正在重连...")).toBeHidden();

  await page.waitForTimeout(3_500);
  await expect
    .poll(async () => (await readCanvas(request, canvasId)).revision)
    .toBe(seededRevision);

  const input = page.getByLabel("输入消息");
  const sendButton = input.locator("xpath=..").getByRole("button").last();
  await input.fill("Generate exactly one image of a red circle.");
  await input.press("Enter");
  await expect(
    page
      .getByText("Generate exactly one image of a red circle.", {
        exact: true,
      })
      .last(),
  ).toBeVisible();

  const canvasBox = await page.locator(".excalidraw-container").boundingBox();
  if (!canvasBox) throw new Error("canvas bounding box unavailable");
  await page
    .locator(".excalidraw-container")
    .click({ position: { x: 420, y: 320 } });
  await page.keyboard.press("o");
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 160);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 240, canvasBox.y + 250);
  await page.mouse.up();

  await expect
    .poll(
      async () => {
        const canvas = await readCanvas(request, canvasId);
        return {
          imageCount: canvas.content.elements.filter(
            (element) => element.type === "image" && !element.isDeleted,
          ).length,
          hasLocalEllipse: canvas.content.elements.some(
            (element) => element.type === "ellipse" && !element.isDeleted,
          ),
        };
      },
      { timeout: 40_000 },
    )
    .toEqual({ imageCount: 1, hasLocalEllipse: true });

  const attachedCanvas = await readCanvas(request, canvasId);
  const generatedFile = Object.values(attachedCanvas.content.files).find(
    (file) => typeof file.assetId === "string" && file.assetId.length > 0,
  );
  expect(
    generatedFile,
    "generated image must retain its asset identity",
  ).toBeDefined();
  const assetUrlResponse = await apiRequest(
    request,
    `/api/uploads/${String(generatedFile?.assetId)}/url`,
  );
  expect(assetUrlResponse.status()).toBe(200);
  const { url: generatedImageUrl } = (await assetUrlResponse.json()) as {
    url: string;
  };
  const generatedImageResponse = await request.get(generatedImageUrl);
  expect(generatedImageResponse.ok()).toBe(true);
  expect(generatedImageResponse.headers()["content-type"]).toContain("image/");

  await expect(input).toBeEnabled();
  await input.fill("Reply with done.");
  await expect(sendButton).toBeEnabled({ timeout: 30_000 });
  await input.press("Enter");
  await expect(
    page.getByText("Reply with done.", { exact: true }).last(),
  ).toBeVisible();
  await expect(page.getByText("done", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const finalCanvas = await readCanvas(request, canvasId);
  expect(
    finalCanvas.content.elements.filter(
      (element) => element.type === "image" && !element.isDeleted,
    ),
  ).toHaveLength(1);
  expect(
    finalCanvas.content.elements.some(
      (element) => element.id === "e2e-seed-rectangle" && !element.isDeleted,
    ),
  ).toBe(true);
  expect(
    finalCanvas.content.elements.some(
      (element) => element.type === "ellipse" && !element.isDeleted,
    ),
  ).toBe(true);
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Use password instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);

  const viewerResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiBaseUrl}/api/viewer` &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const viewerResponse = await viewerResponsePromise;
  expect(viewerResponse.status()).toBe(200);
}

async function readCanvas(request: APIRequestContext, canvasId: string) {
  const response = await apiRequest(request, `/api/canvases/${canvasId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    canvas: {
      revision: number;
      content: {
        elements: Array<Record<string, unknown>>;
        appState: Record<string, unknown>;
        files: Record<string, Record<string, unknown>>;
      };
    };
  };
  return body.canvas;
}

function apiRequest(
  request: APIRequestContext,
  path: string,
  options: { method?: string; data?: unknown } = {},
) {
  return request.fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function seedRectangle() {
  return {
    id: "e2e-seed-rectangle",
    type: "rectangle",
    x: 80,
    y: 80,
    width: 160,
    height: 100,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: "a0",
    roundness: { type: 3 },
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for E2E tests.`);
  return value;
}
