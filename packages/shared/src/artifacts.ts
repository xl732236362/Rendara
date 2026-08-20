import { z } from "zod";

export const placementSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const safeArtifactUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("/api/assets/"),
    { message: "Artifact URL must use HTTPS or an authenticated asset route." },
  );

const assetIdSchema = z.string().uuid();
const assetRoutePattern = /^\/api\/assets\/([^/]+)$/;
// Bounds validation work before invalid transition artifacts are discarded.
const maxRawToolArtifactEntries = 1_000;

const externalArtifactUrlSchema = safeArtifactUrlSchema.refine(
  (value) => value.startsWith("https://"),
  { message: "External image source URLs must use HTTPS." },
);

export const imageArtifactSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("asset"),
      assetId: assetIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      url: externalArtifactUrlSchema,
    })
    .strict(),
]);

const imageArtifactTransportSchema = z
  .object({
    type: z.literal("image"),
    title: z.string().optional(),
    source: imageArtifactSourceSchema,
    url: safeArtifactUrlSchema,
    mimeType: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    placement: placementSchema.optional(),
    jobId: z.string().optional(),
  })
  .superRefine((artifact, context) => {
    const expectedUrl =
      artifact.source.kind === "asset"
        ? assetRoute(artifact.source.assetId)
        : artifact.source.url;

    if (artifact.url !== expectedUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "Image artifact URL conflicts with its source.",
      });
    }
  });

export const imageArtifactSchema = z.preprocess(
  normalizeImageArtifact,
  imageArtifactTransportSchema,
);

export const videoArtifactSchema = z.object({
  type: z.literal("video"),
  title: z.string().optional(),
  url: safeArtifactUrlSchema,
  mimeType: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().optional(),
  placement: placementSchema.optional(),
  jobId: z.string().optional(),
});

export const toolArtifactSchema = z.union([
  imageArtifactSchema,
  videoArtifactSchema,
]);

export const toolArtifactsSchema = normalizedToolArtifactsSchema();

export function boundedToolArtifactsSchema(max: number) {
  return normalizedToolArtifactsSchema(max);
}

export const generatedAssetRecoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attach_generated_asset"),
      jobId: z.string().uuid(),
      canvasId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("watch_generated_asset"),
      jobId: z.string().uuid(),
      canvasId: z.string().uuid(),
    })
    .strict(),
]);

export const generatedAssetErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
  })
  .strict();

const attachmentIdentityShape = {
  jobId: z.string().uuid(),
};

export const generatedAssetAttachmentStatusSchema = z.discriminatedUnion(
  "attachmentStatus",
  [
    z
      .object({
        attachmentStatus: z.literal("attached"),
        ...attachmentIdentityShape,
        elementId: z.string().min(1).max(256),
        canvasRevision: z.number().int().positive().safe(),
      })
      .strict(),
    z
      .object({
        attachmentStatus: z.literal("not_requested"),
        ...attachmentIdentityShape,
      })
      .strict(),
    z
      .object({
        attachmentStatus: z.literal("pending"),
        ...attachmentIdentityShape,
        recovery: generatedAssetRecoverySchema,
        error: generatedAssetErrorSchema,
      })
      .strict(),
    z
      .object({
        attachmentStatus: z.literal("not_attached"),
        ...attachmentIdentityShape,
        recovery: generatedAssetRecoverySchema,
        error: generatedAssetErrorSchema,
      })
      .strict(),
  ],
);

export type Placement = z.infer<typeof placementSchema>;
export type ImageArtifactSource = z.infer<typeof imageArtifactSourceSchema>;
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export type ToolArtifact = z.infer<typeof toolArtifactSchema>;
export type GeneratedAssetRecovery = z.infer<
  typeof generatedAssetRecoverySchema
>;
export type GeneratedAssetError = z.infer<typeof generatedAssetErrorSchema>;
export type GeneratedAssetAttachmentStatus = z.infer<
  typeof generatedAssetAttachmentStatusSchema
>;

function normalizeImageArtifact(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const source = imageArtifactSourceSchema.safeParse(value.source);
  const assetId = assetIdSchema.safeParse(value.assetId);
  const url = typeof value.url === "string" ? value.url : undefined;

  if (value.source !== undefined) {
    if (!source.success) return value;

    if (
      value.assetId !== undefined &&
      (!assetId.success ||
        source.data.kind !== "asset" ||
        source.data.assetId !== assetId.data)
    ) {
      return { ...value, source: undefined };
    }

    return {
      ...value,
      source: source.data,
      url:
        url ??
        (source.data.kind === "asset"
          ? assetRoute(source.data.assetId)
          : source.data.url),
    };
  }

  if (value.assetId !== undefined) {
    if (!assetId.success) return value;

    return {
      ...value,
      source: { kind: "asset", assetId: assetId.data },
      url: url ?? assetRoute(assetId.data),
    };
  }

  const legacySource = legacyImageSource(url);
  if (!legacySource || !url) return value;

  return {
    ...value,
    source: legacySource,
    url,
  };
}

function legacyImageSource(
  url: string | undefined,
): ImageArtifactSource | undefined {
  if (!url) return undefined;

  const assetRouteMatch = assetRoutePattern.exec(url);
  const assetId = assetRouteMatch?.[1];
  const parsedAssetId = assetIdSchema.safeParse(assetId);
  if (parsedAssetId.success) {
    return { kind: "asset", assetId: parsedAssetId.data };
  }

  if (url.startsWith("https://")) {
    return { kind: "external", url };
  }

  return undefined;
}

function assetRoute(assetId: string): string {
  return `/api/assets/${assetId}`;
}

function normalizedToolArtifactsSchema(max?: number) {
  const decodedArtifacts = z
    .array(z.unknown())
    .max(maxRawToolArtifactEntries)
    .transform((values, context) => {
      const decoded: ToolArtifact[] = [];

      for (const [index, value] of values.entries()) {
        const parsed = toolArtifactSchema.safeParse(value);
        if (parsed.success) {
          decoded.push(parsed.data);
          continue;
        }

        if (isImageArtifact(value)) continue;

        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Tool artifact is invalid.",
        });
      }

      return decoded;
    });

  return decodedArtifacts.superRefine((artifacts, context) => {
    if (max !== undefined && artifacts.length > max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many valid tool artifacts: maximum is ${max}.`,
      });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageArtifact(value: unknown): boolean {
  return isRecord(value) && value.type === "image";
}
