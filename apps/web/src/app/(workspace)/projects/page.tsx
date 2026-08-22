"use client";

import type { ProjectSummary } from "@loomic/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { LoadingScreen } from "@/components/loading-screen";
import { ProjectList } from "@/components/project-list";
import { ProjectsSkeleton } from "@/components/skeletons/projects-skeleton";
import { Button } from "@/components/ui/button";
import { useCreateProject } from "@/hooks/use-create-project";
import { ApiAuthError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/query/keys";
import {
  useProjectsInfiniteQuery,
  useViewerQuery,
} from "@/lib/query/workspace-queries";

const PROJECTS_PAGE_SIZE = 20;

function uniqueProjects(pages: readonly { items: ProjectSummary[] }[]) {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.items.filter((project) => {
      if (seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    }),
  );
}

export default function ProjectsPage() {
  const { user, session, signOut } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [highlightId] = useState<string | null>(null);
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const getToken = useCallback(() => accessTokenRef.current ?? null, []);

  const viewer = useViewerQuery(user?.id, getToken);
  const workspaceId = viewer.data?.workspace.id;
  const projectsKey =
    workspaceId && user
      ? queryKeys.workspace.projects(user.id, workspaceId, {
          limit: PROJECTS_PAGE_SIZE,
        })
      : null;
  const projectsQuery = useProjectsInfiniteQuery({
    userId: user?.id ?? "disabled",
    workspaceId,
    getAccessToken: getToken,
    limit: PROJECTS_PAGE_SIZE,
  });

  const resetProjects = useCallback(() => {
    if (!projectsKey) return;
    void queryClient.resetQueries({ queryKey: projectsKey, exact: true });
  }, [projectsKey, queryClient]);
  const { create: createNewProject, creating } = useCreateProject({
    onCreated: resetProjects,
  });

  const error = viewer.error ?? projectsQuery.error;
  useEffect(() => {
    if (!(error instanceof ApiAuthError)) return;
    void Promise.resolve(signOut()).then(() => router.replace("/login"));
  }, [error, router, signOut]);

  if (creating) return <LoadingScreen />;
  if (error && !(error instanceof ApiAuthError)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="space-y-4 text-center">
          <p className="text-sm text-destructive">
            Failed to load data. Please try again.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void viewer.refetch();
              if (workspaceId) void projectsQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (viewer.isPending || projectsQuery.isPending) return <ProjectsSkeleton />;

  const projects = uniqueProjects(projectsQuery.data?.pages ?? []);
  return (
    <div className="px-4 py-6 sm:px-6 md:p-8">
      <ProjectList
        projects={projects}
        highlightId={highlightId}
        onCreateClick={() => createNewProject()}
        onDeleted={resetProjects}
      />
      {projectsQuery.hasNextPage && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            disabled={projectsQuery.isFetchingNextPage}
            onClick={() => void projectsQuery.fetchNextPage()}
          >
            {projectsQuery.isFetchingNextPage ? "Loading..." : "Load More"}
          </Button>
        </div>
      )}
    </div>
  );
}
