# Docker 本地开发重建与重启设计

## 目标

为 Loomic 提供一个可双击执行的 Windows 批处理入口，通过 Docker 重新构建并重启本地开发环境，同时保留 Web、API 和 Worker 的代码热更新能力。

该入口必须做到：

- 不改变现有生产镜像和 Railway 部署行为。
- Web、API、Worker 分别运行，便于观察日志和独立排障。
- 复用根目录 `.env.local`，不复制或提交密钥。
- 重新构建依赖环境后启动服务，并在当前窗口聚合显示日志。
- 对 Docker 未启动、环境文件缺失、构建失败和启动失败给出明确提示和非零退出码。

## 现状

本地开发目前由 Windows 主机上的 `pnpm dev` 启动：

- Web 使用 Next.js，监听 `3000`。
- API 使用 Node.js、tsx 和 watch 模式，监听 `3001`。
- Worker 使用 Node.js、tsx 和 watch 模式。
- 本地 Supabase 已由 Supabase CLI 管理为多个 Docker 容器。

仓库已有 `apps/server/Dockerfile`，但它面向生产构建，只包含 API/Worker 运行产物，不包含 Web，也不适合源码挂载和热更新。

## 方案

### 开发镜像

新增根目录开发专用 Dockerfile。镜像基于项目要求的 Node 22，并启用固定版本 pnpm。构建阶段仅复制 workspace 清单和各包的 `package.json` 后安装锁定依赖，以利用 Docker 层缓存。

开发镜像不执行生产构建，也不替代 `apps/server/Dockerfile`。容器启动后由各 Compose 服务执行各自的开发命令。

### Compose 服务

新增本地开发 Compose 配置，包含三个服务：

| 服务 | 命令 | 对外端口 | 职责 |
| --- | --- | --- | --- |
| `web` | `pnpm --filter @loomic/web dev` | `3000` | Next.js 前端与热更新 |
| `api` | `pnpm --filter @loomic/server dev:server` | `3001` | Fastify API、WebSocket 与热更新 |
| `worker` | `pnpm --filter @loomic/server dev:worker` | 无 | 后台任务消费与热更新 |

三个服务共享同一个开发镜像，但拥有独立容器和进程生命周期。源码目录以 bind mount 挂载到 `/workspace`。依赖目录和框架缓存使用 Docker 命名卷，避免宿主机 Windows 依赖覆盖 Linux 容器依赖，并降低重复构建成本。

Compose 从根目录 `.env.local` 向服务注入环境变量。容器内 API 监听 `0.0.0.0:3001`；浏览器仍通过 `http://localhost:3001` 访问 API。Worker 使用稳定且可识别的本地 `WORKER_ID`。

Web 依赖 API 就绪后启动，Worker 同样等待 API 健康检查通过。API 健康检查调用现有 `/api/health` 接口。服务设置适合本地开发的失败重启策略，不掩盖主动停止行为。

### Windows 批处理入口

在仓库根目录新增 `rebuild-and-restart-dev.bat`。脚本从自身所在目录运行，避免用户从不同工作目录双击时失败。

执行流程：

1. 检查 `docker` 命令和 Docker Engine 是否可用。
2. 检查根目录 `.env.local` 是否存在。
3. 停止并移除本 Compose 项目的旧开发容器和网络，保留依赖卷。
4. 使用最新本地 Dockerfile 重新构建开发镜像。
5. 启动 Web、API、Worker，并在当前窗口显示聚合日志。
6. 任一阶段失败时记录阶段、时间和退出码，暂停窗口供用户阅读。

脚本只管理具有固定 Compose project name 的 Loomic 开发容器，不按端口杀进程，也不影响 Supabase 容器或其他 Docker 项目。

为日常使用提供 `--no-cache` 可选参数：默认重建会复用 Docker 缓存；传入该参数时强制从头重建。这样兼顾正常启动速度与依赖缓存异常时的彻底重建需求。

### 日志与维护说明

批处理输出带时间和阶段标签的简洁日志。Compose 负责为各服务日志添加服务名前缀。关键配置旁加入维护注释，说明为什么必须隔离 `node_modules`、为什么 API 需监听 `0.0.0.0`，以及生产 Dockerfile 与开发 Dockerfile 的边界。

README 增加本地 Docker 开发用法、停止命令、无缓存重建命令及常见故障入口，方便后续接手者定位问题。

## 错误处理

- Docker CLI 缺失或 Engine 未运行：构建前终止并提示启动 Docker Desktop。
- `.env.local` 缺失：终止并指向 `.env.example`。
- 端口 `3000` 或 `3001` 被非本项目进程占用：Compose 启动失败并保留明确错误，不主动终止未知进程。
- 镜像构建失败：不进入启动阶段，保留构建日志和退出码。
- API 健康检查失败：依赖服务不启动，用户可从聚合日志定位 API 配置问题。
- 用户按 `Ctrl+C`：结束日志附着；开发容器继续运行，随后提示可使用明确的 Compose 停止命令。

## 验证

实现完成后执行以下验证：

1. 校验 Compose 配置能被 Docker 正确解析。
2. 在 `.env.local` 存在时执行批处理，确认三个服务成功创建。
3. 确认 `http://localhost:3000` 可访问，`http://localhost:3001/api/health` 返回成功。
4. 修改 Web 源文件，确认 Next.js 自动刷新且容器未重建。
5. 修改 API/Worker 源文件，确认 watch 进程自动重启。
6. 再次执行批处理，确认只重建并替换 Loomic 开发容器，不影响 Supabase 容器。
7. 模拟 Docker Engine 不可用或 `.env.local` 缺失，确认脚本以非零状态退出并显示可操作提示。

## 非目标

- 不将本地 Supabase 纳入该 Compose 配置；继续由 Supabase CLI 管理。
- 不修改 Railway 或其他生产部署流程。
- 不在容器内运行数据库迁移、测试套件或 seed。
- 不自动删除依赖卷、构建缓存或用户数据。
