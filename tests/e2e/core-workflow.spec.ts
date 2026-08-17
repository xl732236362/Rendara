import { type APIRequestContext, expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const email = process.env.E2E_EMAIL ?? "pro@test.loomic.com";
const password = process.env.E2E_PASSWORD ?? "opensourceloomic";
const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseAnonKey = requireEnv("SUPABASE_ANON_KEY");
const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3101";

let accessToken = "";
let createdProjectId: string | undefined;

test.beforeAll(async () => {
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
    {
      method: "DELETE",
    },
  );
  expect(response.status(), "E2E project cleanup must succeed").toBe(204);
});

test("configured AI models are exposed by the running API", async ({
  request,
}) => {
  const textModels = await apiRequest(request, "/api/models");
  expect(textModels.ok()).toBeTruthy();
  const textBody = (await textModels.json()) as {
    models: Array<{ id: string }>;
  };
  expect(textBody.models.map((model) => model.id)).toContain(
    "openai:gpt-5.6-terra",
  );

  const imageModels = await apiRequest(request, "/api/image-models");
  expect(imageModels.ok()).toBeTruthy();
  const imageBody = (await imageModels.json()) as {
    models: Array<{ id: string }>;
  };
  expect(imageBody.models.map((model) => model.id)).toContain("gpt-image-2");
});

test("user can sign in, create a project, and reopen its canvas", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Use password instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/home$/);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();

  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiBaseUrl}/api/projects` &&
      response.request().method() === "POST",
  );
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "新建项目" }).click();

  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const createBody = (await createResponse.json()) as {
    project: { id: string; primaryCanvas: { id: string } };
  };
  createdProjectId = createBody.project.id;

  const canvasPage = await popupPromise;
  await canvasPage.waitForLoadState("domcontentloaded");
  await expect(canvasPage).toHaveURL(
    new RegExp(`/canvas\\?id=${createBody.project.primaryCanvas.id}`),
  );
  await expect(canvasPage.getByRole("button", { name: "菜单" })).toBeVisible();
  await expect(canvasPage.locator(".excalidraw-container")).toBeVisible();

  await canvasPage.reload();
  await expect(canvasPage.getByRole("button", { name: "菜单" })).toBeVisible();
  await expect(canvasPage.locator(".excalidraw-container")).toBeVisible();
});

function apiRequest(
  request: APIRequestContext,
  path: string,
  options: { method?: string } = {},
) {
  return request.fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for E2E tests.`);
  return value;
}
