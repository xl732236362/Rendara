# Phase 0 Security And Quality Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在不重构核心业务的前提下关闭当前 P0 外部攻击面，并建立后续治理所需的自动质量门禁。

**Architecture:** 新增独立的授权、safe-fetch 和限流边界，由现有 HTTP/WS adapter 调用；危险 Agent/Skill 能力通过显式配置默认关闭。构建与 CI 只验证当前架构，不在本阶段迁移应用层或数据库模型。

**Tech Stack:** TypeScript, Fastify 5, `@fastify/rate-limit`, Zod, Vitest, GitHub Actions, Supabase CLI, Docker, Biome, Turborepo

**完成记录（2026-08-17）：** 阶段实现整合提交为 `4a3e01e2e5ccda1b948b88045fe19ee36fb1af10`。由于开始执行时工作区已包含相关未提交修改，原计划中的多个任务级提交合并为一个阶段实现提交；行为、测试和验收步骤仍按任务逐项完成。

---

## 文件结构

### 新建

- `apps/server/src/security/resource-authorization.ts`：验证 canvas、session、run 对当前用户的归属。
- `apps/server/src/security/safe-fetch.ts`：统一 URL、DNS、重定向、响应类型和大小校验。
- `apps/server/src/security/safe-fetch.test.ts`：SSRF、重定向、超时和大小测试。
- `apps/server/src/security/resource-authorization.test.ts`：跨租户授权测试。
- `apps/server/src/config/env.test.ts`：危险能力默认关闭测试。
- `apps/server/src/http/image-proxy.test.ts`：代理入口安全回归测试。
- `apps/server/src/ws/handler.authorization.test.ts`：resume/run/cancel 越权测试。
- `apps/server/src/security/rate-limit.test.ts`：HTTP 限流测试。
- `.github/workflows/ci.yml`：统一质量门禁。
- `.gitattributes`：统一文本换行。
- `.dockerignore`：缩小 Docker build context。

### 修改

- `apps/server/src/config/env.ts`：增加危险能力配置，默认关闭。
- `.env.example`：记录安全开关但不默认启用。
- `apps/server/src/app.ts`：注入 authorization/safe-fetch，注册限流和生命周期清理。
- `apps/server/src/ws/handler.ts`：所有资源命令 fail closed。
- `apps/server/src/agent/backends/index.ts`：生产 execute 未显式启用时拒绝创建 LocalShellBackend。
- `apps/server/src/http/image-proxy.ts`：改用 safe-fetch 并要求认证/严格预算。
- `apps/server/src/features/skills/skill-import-service.ts`：外部导入关闭时拒绝；启用后所有下载走 safe-fetch。
- `apps/server/src/http/skills.ts`：返回稳定的 capability-disabled 错误。
- `apps/server/package.json`：真实编译、限流依赖和测试脚本。
- `apps/server/tsconfig.build.json`：生产编译配置。
- `apps/server/Dockerfile`：仅运行编译产物和 production dependencies。
- `apps/web/next.config.ts`：禁止忽略 TypeScript 错误。
- `biome.json`：精确排除生成目录并建立可通过基线。
- `package.json`：增加 CI 聚合脚本。
- `tests/workspace.test.mjs`：验证门禁脚本和危险默认值。

## Task 1：锁定安全开关的默认行为

**Files:**
- Create: `apps/server/src/config/env.test.ts`
- Modify: `apps/server/src/config/env.ts`
- Modify: `.env.example`

- [x] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "./env.js";

describe("security capability defaults", () => {
  it("disables local execute and external skill imports by default", () => {
    const env = loadServerEnv({}, {});
    expect(env.allowLocalAgentExecute).toBe(false);
    expect(env.allowExternalSkillImport).toBe(false);
  });

  it("only enables capabilities from the exact true literal", () => {
    expect(loadServerEnv({}, { LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "true" }).allowLocalAgentExecute).toBe(true);
    expect(loadServerEnv({}, { LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE: "1" }).allowLocalAgentExecute).toBe(false);
  });
});
```

- [x] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @loomic/server test -- src/config/env.test.ts`

Expected: FAIL，`allowLocalAgentExecute` 尚不存在。

- [x] **Step 3: 添加显式配置字段**

在 `ServerEnv` 中增加：

```ts
allowExternalSkillImport: boolean;
allowLocalAgentExecute: boolean;
```

在 `loadServerEnv` 返回值中增加：

