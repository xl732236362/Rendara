"use client";

import type { ModelInfo } from "@loomic/shared";
import { useEffect, useState } from "react";

import { Button } from "./ui/button";
import { Label } from "./ui/label";

interface AgentSectionProps {
  defaultModel: string;
  onSave: (defaultModel: string) => Promise<void>;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsError: boolean;
  onRetryModels: () => void;
}

export function AgentSection({
  defaultModel: initialModel,
  onSave,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
}: AgentSectionProps) {
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const hasChanges = selectedModel !== initialModel;

  useEffect(() => {
    const ids = models.map((m) => m.id);
    const firstModel = models[0];
    setSelectedModel((current) =>
      firstModel && !ids.includes(current) ? firstModel.id : current,
    );
  }, [models]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedModel) return;

    setSaving(true);
    setFeedback(null);

    try {
      await onSave(selectedModel);
      setFeedback({ type: "success", message: "Agent settings updated." });
    } catch {
      setFeedback({
        type: "error",
        message: "Failed to update settings. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Agent</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure the default AI model for your workspace.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
        <div className="space-y-2">
          <Label htmlFor="defaultModel">Default Model</Label>
          {modelsLoading ? (
            <p className="text-sm text-muted-foreground">Loading models...</p>
          ) : modelsError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">Failed to load models.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryModels}
              >
                Retry
              </Button>
            </div>
          ) : (
            <select
              id="defaultModel"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.provider})
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-muted-foreground">
            This model will be used for all new agent runs in your workspace.
          </p>
        </div>

        {feedback && (
          <p
            className={`text-sm ${feedback.type === "success" ? "text-success" : "text-destructive"}`}
          >
            {feedback.message}
          </p>
        )}

        <Button type="submit" disabled={saving || !hasChanges} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}
