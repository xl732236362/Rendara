import {
  type AssetSignedUrlResponse,
  type CanvasDetail,
  type ChatMessageCreateRequest,
  type GenerateImageResponse,
  type GenerateVideoResponse,
  type GenerationModelInfo,
  type JobResponse,
  type MarketplaceDetail,
  type MarketplaceSearchResponse,
  type MessageCreateResponse,
  type MessageListResponse,
  type ModelListResponse,
  type ProfileUpdateResponse,
  type ProjectCreateRequest,
  type ProjectCreateResponse,
  type ProjectListResponse,
  type ProjectUpdateRequest,
  type RunCreateRequest,
  type RunCreateResponse,
  type SessionCreateResponse,
  type SessionListResponse,
  type SkillCreateRequest,
  type SkillDetailResponse,
  type SkillFilesResponse,
  type SkillListResponse,
  type SkillUpdateRequest,
  type UploadResponse,
  type ViewerResponse,
  type WorkspaceSettingsResponse,
  type WorkspaceSkillListResponse,
  assetSignedUrlResponseSchema,
  canvasGetResponseSchema,
  canvasSaveRequestSchema,
  canvasSaveResponseSchema,
  chatMessageCreateRequestSchema,
  generateImageRequestSchema,
  generateImageResponseSchema,
  generateVideoRequestSchema,
  generateVideoResponseSchema,
  imageModelListResponseSchema,
  jobResponseSchema,
  marketplaceDetailSchema,
  marketplaceInstallRequestSchema,
  marketplaceSearchResponseSchema,
  messageCreateResponseSchema,
  messageListResponseSchema,
  modelListResponseSchema,
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
  projectCreateRequestSchema,
  projectCreateResponseSchema,
  projectDetailResponseSchema,
  projectListResponseSchema,
  projectUpdateRequestSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  sessionCreateResponseSchema,
  sessionListResponseSchema,
  sessionTitleRequestSchema,
  skillCreateRequestSchema,
  skillDetailResponseSchema,
  skillFilesResponseSchema,
  skillImportRequestSchema,
  skillListResponseSchema,
  skillUpdateRequestSchema,
  uploadResponseSchema,
  videoModelListResponseSchema,
  viewerResponseSchema,
  workspaceSettingsResponseSchema,
  workspaceSettingsUpdateRequestSchema,
  workspaceSkillInstallRequestSchema,
  workspaceSkillListResponseSchema,
  workspaceSkillToggleRequestSchema,
} from "@loomic/shared";

import {
  ApiApplicationError,
  ApiAuthError,
  ApiProtocolError,
  apiFetch,
} from "./api-client";
import { dedupeRequest } from "./dedupe-request";

export { ApiApplicationError, ApiAuthError, ApiProtocolError };

export function createRun(
  payload: RunCreateRequest,
  options?: { accessToken?: string },
): Promise<RunCreateResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/agent/runs",
    ...(options?.accessToken ? { accessToken: options.accessToken } : {}),
    requestSchema: runCreateRequestSchema,
    body: payload,
    responseSchema: runCreateResponseSchema,
  });
}

export function fetchViewer(accessToken: string): Promise<ViewerResponse> {
  return apiFetch({
    method: "GET",
    path: "/api/viewer",
    accessToken,
    responseSchema: viewerResponseSchema,
  });
}

export function fetchProjects(
  accessToken: string,
): Promise<ProjectListResponse> {
  return apiFetch({
    method: "GET",
    path: "/api/projects",
    accessToken,
    responseSchema: projectListResponseSchema,
  });
}

export function createProject(
  accessToken: string,
  data: ProjectCreateRequest,
): Promise<ProjectCreateResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/projects",
    accessToken,
    requestSchema: projectCreateRequestSchema,
    body: data,
    responseSchema: projectCreateResponseSchema,
  });
}

export function deleteProject(
  accessToken: string,
  projectId: string,
): Promise<void> {
  return apiFetch({
    method: "DELETE",
    path: `/api/projects/${projectId}`,
    accessToken,
    responseMode: "empty",
  });
}

