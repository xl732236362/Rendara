import type { SkillImportPorts } from "../../application/skills/import-skill.js";
import {
  type ImportedSkill,
  importSkillFromUrl,
} from "./skill-import-service.js";

type ExistingSkillImporter = (url: string) => Promise<ImportedSkill>;

/** Keeps safe-fetch and archive handling in the existing infrastructure service. */
export function createSkillImportApplicationPort(
  importer: ExistingSkillImporter = importSkillFromUrl,
): SkillImportPorts["importer"] {
  return { importFromUrl: (url) => importer(url) };
}