```ts
allowExternalSkillImport:
  overrides.allowExternalSkillImport ??
  source.LOOMIC_ALLOW_EXTERNAL_SKILL_IMPORT === "true",
allowLocalAgentExecute:
  overrides.allowLocalAgentExecute ??
  source.LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE === "true",
```

- [x] **Step 4: 更新环境模板**

在 `.env.example` 安全配置区加入注释，不提供 `true` 默认值：

```dotenv
# Dangerous development-only capabilities. Keep false in shared deployments.
LOOMIC_ALLOW_LOCAL_AGENT_EXECUTE=false
LOOMIC_ALLOW_EXTERNAL_SKILL_IMPORT=false
```

- [x] **Step 5: 验证并提交**

Run: `pnpm --filter @loomic/server test -- src/config/env.test.ts`

Expected: PASS。

Commit: `fix(security): disable dangerous capabilities by default`

## Task 2：阻断生产容器内本地 Shell

**Files:**
- Modify: `apps/server/src/agent/backends/index.ts`
- Modify: `apps/server/src/agent/backends/prod.ts`
- Test: `apps/server/src/config/env.test.ts`

- [x] **Step 1: 增加失败测试**

```ts
import { expect, it } from "vitest";
import { createAgentBackend } from "../agent/backends/index.js";

it("rejects production local execution unless explicitly enabled", () => {
  expect(() =>
    createAgentBackend(
      {
        agentBackendMode: "state",
        allowLocalAgentExecute: false,
      },
      "canvas-1",
    ),
  ).toThrow("Production code execution requires an isolated sandbox provider");
});
```

- [x] **Step 2: 确认测试失败**

Run: `pnpm --filter @loomic/server test -- src/config/env.test.ts`

Expected: FAIL，backend 仍创建 `LocalShellBackend`。

- [x] **Step 3: 将安全开关传入 backend env**

扩展 `AgentBackendEnv`，并在 state backend 分支最前面执行：

```ts
if (!env.allowLocalAgentExecute) {
  throw new Error(
    "Production code execution requires an isolated sandbox provider; local execute is disabled.",
  );
}
```

本阶段保留显式开发开关，仅用于受信本地环境；阶段 3 将替换为远端 sandbox。

- [x] **Step 4: 运行 Agent 相关测试和 typecheck**

Run: `pnpm --filter @loomic/server test && pnpm --filter @loomic/server typecheck`

Expected: PASS。

- [x] **Step 5: 提交**

Commit: `fix(agent): block unsandboxed production execution`

## Task 3：建立对象级授权服务

**Files:**
- Create: `apps/server/src/security/resource-authorization.ts`
- Create: `apps/server/src/security/resource-authorization.test.ts`
- Modify: `apps/server/src/app.ts`

- [x] **Step 1: 定义失败测试所需行为**

```ts
it("rejects a canvas that is not visible through the user client", async () => {
  const authorization = createResourceAuthorization({
    createUserClient: () => fakeClientReturning(null),
  });
  await expect(
    authorization.requireCanvasAccess(user, "other-canvas"),
  ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
});
```

同时覆盖：合法 canvas、session 所属 canvas、run 所属 session，以及资源不存在统一返回 403，避免枚举资源 ID。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm --filter @loomic/server test -- src/security/resource-authorization.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现最小授权接口**

```ts
export type ResourceAuthorization = {
  requireCanvasAccess(user: AuthenticatedUser, canvasId: string): Promise<void>;
  requireSessionAccess(user: AuthenticatedUser, sessionId: string): Promise<{ canvasId: string }>;
  requireRunAccess(user: AuthenticatedUser, runId: string): Promise<{ canvasId: string }>;
};
```

实现只使用 user-scoped Supabase client 和 RLS；不得使用 service role 后再自行比较字段。

- [x] **Step 4: 将实例注入 `buildApp` 和 WS options**

在 `BuildAppOptions` 增加可测试替换项，并由 composition root 创建默认实例。

- [x] **Step 5: 验证并提交**

Run: `pnpm --filter @loomic/server test -- src/security/resource-authorization.test.ts`

Expected: PASS。

Commit: `feat(security): add resource authorization boundary`

## Task 4：关闭 WebSocket 越权路径

**Files:**
- Create: `apps/server/src/ws/handler.authorization.test.ts`
- Modify: `apps/server/src/ws/handler.ts`
- Modify: `apps/server/src/ws/connection-manager.ts`

- [x] **Step 1: 写三组失败测试**

测试必须覆盖：

