import { tool } from "langchain";
import { z } from "zod";

const DEFAULT_MAX_MATCHES = 5;

const projectSearchSchema = z
  .object({
    query: z.string().min(1),
    glob: z.string().min(1).optional(),
    maxMatches: z.number().int().min(1).max(20).optional(),
  })
  .strict();

type ProjectSearchInput = z.infer<typeof projectSearchSchema>;

type ProjectSearchResult = {
  matchCount: number;
  matches: Array<{
    line: number;
    path: string;
    text: string;
  }>;
  summary: string;
};

export interface ProjectSearchPort {
  search(input: {
    query: string;
    glob?: string;
  }): Promise<readonly { line: number; path: string; text: string }[]>;
}

export async function runProjectSearch(
  searchPort: ProjectSearchPort,
  input: ProjectSearchInput,
): Promise<ProjectSearchResult> {
  const rawMatches = await searchPort.search({
    query: input.query,
    ...(input.glob ? { glob: input.glob } : {}),
  });

  const sortedMatches = [...rawMatches].sort((left, right) => {
    if (left.path === right.path) {
      return left.line - right.line;
    }

    return left.path.localeCompare(right.path);
  });
  const matchCount = sortedMatches.length;
  const limitedMatches = sortedMatches.slice(
    0,
    input.maxMatches ?? DEFAULT_MAX_MATCHES,
  );
  const fileCount = new Set(sortedMatches.map((match) => match.path)).size;

  return {
    matchCount,
    matches: limitedMatches.map((match) => ({
      line: match.line,
      path: match.path,
      text: match.text,
    })),
    summary:
      matchCount === 0
        ? `No workspace matches found for "${input.query}".`
        : `Found ${matchCount} workspace match(es) for "${input.query}" across ${fileCount} file(s).`,
  };
}

export function createProjectSearchTool(searchPort: ProjectSearchPort) {
  return tool(async (input) => await runProjectSearch(searchPort, input), {
    name: "project_search",
    description:
      "Search the Loomic workspace for matching project text without using shell execution.",
    schema: projectSearchSchema,
  });
}
