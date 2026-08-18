import { z } from "zod";

export const canvasNodeTypeSchema = z.enum([
  "text",
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "image",
  "video",
  "frame",
]);
export type CanvasNodeType = z.infer<typeof canvasNodeTypeSchema>;

export const canvasNodeSchema = z
  .object({
    id: z.string().min(1),
    type: canvasNodeTypeSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    version: z.number().int().positive(),
    isDeleted: z.boolean().default(false),
  })
  .passthrough();
export type CanvasNode = z.infer<typeof canvasNodeSchema>;

export type CanvasNodeDefinition = {
  type: CanvasNodeType;
  version: number;
  validate: (node: unknown) => CanvasNode;
};

export class CanvasNodeRegistry {
  #definitions = new Map<CanvasNodeType, CanvasNodeDefinition>();
  #sealed = false;

  register(definition: CanvasNodeDefinition): this {
    if (this.#sealed) throw new Error("Canvas node registry is sealed");
    if (this.#definitions.has(definition.type)) {
      throw new Error(`Canvas node type already registered: ${definition.type}`);
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error(`Invalid canvas node version: ${definition.type}`);
    }
    this.#definitions.set(definition.type, definition);
    return this;
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }

  get(type: string): CanvasNodeDefinition {
    const definition = this.#definitions.get(type as CanvasNodeType);
    if (!definition) throw new Error(`Unknown canvas node type: ${type}`);
    return definition;
  }

  validate(node: unknown): CanvasNode {
    const parsed = canvasNodeSchema.parse(node);
    return this.get(parsed.type).validate(parsed);
  }

  list(): readonly CanvasNodeDefinition[] {
    return [...this.#definitions.values()].sort((a, b) => a.type.localeCompare(b.type));
  }
}

const standard = (type: CanvasNodeType): CanvasNodeDefinition => ({
  type,
  version: 1,
  validate: (node) => canvasNodeSchema.extend({ type: z.literal(type) }).parse(node),
});

export const defaultCanvasNodeRegistry = new CanvasNodeRegistry();
for (const type of canvasNodeTypeSchema.options) defaultCanvasNodeRegistry.register(standard(type));
defaultCanvasNodeRegistry.seal();

export const canvasPatchSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("add"), node: z.unknown() }),
    z.object({ op: z.literal("replace"), nodeId: z.string().min(1), node: z.unknown() }),
    z.object({ op: z.literal("remove"), nodeId: z.string().min(1) }),
  ])).min(1).max(100),
});
export type CanvasPatch = z.infer<typeof canvasPatchSchema>;

export function applyCanvasPatch(
  nodes: readonly CanvasNode[],
  patchInput: unknown,
  registry = defaultCanvasNodeRegistry,
): { nodes: CanvasNode[]; revision: number } {
  const patch = canvasPatchSchema.parse(patchInput);
  const next = nodes.map((node) => registry.validate(node));
  for (const operation of patch.operations) {
    if (operation.op === "add") {
      const node = registry.validate(operation.node);
      if (next.some((item) => item.id === node.id)) throw new Error(`Canvas node already exists: ${node.id}`);
      next.push(node);
    } else {
      const index = next.findIndex((node) => node.id === operation.nodeId);
      if (index < 0) throw new Error(`Canvas node not found: ${operation.nodeId}`);
      if (operation.op === "remove") next.splice(index, 1);
      else {
        if (typeof operation.node !== "object" || operation.node === null || Array.isArray(operation.node)) {
          throw new Error(`Canvas node replacement must be an object: ${operation.nodeId}`);
        }
        next[index] = registry.validate({ ...operation.node, id: operation.nodeId });
      }
    }
  }
  return { nodes: next, revision: patch.baseRevision + 1 };
}

export const assetManifestEntrySchema = z.object({
  assetId: z.string().min(1),
  mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objectPath: z.string().min(1).refine((value) => !value.includes("..") && !value.startsWith("/")),
});
export const assetManifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(assetManifestEntrySchema).max(10_000),
}).superRefine((manifest, context) => {
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (ids.has(asset.assetId)) context.addIssue({ code: "custom", message: `Duplicate asset: ${asset.assetId}` });
    ids.add(asset.assetId);
  }
});
export type AssetManifest = z.infer<typeof assetManifestSchema>;