export function fetchProject(
  accessToken: string,
  projectId: string,
): Promise<{
  project: { id: string; name: string; brand_kit_id: string | null };
}> {
  return apiFetch({
    method: "GET",
    path: `/api/projects/${projectId}`,
    accessToken,
    responseSchema: projectDetailResponseSchema,
  });
}

export function updateProject(
  accessToken: string,
  projectId: string,
  data: ProjectUpdateRequest,
): Promise<void> {
  return apiFetch({
    method: "PATCH",
    path: `/api/projects/${projectId}`,
    accessToken,
    requestSchema: projectUpdateRequestSchema,
    body: data,
    responseMode: "empty",
  });
}

export function fetchCanvas(
  accessToken: string,
  canvasId: string,
): Promise<{ canvas: CanvasDetail }> {
  return apiFetch({
    method: "GET",
    path: `/api/canvases/${canvasId}`,
    accessToken,
    responseSchema: canvasGetResponseSchema,
  });
}

export function saveCanvas(
  accessToken: string,
  canvasId: string,
  expectedRevision: number,
  content: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  },
): Promise<{ ok: true; revision: number }> {
  return apiFetch({
    method: "PUT",
    path: `/api/canvases/${canvasId}`,
    accessToken,
    requestSchema: canvasSaveRequestSchema,
    body: { expectedRevision, content },
    responseSchema: canvasSaveResponseSchema,
  });
}

export function uploadThumbnail(
  accessToken: string,
  projectId: string,
  blob: Blob,
): Promise<void> {
  const body = new FormData();
  body.append("file", blob, "thumbnail.webp");
  return apiFetch({
    method: "PUT",
    path: `/api/projects/${projectId}/thumbnail`,
    accessToken,
    body,
    responseMode: "empty",
  });
}

export function updateProfile(
  accessToken: string,
  data: { displayName: string },
): Promise<ProfileUpdateResponse> {
  return apiFetch({
    method: "PATCH",
    path: "/api/viewer/profile",
    accessToken,
    requestSchema: profileUpdateRequestSchema,
    body: data,
    responseSchema: profileUpdateResponseSchema,
  });
}

export function fetchWorkspaceSettings(
  accessToken: string,
): Promise<WorkspaceSettingsResponse> {
  return apiFetch({
    method: "GET",
    path: "/api/workspace/settings",
    accessToken,
    responseSchema: workspaceSettingsResponseSchema,
  });
}

export function updateWorkspaceSettings(
  accessToken: string,
  data: { defaultModel: string },
): Promise<WorkspaceSettingsResponse> {
  return apiFetch({
    method: "PUT",
    path: "/api/workspace/settings",
    accessToken,
    requestSchema: workspaceSettingsUpdateRequestSchema,
    body: data,
    responseSchema: workspaceSettingsResponseSchema,
  });
}

export function fetchModels(): Promise<ModelListResponse> {
  return apiFetch({
    method: "GET",
    path: "/api/models",
    responseSchema: modelListResponseSchema,
  });
}

export function fetchSessions(
  accessToken: string,
  canvasId: string,
): Promise<SessionListResponse> {
  return dedupeRequest(`sessions:${canvasId}`, () =>
    apiFetch({
      method: "GET",
      path: `/api/canvases/${canvasId}/sessions`,
      accessToken,
      responseSchema: sessionListResponseSchema,
    }),
  );
}

export function createSession(
  accessToken: string,
  canvasId: string,
  title?: string,
): Promise<SessionCreateResponse> {
  return apiFetch({
    method: "POST",
    path: `/api/canvases/${canvasId}/sessions`,
    accessToken,
    requestSchema: sessionTitleRequestSchema,
    body: title ? { title } : {},
    responseSchema: sessionCreateResponseSchema,
  });
}

