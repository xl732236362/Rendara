import { generateImage } from "../../../generation/image-generation.js";
import type { ProviderCatalog } from "../../../generation/providers/registry.js";
import { applyWatermark } from "../../credits/watermark.js";
// @credits-system — Image generation executor: applies watermark for free-tier users
import type { ExecutorContext, JobExecutor } from "../job-executor.js";

import type { SubscriptionPlan } from "@loomic/shared";

export function createImageGenerationExecutor(
  providerRegistry: ProviderCatalog,
): JobExecutor {
  return async (jobId, _rawPayload, ctx: ExecutorContext) => {
    const t0 = Date.now();

    // Read the full job row including payload from the database.
    // The PGMQ message only contains { job_id, job_type, workspace_id },
    // so we must fetch prompt/model/aspect_ratio from background_jobs.payload.
    const admin = ctx.getAdminClient();
    const { data: jobRow } = await admin
      .from("background_jobs")
      .select(
        "created_by, workspace_id, project_id, canvas_id, session_id, payload",
      )
      .eq("id", jobId)
      .single();

    if (!jobRow) throw new Error(`Job ${jobId} not found in database`);

    // Build log tag with traceability context: jobId + sessionId (if available)
    const sessionShort =
      (jobRow.session_id as string)?.slice(0, 8) ?? "no-session";
    const tag = `[image-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
    const lap = (label: string) =>
      console.log(`${tag} ${label} +${Date.now() - t0}ms`);
    lap("db_fetch");

    const payload = (jobRow.payload ?? {}) as {
      prompt: string;
      model?: string;
      aspect_ratio?: string;
      title?: string;
      input_asset_ids?: string[];
      input_images?: string[];
      quality?: "standard" | "hd" | "ultra";
    };

    if (!payload.prompt)
      throw new Error(`Job ${jobId} has no prompt in payload`);

    const createdBy: string | null = jobRow.created_by ?? null;
    const workspaceId: string = jobRow.workspace_id ?? jobId;
    const projectId: string | null = jobRow.project_id ?? null;

    // Resolve provider dynamically from model ID via registry
    const model = payload.model ?? "black-forest-labs/flux-kontext-pro";
    const providerName = providerRegistry.resolveImageProviderName(model);

    // Renew VT every 60s (half of the 120s image queue VT) to prevent
    // the message from becoming visible while we are still processing.
    const IMAGE_VT_SECONDS = 120;
    const heartbeatTimer = setInterval(() => {
      ctx.renewVt(IMAGE_VT_SECONDS);
    }, 60_000);

    // Log input image format for debugging the data-URI-passthrough pipeline
    if (payload.input_images?.length) {
      const formats = payload.input_images.map((img) =>
        img.startsWith("data:") ? "data-uri" : "url",
      );
      console.log(
        `${tag} input_images formats: [${formats.join(", ")}] (${formats.length} total)`,
      );
    }

    try {
      let inputImages = payload.input_images ?? [];
      if (payload.input_asset_ids?.length) {
        const { data: referenceRows, error: referenceError } = await admin
          .from("asset_objects")
          .select(
            "id, workspace_id, project_id, bucket, object_path, mime_type",
          )
          .in("id", payload.input_asset_ids);
        if (referenceError) {
          throw new Error(
            `Reference asset lookup failed: ${referenceError.message}`,
          );
        }

        type ReferenceAssetRow = {
          id: string;
          workspace_id: string;
          project_id: string | null;
          bucket: string;
          object_path: string;
          mime_type: string;
        };
        const rows = (referenceRows ?? []) as ReferenceAssetRow[];
        const rowsById = new Map(rows.map((row) => [row.id, row]));
        const orderedRows = payload.input_asset_ids.map((id) => rowsById.get(id));
        if (
          rows.length !== payload.input_asset_ids.length ||
          orderedRows.some(
            (row) =>
              !row ||
              row.workspace_id !== workspaceId ||
              row.project_id !== projectId ||
              !row.mime_type.startsWith("image/"),
          )
        ) {
          throw new Error("Reference assets no longer match the generation job");
        }

        inputImages = await Promise.all(
          orderedRows.map(async (row) => {
            const { data, error } = await admin.storage
              .from(row!.bucket)
              .createSignedUrl(row!.object_path, 3600);
            if (error || !data?.signedUrl) {
              throw new Error(
                `Reference asset URL creation failed: ${error?.message ?? "missing signed URL"}`,
              );
            }
            return data.signedUrl;
          }),
        );
        console.log(`${tag} resolved ${inputImages.length} reference assets`);
      }

      // Generate image via the registered provider
      lap(`${providerName}_call_start`);
      let generated;
      try {
        generated = await generateImage(providerRegistry, providerName, {
          prompt: payload.prompt,
          model,
          ...(payload.quality ? { quality: payload.quality } : {}),
          ...(payload.aspect_ratio !== undefined
            ? { aspectRatio: payload.aspect_ratio }
            : {}),
          ...(inputImages.length ? { inputImages } : {}),
        });
      } catch (genError) {
        const detail =
          genError instanceof Error ? genError.message : String(genError);
        const wrapped = new Error(
          `Image generation failed for model ${model}: ${detail}`,
        );
        (wrapped as Error & { code?: string }).code =
          (genError as { code?: string })?.code ?? "executor_error";
        throw wrapped;
      }
      lap(`${providerName}_call_done`);

      // Download the generated image from the provider CDN
      const response = await fetch(generated.url);
      if (!response.ok) {
        throw new Error(
          `Failed to download generated image from ${model}: ${response.status} ${response.statusText}`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      let buffer: Buffer = Buffer.from(arrayBuffer);
      lap("image_download_done");

      // Apply watermark for free-plan users
      if (workspaceId) {
        try {
          const { data: sub } = await admin
            .from("subscriptions")
            .select("plan")
            .eq("workspace_id", workspaceId)
            .maybeSingle();

          const plan: SubscriptionPlan =
            (sub?.plan as SubscriptionPlan) ?? "free";
          if (plan === "free") {
            buffer = await applyWatermark(
              buffer,
              generated.mimeType ?? "image/png",
            );
            lap("watermark_applied");
          }
        } catch (wmErr) {
          // Non-fatal: log and continue without watermark rather than failing the job
          console.warn(`${tag} Watermark failed, continuing without:`, wmErr);
        }
      }

      // Upload to Supabase Storage under the project-assets bucket
      const objectPath = `${workspaceId}/generated/${jobId}.png`;

      const { error: uploadError } = await admin.storage
        .from("project-assets")
        .upload(objectPath, buffer, {
          contentType: generated.mimeType ?? "image/png",
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Storage upload failed: ${uploadError.message}`);
      }
      lap("storage_upload_done");

      // Insert asset_objects record — only include created_by if we have a valid user UUID
      const { data: assetRow, error: assetError } = await admin
        .from("asset_objects")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          bucket: "project-assets",
          object_path: objectPath,
          mime_type: generated.mimeType ?? "image/png",
          byte_size: buffer.length,
          generation_job_id: jobId,
          ...(createdBy ? { created_by: createdBy } : {}),
        })
        .select("id")
        .single();

      if (assetError || !assetRow) {
        throw new Error(
          `Failed to create asset record: ${assetError?.message ?? "unknown error"}`,
        );
      }

      lap("asset_record_done");

      // Generate a public URL for the result consumer
      const { data: urlData } = admin.storage
        .from("project-assets")
        .getPublicUrl(objectPath);

      lap("total");
      return {
        asset_id: (assetRow as { id: string }).id,
        signed_url: urlData.publicUrl,
        object_path: objectPath,
        width: generated.width,
        height: generated.height,
        mime_type: generated.mimeType ?? "image/png",
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  };
}
