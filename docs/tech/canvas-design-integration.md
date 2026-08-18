# Canvas Design Skill - Retired Integration

## Status

This integration is retired and must not be enabled in development, test, or production.

The current `canvas-design` Skill depends on Agent-reachable Python execution, Pillow, reportlab, host fonts, and sandbox-file persistence. Loomic's approved Phase 3 boundary permanently removes `execute`, Shell/process backends, generic filesystem access, and Sandbox infrastructure. The package is therefore excluded from `skills/builtin-skills.manifest.json` and cannot be discovered or loaded by an Agent.

Do not restore `LOOMIC_SANDBOX_ROOT`, `LOOMIC_SKILLS_ROOT`, `LOOMIC_AGENT_BACKEND_MODE`, `LocalShellBackend`, `persist_sandbox_file`, automatic Skill directory discovery, or Python dependencies for this integration.

`canvas-design` may return only as a redesigned internal Skill whose complete workflow uses fixed Loomic tools from the closed capability map. Every canvas or node read and mutation must be an authorized tool call bound to the run's persisted `canvasId`; the Agent must not access canvas services, repositories, Supabase, Excalidraw/browser internals, host files, processes, or the network directly.

The authoritative decision and completion criteria are in `docs/superpowers/specs/2026-08-18-builtin-skills-and-canvas-scoped-agent-design.md`.