```ts
expect(await sendCommand(socket, resumeOtherCanvas)).toMatchObject({ type: "error", code: "forbidden" });
expect(eventBuffer.getAfter("other-canvas")).not.toHaveBeenRead();
expect(agentRuns.cancelRun).not.toHaveBeenCalled();
```

另测 client-provided connectionId 与其他用户冲突时由服务端生成新 ID，不替换原连接。

- [x] **Step 2: 运行并确认现有行为失败**

Run: `pnpm --filter @loomic/server test -- src/ws/handler.authorization.test.ts`

Expected: FAIL，未调用 authorization。

- [x] **Step 3: 所有命令先授权再执行**

```ts
await options.authorization.requireCanvasAccess(authenticatedUser, p.canvasId);
connectionManager.bindCanvas(connectionId, authenticatedUser.id, p.canvasId);
```

`agent.run` 先验证 session 与 canvas 一致；`agent.cancel` 先 `requireRunAccess`。删除“thread resolve 失败继续执行”的路径，改为发送稳定错误并返回。

- [x] **Step 4: 收紧 ConnectionManager identity**

`register` 必须检查已有 entry 的 userId；不同用户不得替换。canvas index key 使用 `${userId}:${canvasId}` 或保存明确 tenant metadata，避免未来调用遗漏 scope。

- [x] **Step 5: 回归并提交**

Run: `pnpm --filter @loomic/server test -- src/ws/handler.authorization.test.ts`

Expected: PASS。

Commit: `fix(ws): enforce object authorization for canvas and runs`

## Task 5：实现统一 Safe Fetch

**Files:**
- Create: `apps/server/src/security/safe-fetch.ts`
- Create: `apps/server/src/security/safe-fetch.test.ts`

- [x] **Step 1: 写失败测试矩阵**

```ts
it.each([
  "http://example.com/a.png",
  "https://127.0.0.1/a.png",
  "https://[::1]/a.png",
  "https://169.254.169.254/latest/meta-data",
  "https://evilreplicate.com/a.png",
])("rejects unsafe URL %s", async (url) => {
  await expect(safeFetch(url, imagePolicy)).rejects.toMatchObject({ code: "unsafe_url" });
});
```

补充 DNS 解析到私网、公开地址重定向到私网、超时、超过 20 MB、非图片 MIME 和合法精确子域测试。测试通过依赖注入的 resolver/fetch 模拟，不访问真实网络。

- [x] **Step 2: 运行并确认失败**

Run: `pnpm --filter @loomic/server test -- src/security/safe-fetch.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 定义 policy 和返回值**

```ts
export type SafeFetchPolicy = {
  allowedHosts: readonly string[];
  allowedMimeTypes: readonly RegExp[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
};

export type SafeFetchResult = {
  body: Buffer;
  contentType: string;
  finalUrl: URL;
};
```

实现精确 host 或 `hostname === suffix || hostname.endsWith('.' + suffix)`；限制 `https:`；使用 DNS lookup 检查所有 A/AAAA；redirect 使用 manual 模式逐跳校验；流式读取并在超限时中止。

- [x] **Step 4: 验证测试**

Run: `pnpm --filter @loomic/server test -- src/security/safe-fetch.test.ts`

Expected: PASS。

- [x] **Step 5: 提交**

Commit: `feat(security): add bounded SSRF-safe fetch service`

## Task 6：迁移图片代理并加认证

**Files:**
- Create: `apps/server/src/http/image-proxy.test.ts`
- Modify: `apps/server/src/http/image-proxy.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/lib/canvas-elements.ts`

- [x] **Step 1: 写失败路由测试**

覆盖无 token 返回 401、非法 host 返回 403、超限返回 413、合法图片保留 MIME、上游错误不透传正文。

- [x] **Step 2: 确认现有路由失败**

Run: `pnpm --filter @loomic/server test -- src/http/image-proxy.test.ts`

Expected: FAIL，无认证且使用裸 fetch。

- [x] **Step 3: 注入 auth 与 safe-fetch**

```ts
export function registerImageProxyRoute(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; safeFetch: SafeFetcher },
) { /* adapter only */ }
```

策略仅允许实际 Provider 输出 host 和当前 Supabase Storage host；禁止宽泛 `supabase.co`。

- [x] **Step 4: 前端代理请求携带 bearer token**

将 `fetchAsDataURL` 改为显式接收 `accessToken`，沿调用链传入；不得把 token 放到 URL。

- [x] **Step 5: 验证并提交**

Run: `pnpm --filter @loomic/server test -- src/http/image-proxy.test.ts && pnpm --filter @loomic/web test -- test/canvas-elements.test.ts`

Expected: PASS。

Commit: `fix(proxy): authenticate and bound external image fetches`

## Task 7：关闭并约束外部 Skill 导入

**Files:**
- Modify: `apps/server/src/http/skills.ts`
- Modify: `apps/server/src/features/skills/skill-import-service.ts`
- Create: `apps/server/src/features/skills/skill-import-service.test.ts`

- [x] **Step 1: 写关闭状态测试**

```ts
expect(await importRoute({ enabled: false, url: githubUrl })).toMatchObject({
  statusCode: 403,
  body: { error: { code: "capability_disabled" } },
});
```

另测 tarball URL 不在精确 registry host 时拒绝；下载和展开总字节超限时失败且不写数据库。

- [x] **Step 2: 确认测试失败**

Run: `pnpm --filter @loomic/server test -- src/features/skills/skill-import-service.test.ts`

Expected: FAIL，导入默认可用且下载无统一预算。

- [x] **Step 3: 路由 fail closed**

在调用 importer 前检查 `env.allowExternalSkillImport`。本阶段启用时只允许 `github.com` 与 `registry.npmjs.org`，所有内容下载复用 safe-fetch；禁止任意 `.tgz` host。

- [x] **Step 4: 增加 archive 配额**

定义并测试：压缩包 10 MB、最多 200 entries、单文件 1 MB、展开文本总量 20 MB、目录深度 8。超过任一限制抛 `skill_archive_limit_exceeded`。

- [x] **Step 5: 导入后默认禁用**

将自动安装记录的 `enabled` 改为 `false`，返回 `requiresReview: true`。阶段 3 再实现完整权限审查界面。

- [x] **Step 6: 验证并提交**

Run: `pnpm --filter @loomic/server test -- src/features/skills/skill-import-service.test.ts`

Expected: PASS。

Commit: `fix(skills): gate and bound external imports`

## Task 8：增加入口限流

**Files:**
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/src/security/rate-limit.test.ts`