export function updateSessionTitle(
  accessToken: string,
  sessionId: string,
  title: string,
): Promise<void> {
  return apiFetch({
    method: "PATCH",
    path: `/api/sessions/${sessionId}`,
    accessToken,
    requestSchema: sessionTitleRequestSchema,
    body: { title },
    responseMode: "empty",
  });
}

export function deleteSession(
  accessToken: string,
  sessionId: string,
): Promise<void> {
  return apiFetch({
    method: "DELETE",
    path: `/api/sessions/${sessionId}`,
    accessToken,
    responseMode: "empty",
  });
}

export function fetchMessages(
  accessToken: string,
  sessionId: string,
): Promise<MessageListResponse> {
  return apiFetch({
    method: "GET",
    path: `/api/sessions/${sessionId}/messages`,
    accessToken,
    responseSchema: messageListResponseSchema,
  });
}

export function saveMessage(
  accessToken: string,
  sessionId: string,
  data: ChatMessageCreateRequest,
): Promise<MessageCreateResponse> {
  return apiFetch({
    method: "POST",
    path: `/api/sessions/${sessionId}/messages`,
    accessToken,
    requestSchema: chatMessageCreateRequestSchema,
    body: data,
    responseSchema: messageCreateResponseSchema,
  });
}

export function uploadFile(
  accessToken: string,
  file: File,
  projectId?: string,
): Promise<UploadResponse> {
  const body = new FormData();
  body.append("file", file);
  if (projectId) body.append("projectId", projectId);
  return apiFetch({
    method: "POST",
    path: "/api/uploads",
    accessToken,
    body,
    responseSchema: uploadResponseSchema,
  });
}

export function getAssetUrl(
  accessToken: string,
  assetId: string,
): Promise<AssetSignedUrlResponse> {
  return apiFetch({
    method: "GET",
    path: `/api/uploads/${assetId}/url`,
    accessToken,
    responseSchema: assetSignedUrlResponseSchema,
  });
}

export function deleteAsset(
  accessToken: string,
  assetId: string,
): Promise<void> {
  return apiFetch({
    method: "DELETE",
    path: `/api/uploads/${assetId}`,
    accessToken,
    responseMode: "empty",
  });
}

export type ImageModelInfo = GenerationModelInfo;
export type VideoModelInfo = GenerationModelInfo;
export type { GenerateImageResponse, GenerateVideoResponse };

export function fetchImageModels(): Promise<{ models: ImageModelInfo[] }> {
  return apiFetch({
    method: "GET",
    path: "/api/image-models",
    responseSchema: imageModelListResponseSchema,
  });
}

export function fetchVideoModels(): Promise<{ models: VideoModelInfo[] }> {
  return apiFetch({
    method: "GET",
    path: "/api/video-models",
    responseSchema: videoModelListResponseSchema,
  });
}

export function generateImageDirect(
  accessToken: string,
  prompt: string,
  options?: { model?: string; aspectRatio?: string; quality?: string },
): Promise<GenerateImageResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/agent/generate-image",
    accessToken,
    requestSchema: generateImageRequestSchema,
    body: { prompt, ...options },
    responseSchema: generateImageResponseSchema,
  });
}

export function generateVideoDirect(
  accessToken: string,
  prompt: string,
  options?: {
    model?: string;
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    inputImages?: string[];
  },
): Promise<GenerateVideoResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/agent/generate-video",
    accessToken,
    requestSchema: generateVideoRequestSchema,
    body: { prompt, ...options },
    responseSchema: generateVideoResponseSchema,
    timeoutMs: 330_000,
  });
}

export function fetchJob(
  accessToken: string,
  jobId: string,
): Promise<JobResponse> {
  return apiFetch({
    method: "GET",
    path: `/api/jobs/${jobId}`,
    accessToken,
    responseSchema: jobResponseSchema,
  });
}

export function fetchSkills(accessToken: string): Promise<SkillListResponse> {
  return apiFetch({
    method: "GET",
    path: "/api/skills",
    accessToken,
    responseSchema: skillListResponseSchema,
  });
}

