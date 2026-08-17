# Canvas Generation Overlay Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind generation overlays and panels to live Excalidraw geometry, including rotation, and make completed images inherit the latest placeholder geometry.

**Architecture:** Add pure scene-to-screen geometry helpers as the single conversion boundary. Store scene geometry and canvas transform independently, derive DOM presentation during render, and look up the live placeholder again when generation completes.

**Tech Stack:** TypeScript, React 19, Excalidraw, Vitest, Testing Library, Next.js 15.

---

### Task 1: Shared Canvas Overlay Geometry

**Files:**
- Create: `apps/web/src/lib/canvas-overlay-geometry.ts`
- Create: `apps/web/test/canvas-overlay-geometry.test.ts`

- [ ] **Step 1: Write failing pure geometry tests**

Test `sceneRectToScreen()` with scroll, zoom, viewport offsets, and radians. Test `rotatedScreenBounds()` with a 90-degree rotation, asserting the width and height swap around the same center and the panel anchor is below the rotated axis-aligned box.

- [ ] **Step 2: Run the focused test and verify red**

Run: `pnpm --filter @loomic/web exec vitest run test/canvas-overlay-geometry.test.ts`

Expected: FAIL because `canvas-overlay-geometry.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure geometry API**

Define `SceneRect`, `CanvasTransform`, and `ScreenRect`. Implement:

```ts
export function sceneRectToScreen(rect: SceneRect, transform: CanvasTransform): ScreenRect
export function rotatedScreenBounds(rect: ScreenRect, angle: number): ScreenRect
export function panelAnchor(rect: SceneRect, transform: CanvasTransform): { left: number; top: number }
```

Use `Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))` and the corresponding rotated height formula. Excalidraw angles remain radians.

- [ ] **Step 4: Run the focused test and verify green**

Run the Task 1 command and expect all geometry tests to pass.

### Task 2: Live Overlay And Panel Binding

**Files:**
- Modify: `apps/web/src/components/canvas-tool-menu.tsx`
- Modify: `apps/web/src/components/canvas/image-generator-panel.tsx`
- Modify: `apps/web/test/canvas-generation-ui.test.tsx`

- [ ] **Step 1: Add failing component regressions**

Extend the existing subscriber test to emit consecutive changes for movement,
resize, angle, scroll, zoom, and offsets. Assert the same overlay updates
`left`, `top`, `width`, `height`, `transformOrigin: center`, and
`transform: rotate(<angle>rad)`. Add a panel assertion that it remains
unrotated and anchors below the rotated axis-aligned bounds.

- [ ] **Step 2: Run the component test and verify red**

Run: `pnpm --filter @loomic/web exec vitest run test/canvas-generation-ui.test.tsx`

Expected: FAIL because the overlay caches screen coordinates, ignores transform-only changes, and does not apply angle.

- [ ] **Step 3: Store scene geometry and derive presentation**

Change generating element state to `{ id, x, y, width, height, angle, model }`.
Include angle in equality keys. Pass current `canvasScrollZoom` to each overlay
and call `sceneRectToScreen()` while rendering. Apply `rotate(${angle}rad)` with
a centered transform origin.

Add `angle` to selected generator bounds. Replace panel-local screen math with
`panelAnchor()` so the panel remains horizontal below the rotated bounding box.

- [ ] **Step 4: Run the component test and verify green**

Run the Task 2 command and expect all generation UI tests to pass.

### Task 3: Preserve Live Geometry On Completion

**Files:**
- Modify: `apps/web/src/lib/canvas-elements.ts`
- Modify: `apps/web/src/components/canvas/image-generator-panel.tsx`
- Modify: `apps/web/test/canvas-elements.test.ts`
- Modify: `apps/web/test/canvas-generation-ui.test.tsx`

- [ ] **Step 1: Add failing image angle and completion-sequence tests**

Assert `createExcalidrawImageElement({ angle: Math.PI / 2, ... })` returns that
angle. In the deferred generation test, mutate the live placeholder geometry
and angle before resolving; assert the image uses the latest values. Add a
second test that marks the placeholder deleted before resolution and asserts no
image element is inserted.

- [ ] **Step 2: Run focused tests and verify red**

Run: `pnpm --filter @loomic/web exec vitest run test/canvas-elements.test.ts test/canvas-generation-ui.test.tsx`

Expected: FAIL because image creation fixes angle at zero and completion uses
captured panel bounds.

- [ ] **Step 3: Implement live replacement**

Add optional `angle?: number` to `createExcalidrawImageElement()` and default it
to zero. After downloading the generated asset, locate the non-deleted
placeholder by `elementId`. If absent, log an informational lifecycle message,
close the panel, and return without adding an Excalidraw file or image. If
present, use its current `x`, `y`, `width`, `height`, and `angle` for the image.

- [ ] **Step 4: Run focused tests and verify green**

Run the Task 3 command and expect all focused tests to pass.

### Task 4: Full Verification

**Files:**
- Verify only; no production edits expected.

- [ ] **Step 1: Run the full Web test suite**

Run: `pnpm --filter @loomic/web test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run TypeScript validation**

Run: `pnpm --filter @loomic/web typecheck`

Expected: no TypeScript errors.

- [ ] **Step 3: Run an isolated production build**

PowerShell command:

```powershell
$env:NEXT_DIST_DIR='.next-build'; pnpm --filter @loomic/web build; Remove-Item Env:NEXT_DIST_DIR
```

Expected: build succeeds without modifying the active `.next` development cache.

- [ ] **Step 4: Verify the running local app**

Reload `http://localhost:3000/home`, confirm it returns HTTP 200 or redirects an
unauthenticated session to `/login`, and confirm no new browser console errors.

- [ ] **Step 5: Check patch hygiene**

Run: `git diff --check`

Expected: no whitespace errors.
