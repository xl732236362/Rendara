import type { ApplyCanvasOperations } from "./canvas/apply-canvas-operations.js";
import type { AttachGeneratedAsset } from "./canvas/attach-generated-asset.js";
import type { CancelGeneration } from "./generation/cancel-generation.js";
import type { SubmitGeneration } from "./generation/submit-generation.js";
import type { ImportSkill } from "./skills/import-skill.js";

/** Transport-neutral application API, created once by the composition root. */
export interface UseCases {
  readonly applyCanvasOperations: ApplyCanvasOperations;
  readonly attachGeneratedAsset: AttachGeneratedAsset;
  readonly cancelGeneration: CancelGeneration;
  readonly importSkill: ImportSkill;
  readonly submitGeneration: SubmitGeneration;
}