- [x] **Step 1: 安装与锁定兼容版本**

Run: `pnpm --filter @loomic/server add @fastify/rate-limit`

Expected: `package.json` 与 lockfile 更新；选择与 Fastify 5 兼容的当前稳定版本。

- [x] **Step 2: 写失败测试**

使用 app injection 验证同一身份短时间超过代理/导入/生成预算后返回 429，并包含稳定 `rate_limited` 错误码；健康检查不受业务限流影响。

- [x] **Step 3: 注册全局基础限流**

默认 key 优先使用认证 userId，否则使用受信代理配置下的 IP。不要直接信任任意 `X-Forwarded-For`。

- [x] **Step 4: 为高成本路由设置更严格预算**

初始开发基线：生成每用户每分钟 10 次、skill 导入每小时 5 次、图片代理每分钟 60 次、上传每分钟 20 次。限流值进入严格 env schema，后续根据负载测试调整。

- [x] **Step 5: WebSocket 增加应用层预算**

在连接 entry 维护固定窗口计数：每连接消息大小最大 1 MB、每分钟 command 60、并发 agent.run 1。超限发送错误并在持续违规时关闭连接。

- [x] **Step 6: 验证并提交**

Run: `pnpm --filter @loomic/server test -- src/security/rate-limit.test.ts`

Expected: PASS。

Commit: `feat(security): rate limit expensive entry points`

## Task 9：恢复可用的 lint 与换行基线

**Files:**
- Create: `.gitattributes`
- Modify: `biome.json`
- Modify: `.gitignore`

- [x] **Step 1: 固定文本规则**

```gitattributes
* text=auto eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
*.png binary
*.jpg binary
*.ttf binary
```

- [x] **Step 2: 修正生成目录排除**

Biome 忽略必须覆盖 `**/.next*/**`、`playwright-report`、`test-results`、coverage、`.codex-logs` 和所有构建输出。不要忽略源码目录或通过关闭 recommended rules 获得通过。

- [x] **Step 3: 获取真实源码诊断基线**

Run: `pnpm lint`

Expected: 诊断只来自受版本控制源码，不再扫描 `.next.stale-*`。

- [x] **Step 4: 分离机械格式修复与语义修复**

先运行 `pnpm exec biome check --write .` 产生独立格式提交；再逐项修复剩余 `any`、imports 和 suspicious rules。不得使用 `--unsafe` 批量改写。

