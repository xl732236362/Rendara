import type { ApplyCanvasOperations } from "./canvas/apply-canvas-operations.js";
import type { AttachGeneratedAsset } from "./canvas/attach-generated-asset.js";
import type { CancelGeneration } from "./generation/cancel-generation.js";
import type { SubmitGeneration } from "./generation/submit-generation.js";
import type { ImportSkill } from "./skills/import-skill.js";

/** Transport-neutral application API, created once by the composition root. */
export interface UseCases {
  readonly canvas: Readonly<{
    applyOperations: ApplyCanvasOperations;
    attachGeneratedAsset: AttachGeneratedAsset;
  }>;
  readonly skills: Readonly<{ importSkill: ImportSkill }>;
  readonly generation?: Readonly<{
    cancel: CancelGeneration;
    submit: SubmitGeneration;
  }>;
}
