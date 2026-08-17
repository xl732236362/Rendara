# Canvas Generation Overlay Binding Design

## Goal

Keep every transient generation overlay visually bound to its Excalidraw
placeholder during node movement, node resize, node rotation, canvas pan,
canvas zoom, and editor viewport offset changes.

The completed image remains a native Excalidraw image element. This change does
not alter generation APIs or canvas persistence. Image replacement is updated
to use the placeholder's live geometry at completion time.

## Ownership Boundary

Excalidraw is the only source of truth for persistent node geometry and task
state:

- Element `x`, `y`, `width`, `height`, and `angle` define scene geometry.
- Excalidraw app state defines scroll, zoom, and editor viewport offsets.
- Element `customData.status` determines whether a transient overlay exists.

The DOM overlay is presentation-only. It must not maintain an independently
mutable screen position, participate in selection, enter undo history, or be
stored with the canvas.

## Data Flow

`CanvasToolMenu` subscribes to Excalidraw changes and stores two independent
inputs:

1. Generating element scene bounds and angle, keyed by element ID.
2. Current canvas transform: scroll, zoom, and viewport offsets.

Screen bounds are derived during render through one shared pure conversion
function. They are never cached inside the generating-element state. A change
to either scene geometry or canvas transform therefore produces a new visual
position without requiring both values to change in the same callback.

The overlay uses the converted node center as its transform origin and applies
the Excalidraw element angle in radians through CSS `rotate(<angle>rad)`.
Rotation must not change its unrotated scene bounds, because Excalidraw also
rotates elements around their center.

The overlay and selected generator panel share pure scene-to-screen geometry
primitives, but consume different outputs:

- The overlay uses the unrotated screen rectangle, center transform origin, and
  angle.
- The panel remains unrotated and anchors below the rotated node's axis-aligned
  screen bounding box.

This keeps their coordinate math consistent without rotating the interactive
panel itself.

## Rendering And Performance

The overlay remains a fixed, pointer-transparent DOM layer above Excalidraw.
This preserves smooth shimmer animation without adding transient elements to
the Excalidraw scene or undo history.

State updates use equality checks on scene bounds and canvas transforms. If
high-frequency drag events prove expensive, updates may later be coalesced with
`requestAnimationFrame`; this is not required unless measurement demonstrates a
problem.

## Lifecycle And Failure Handling

- An overlay exists only while a live generator element has status
  `generating`.
- Moving, resizing, rotating, panning, or zooming cannot create or destroy task
  state.
- Completion looks up the placeholder by ID from
  `excalidrawApi.getSceneElements()` and replaces it with a native Excalidraw
  image using its live bounds and angle. It must not use geometry captured when
  generation started.
- If the placeholder was deleted while generation was running, the generated
  asset remains available in storage but is not inserted back onto the canvas.
- Replacing or deleting the placeholder removes the overlay naturally when the
  live generating element disappears.
- Failure changes the placeholder to a retryable error state and removes the
  overlay.
- Unmounting the editor removes all transient DOM overlays without changing the
  persisted canvas state.

## Verification

Focused component tests will call the Excalidraw change subscriber repeatedly
and verify that the same overlay follows:

- node movement;
- node resizing;
- node rotation;
- combined rotation and resizing;
- panel anchoring below the rotated node's axis-aligned bounding box;
- canvas panning;
- canvas zooming;
- viewport offset changes.

A completion-sequence test starts generation, moves, resizes, and rotates the
placeholder while the request is pending, then verifies that the completed
image inherits the latest geometry. A deletion-sequence test verifies that a
deleted placeholder is not recreated when its request completes.

Existing tests for panel unmount survival, orphan recovery, and final image
replacement remain required. Type checking and the full web test suite complete
the behavioral verification. Production builds run with an isolated
`NEXT_DIST_DIR` so they cannot replace the active development server's `.next`
cache.

## Non-Goals

- Rendering shimmer as native Excalidraw elements.
- Changing canvas storage schema.
- Changing image-generation provider behavior.
- Adding progress percentages or cancellation controls.