- [x] **Step 5: 验证并提交**

Run: `pnpm lint && git diff --check`

Expected: PASS。

Commits: `chore(format): establish repository formatting baseline`，随后 `fix(lint): resolve source diagnostics`。

## Task 10：建立真实生产构建

**Files:**
- Create: `apps/server/tsconfig.build.json`
- Modify: `apps/server/package.json`
- Modify: `apps/server/Dockerfile`
- Create: `.dockerignore`
- Modify: `apps/web/next.config.ts`

- [x] **Step 1: 写 workspace 失败断言**

在 `tests/workspace.test.mjs` 断言 server build 不再引用 `validate-foundation-app.mjs`，并断言 Web 未设置 `ignoreBuildErrors: true`。

- [x] **Step 2: 确认断言失败**

Run: `pnpm test:workspace`

Expected: FAIL。

- [x] **Step 3: 配置 server 编译**

`tsconfig.build.json` 继承 base config，设置 `noEmit: false`、`outDir: dist`、`rootDir: src`，排除测试。server scripts 改为：

```json
{
  "build": "tsc -p tsconfig.build.json",
  "start": "node dist/server.js",
  "start:worker": "node dist/worker.js"
}
```

- [x] **Step 4: 收紧 Docker production stage**

Builder 执行 shared/server build；production 只复制 `dist`、shared dist、skills 和 production node_modules，使用非 root 用户运行 `node dist/server.js`/`worker.js`。不要复制 `.env`、tests、git 或源码。

- [x] **Step 5: 恢复 Next 类型门禁**

删除 `typescript.ignoreBuildErrors`。保留静态导出前必须验证所有页面均兼容 `output: "export"`。

- [x] **Step 6: 验证构建和镜像**

Run: `pnpm build`

Expected: server 生成 `dist/server.js` 与 `dist/worker.js`，Web build 通过。

Run: `docker build -f apps/server/Dockerfile -t loomic-server:phase0 .`

Expected: image build succeeds。

Run: `docker run --rm --entrypoint node loomic-server:phase0 -e "import('./dist/app.js').then(() => console.log('app-load-ok'))"`

Expected: 输出 `app-load-ok`。

- [x] **Step 7: 提交**

Commit: `build(server): produce minimal production artifacts`

## Task 11：建立 CI 门禁

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `tests/workspace.test.mjs`

- [x] **Step 1: 增加聚合脚本**

```json
{
  "ci:check": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
}
```

- [x] **Step 2: 写 workspace 断言**

验证 `ci:check` 包含四项门禁，workflow 使用 package.json 中的 `packageManager` 版本并执行 frozen lockfile 安装。

- [x] **Step 3: 创建 workflow**

Workflow 至少包含：

```yaml
jobs:
  quality:
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm ci:check
```

另设 `database` job 启动 Supabase CLI、执行 `supabase db reset`，并运行阶段 0 的 RLS/权限 smoke tests；另设 Docker build job。

- [x] **Step 4: 本地执行完整门禁**

Run: `pnpm ci:check`

Expected: PASS。

Run: `supabase db reset`

Expected: 所有 migration 从零成功应用。

- [x] **Step 5: 提交**

Commit: `ci: enforce quality database and image gates`

## Task 12：阶段验收与台账更新

**Files:**
- Modify: `docs/tech/engineering-issues-register.md`
- Create: `docs/tech/phase-0-verification.md`

- [x] **Step 1: 运行安全回归**

Run: `pnpm --filter @loomic/server test -- src/security src/ws/handler.authorization.test.ts src/http/image-proxy.test.ts`

Expected: 所有授权、SSRF、限流和 capability 测试通过。

- [x] **Step 2: 运行全仓门禁**

Run: `pnpm ci:check`

Expected: PASS。

- [x] **Step 3: 运行数据库与容器验证**

Run: `supabase db reset`

Expected: PASS。

Run: `docker build -f apps/server/Dockerfile -t loomic-server:phase0 .`

Expected: PASS。

- [x] **Step 4: 记录验证证据**

`phase-0-verification.md` 记录命令、日期、commit SHA、关键安全测试名称和结果，不粘贴密钥或完整环境配置。

- [x] **Step 5: 更新问题状态**

将已完成的 ENG-003、004、006、010、028、029、031 标记为“已解决”或“部分解决”；ENG-027、030 标记为“风险入口已关闭，目标方案在阶段 3 实施”。

- [x] **Step 6: 提交阶段验收**

Commit: `docs(governance): record phase zero verification`
