# Phase 4 Canvas Domain Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (inline execution used for this task).

**Goal:** Establish a versioned canvas node registry, atomic patch contract, and validated asset manifest so new node types are added through one explicit registration point.

**Architecture:** `@loomic/shared` owns transport-neutral schemas and pure patch application. The server continues persisting revisions through the phase 2 CAS RPC; this phase does not introduce a second persistence path. Excalidraw-compatible nodes are validated at the domain boundary and asset references are represented by a bounded manifest.

**Tech Stack:** TypeScript, Zod 4, Vitest, Supabase phase 2 revision CAS.

---

### Task 1: Add the shared domain registry, patch, and manifest

- [x] Add `packages/shared/src/canvas-domain.ts` and export it from the shared barrel.
- [x] Add focused tests for sealed registration, atomic patches, duplicate IDs, unknown node types, and asset path/hash validation.

### Task 2: Integrate and verify

- [x] Validate existing canvas operation output through the registry at the application boundary.
- [x] Run shared/server tests, typechecks, build, database reset/tests, and diff checks.
- [x] Record evidence in `docs/tech/phase-4-verification.md` and update the engineering issue register.
- [ ] Push the completed phase to `origin/main`.
