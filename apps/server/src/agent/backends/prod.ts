import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BackendFactory,
  type BackendProtocol,
  CompositeBackend,
  FilesystemBackend,
  LocalShellBackend,
  StateBackend,
  StoreBackend,
} from "deepagents";

const DEFAULT_SANDBOX_ROOT = "/tmp/loomic-sandbox";
const DEFAULT_SKILLS_ROOT = "/opt/loomic/skills";

function withoutExecute(backend: CompositeBackend): BackendProtocol {
  return {
    lsInfo: (path) => backend.lsInfo(path),
    read: (filePath, offset, limit) => backend.read(filePath, offset, limit),
    readRaw: (filePath) => backend.readRaw(filePath),
    grepRaw: (pattern, path, glob) =>
      backend.grepRaw(pattern, path ?? undefined, glob),
    globInfo: (pattern, path) => backend.globInfo(pattern, path),
    write: (filePath, content) => backend.write(filePath, content),
    edit: (filePath, oldString, newString, replaceAll) =>
      backend.edit(filePath, oldString, newString, replaceAll),
    uploadFiles: (files) => backend.uploadFiles(files),
    downloadFiles: (paths) => backend.downloadFiles(paths),
  };
}

/**
 * Create a production backend with per-project persistent file routing.
 *
 * Local shell is opt-in. When disabled, StateBackend keeps normal agent and
 * controlled application tools available without exposing `execute`.
 *
 * 文件持久化（/workspace/、/memories/）走 StoreBackend (PostgresStore)，
 * 与 LocalShellBackend 完全独立互不影响。
 *
 * Routes:
 *   /workspace/        → StoreBackend (PostgresStore, per-project)
 *   /memories/         → StoreBackend (PostgresStore, per-project)
 *   /skills/           → FilesystemBackend (shared, read-only system skills)
 *   /workspace-skills/ → StoreBackend (user-installed workspace skills, optional)
 *   default            → StateBackend, or opt-in LocalShellBackend
 */
export function createProductionBackendFactory(
  canvasId: string,
  options?: {
    allowLocalExecute?: boolean;
    sandboxRoot?: string;
    skillsRoot?: string;
    hasWorkspaceSkills?: boolean;
  },
): { factory: BackendFactory; sandboxDir?: string } {
  const sandboxRoot = resolve(options?.sandboxRoot ?? DEFAULT_SANDBOX_ROOT);
  const skillsRoot = resolve(options?.skillsRoot ?? DEFAULT_SKILLS_ROOT);

  let sandbox: LocalShellBackend | undefined;
  let realSandboxDir: string | undefined;
  if (options?.allowLocalExecute) {
    const runId = crypto.randomUUID();
    const sandboxDir = join(sandboxRoot, runId);
    mkdirSync(sandboxDir, { recursive: true });
    realSandboxDir = realpathSync(sandboxDir);

    // Local shell remains opt-in until a genuinely isolated provider replaces it.
    sandbox = new LocalShellBackend({
      rootDir: sandboxDir,
      virtualMode: true,
      timeout: 120,
      maxOutputBytes: 200_000,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: sandboxDir,
        FONT_DIR: join(skillsRoot, "canvas-design", "canvas-fonts"),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
  }

  const skillsBackend = new FilesystemBackend({
    rootDir: skillsRoot,
    virtualMode: true,
  });

  const factory: BackendFactory = (stateAndStore) => {
    const routes: Record<string, BackendProtocol> = {
      "/memories/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "memories"],
      }),
      "/workspace/": new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace"],
      }),
      "/skills/": skillsBackend,
    };

    if (options?.hasWorkspaceSkills) {
      routes["/workspace-skills/"] = new StoreBackend(stateAndStore, {
        namespace: ["projects", canvasId, "workspace-skills"],
      });
    }

    const defaultBackend = sandbox ?? new StateBackend(stateAndStore);
    const composite = new CompositeBackend(defaultBackend, routes);
    return sandbox ? composite : withoutExecute(composite);
  };

  return {
    factory,
    ...(realSandboxDir ? { sandboxDir: realSandboxDir } : {}),
  };
}
