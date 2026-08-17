import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../supabase/user.js";

export class ResourceAuthorizationError extends Error {
  readonly code = "forbidden";
  readonly statusCode = 403;

  constructor() {
    super("You do not have access to this resource.");
  }
}

export type ResourceAuthorization = {
  requireCanvasAccess(user: AuthenticatedUser, canvasId: string): Promise<void>;
  requireSessionAccess(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<{ canvasId: string }>;
  requireRunAccess(
    user: AuthenticatedUser,
    runId: string,
  ): Promise<{ canvasId: string }>;
};

export async function requireRunResourceAccess(
  authorization: ResourceAuthorization,
  user: AuthenticatedUser,
  resource: {
    sessionId: string;
    conversationId: string;
    canvasId?: string | undefined;
  },
): Promise<string> {
  const { canvasId } = await authorization.requireSessionAccess(
    user,
    resource.sessionId,
  );
  const requestedCanvasId = resource.canvasId ?? resource.conversationId;

  if (requestedCanvasId !== canvasId) {
    throw new ResourceAuthorizationError();
  }

  return canvasId;
}

export function createResourceAuthorization(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  findRunSessionId: (runId: string) => Promise<string | null>;
}): ResourceAuthorization {
  const forbidden = () => new ResourceAuthorizationError();

  return {
    async requireCanvasAccess(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("canvases")
        .select("id")
        .eq("id", canvasId)
        .single();

      if (error || !data) {
        throw forbidden();
      }
    },

    async requireSessionAccess(user, sessionId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("chat_sessions")
        .select("id, canvas_id")
        .eq("id", sessionId)
        .single();

      if (error || !data) {
        throw forbidden();
      }

      return { canvasId: data.canvas_id };
    },

    async requireRunAccess(user, runId) {
      const sessionId = await options.findRunSessionId(runId);
      if (!sessionId) {
        throw forbidden();
      }

      return this.requireSessionAccess(user, sessionId);
    },
  };
}