export function fetchSkillDetail(
  accessToken: string,
  id: string,
): Promise<SkillDetailResponse> {
  return apiFetch({
    method: "GET",
    path: `/api/skills/${id}`,
    accessToken,
    responseSchema: skillDetailResponseSchema,
  });
}

export function createSkill(
  accessToken: string,
  data: SkillCreateRequest,
): Promise<SkillDetailResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/skills",
    accessToken,
    requestSchema: skillCreateRequestSchema,
    body: data,
    responseSchema: skillDetailResponseSchema,
  });
}

export function updateSkill(
  accessToken: string,
  id: string,
  data: SkillUpdateRequest,
): Promise<SkillDetailResponse> {
  return apiFetch({
    method: "PUT",
    path: `/api/skills/${id}`,
    accessToken,
    requestSchema: skillUpdateRequestSchema,
    body: data,
    responseSchema: skillDetailResponseSchema,
  });
}

export function deleteSkill(accessToken: string, id: string): Promise<void> {
  return apiFetch({
    method: "DELETE",
    path: `/api/skills/${id}`,
    accessToken,
    responseMode: "empty",
  });
}

export function fetchSkillFiles(
  accessToken: string,
  skillId: string,
): Promise<SkillFilesResponse> {
  return apiFetch({
    method: "GET",
    path: `/api/skills/${skillId}/files`,
    accessToken,
    responseSchema: skillFilesResponseSchema,
  });
}

export function fetchWorkspaceSkills(
  accessToken: string,
): Promise<WorkspaceSkillListResponse> {
  return apiFetch({
    method: "GET",
    path: "/api/workspaces/skills",
    accessToken,
    responseSchema: workspaceSkillListResponseSchema,
  });
}

export function installSkill(
  accessToken: string,
  skillId: string,
): Promise<void> {
  return apiFetch({
    method: "POST",
    path: "/api/workspaces/skills",
    accessToken,
    requestSchema: workspaceSkillInstallRequestSchema,
    body: { skillId },
    responseMode: "empty",
  });
}

export function uninstallSkill(
  accessToken: string,
  skillId: string,
): Promise<void> {
  return apiFetch({
    method: "DELETE",
    path: `/api/workspaces/skills/${skillId}`,
    accessToken,
    responseMode: "empty",
  });
}

export function toggleSkill(
  accessToken: string,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  return apiFetch({
    method: "PATCH",
    path: `/api/workspaces/skills/${skillId}`,
    accessToken,
    requestSchema: workspaceSkillToggleRequestSchema,
    body: { enabled },
    responseMode: "empty",
  });
}

export function searchMarketplace(
  accessToken: string,
  query: string,
  page = 1,
  limit = 20,
): Promise<MarketplaceSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    limit: String(limit),
  });
  return apiFetch({
    method: "GET",
    path: `/api/skills/marketplace/search?${params}`,
    accessToken,
    responseSchema: marketplaceSearchResponseSchema,
  });
}

export function getMarketplaceDetail(
  accessToken: string,
  packageName: string,
): Promise<MarketplaceDetail> {
  const params = new URLSearchParams({ name: packageName });
  return apiFetch({
    method: "GET",
    path: `/api/skills/marketplace/detail?${params}`,
    accessToken,
    responseSchema: marketplaceDetailSchema,
  });
}

export function installMarketplaceSkill(
  accessToken: string,
  packageName: string,
): Promise<SkillDetailResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/skills/marketplace/install",
    accessToken,
    requestSchema: marketplaceInstallRequestSchema,
    body: { packageName },
    responseSchema: skillDetailResponseSchema,
  });
}

export function importSkillFromUrl(
  accessToken: string,
  url: string,
): Promise<SkillDetailResponse> {
  return apiFetch({
    method: "POST",
    path: "/api/skills/import",
    accessToken,
    requestSchema: skillImportRequestSchema,
    body: { url },
    responseSchema: skillDetailResponseSchema,
  });
}
