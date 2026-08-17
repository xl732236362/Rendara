# Canvas Generation Overlay Binding Design

## Goal

Keep every transient generation overlay visually bound to its Excalidraw
placeholder during node movement, node resize, canvas pan, canvas zoom, and
editor viewport offset changes.

The completed image remains a native Excalidraw image element. This change does
not alter generation APIs, canvas persistence, or image replacement behavior.

## Ownership Boundary

Excalidraw is the only source of truth for persistent node geometry and task
state:

- Element `x`, `y`, `width`, and `height` define scene geometry.
- Excalidraw app state defines scroll, zoom, and editor viewport offsets.
- Element `customData.status` determines whether a transient overlay exists.

The DOM overlay is presentation-only. It must not maintain an independently
mutable screen position, participate in selection, enter undo history, or be
stored with the canvas.

## Data Flow

`CanvasToolMenu` subscribes to Excalidraw changes and stores two independent
inputs:

1. Generating element scene bounds, keyed by element ID.
2. Current canvas transform: scroll, zoom, and viewport offsets.

Screen bounds are derived during render through one shared pure conversion
function. They are never cached inside the generating-element state. A change
to either scene geometry or canvas transform therefore produces a new visual
position without requiring both values to change in the same callback.

The selected generator panel and generating overlay use the same conversion
function so their coordinate behavior cannot drift apart.

## Rendering And Performance

The overlay remains a fixed, pointer-transparent DOM layer above Excalidraw.
This preserves smooth shimmer animation without adding transient elements to
the Excalidraw scene or undo history.

State updates use equality checks on scene bounds and canvas transforms. If
high-frequency drag events prove expensive, updates may later be coalesced with
`requestAnimationFrame`; this is not required unless measurement demonstrates a
problem.

Rotation is outside the current generator-node behavior because generator
placeholders are not rotatable. If rotation is enabled later, the shared
conversion result must be extended with a transform origin and angle.

## Lifecycle And Failure Handling

- An overlay exists only while a live generator element has status
  `generating`.
- Moving, resizing, panning, or zooming cannot create or destroy task state.
- Completion replaces the placeholder with a native Excalidraw image and
  removes the overlay naturally when the placeholder disappears.
- Failure changes the placeholder to a retryable error state and removes the
  overlay.
- Unmounting the editor removes all transient DOM overlays without changing the
  persisted canvas state.

## Verification

Focused component tests will call the Excalidraw change subscriber repeatedly
and verify that the same overlay follows:

- node movement;
- node resizing;
- canvas panning;
- canvas zooming;
- viewport offset changes.

Existing tests for panel unmount survival, orphan recovery, and final image
replacement remain required. Type checking, the full web test suite, and a
production build complete the verification.

## Non-Goals

- Rendering shimmer as native Excalidraw elements.
- Changing canvas storage schema.
- Changing image-generation provider behavior.
- Adding progress percentages or cancellation controls.
