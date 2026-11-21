# Basement Planner

Lay out new walls and doors in your real basement with a Meta Quest 3/3S. Runs in the
Quest Browser (WebXR) and is built on Meta's [Immersive Web SDK](https://iwsdk.dev).

## Using it

1. Open the site in the **Meta Quest Browser** and tap **Enter AR**.
2. Optional: **Import scan** (menu) pulls in the foundation walls, floor and ceiling height
   from your Quest *Space Setup*. New walls then snap 1" off the foundation.
3. **Walls**: aim at the floor and pinch (or pull the trigger). The point is placed when you
   release. Keep clicking to chain walls; click the same spot twice, close the loop, or press
   **Finish** to end the chain.
4. **Length...** types an exact length for the last wall (`10'4 1/2`; a bare number is inches).
5. **Doors**: pick a size (30/32/36" doors, 36" opening, or **Width...**) and point at a wall.
6. **Align** the first time: click two real floor corners. They're saved as *Ref 1* / *Ref 2*.
   If the plan ever shows up in the wrong place later, use **Align** and click the same two
   corners in the same order.

| Action | Hands | Controllers |
| --- | --- | --- |
| Place / select | Pinch | Trigger |
| Fine placement | Hold the pinch 0.5 s, then move (1/4 speed) | Hold the trigger 0.5 s |
| Menu | Turn your left palm toward you; poke with your right index finger | Above the left controller (X hides it) |
| Undo | Menu **Undo** | B / Y |
| Finish chain | Menu **Finish** | A |
| Wall height | Menu **H ...** | Right thumbstick up/down |

The plan autosaves in the browser. Use **Export plan** on the flat page to keep a copy, and
**Import plan** to load it back.

### Snapping

SketchUp-style inference: endpoints, midpoints, points on walls, 45°/90° from the last
corner (relative to the room's main axis), alignment with other corners, intersections of
those guides, and a 1" grid. In fine mode the snap radius shrinks and the grid becomes 1/4".
**Snap: off** in the menu turns it off.

### Staying in place between sessions

The plan is attached to IWSDK's persistent scene anchor, so it normally reappears exactly
where you left it. If the headset loses that anchor (e.g. you cleared your space), the app
tells you, and **Align** with the two reference corners puts the plan back.

## Development

```bash
npm install          # .npmrc skips a CUDA download needed only by IWSDK's AI tooling
npm run dev          # IWSDK dev server + emulator (https://localhost:8081)
npm test             # unit tests (units, geometry, snapping, alignment, store, scan import)
npm run e2e          # production build + headless Chrome + IWER emulator smoke test
npm run build        # static site in dist/
```

`npm run e2e` drives a virtual Quest 3 (controllers and hands) to draw walls, use the menu
and keypad, place a door, use fine mode, re-align, and reload. It needs a Chrome binary
(`CHROME_PATH`, default `/usr/bin/google-chrome`).

To test on the headset from your PC: `npm run dev`, then open the network URL it prints in
the Quest Browser (same Wi-Fi) and accept the local certificate warning. For live console
logs, connect over USB and use `chrome://inspect` on the PC.

### Layout

```
src/core/      plan model + pure logic (no three.js), fully unit tested
  plan.ts        zod schema; everything stored in inches
  ops.ts         add/split/delete walls, openings, typed lengths
  wallGeometry   mitered wall footprints (L, T, X joins) and prisms around openings
  snapping.ts    inference snapping engine
  alignment.ts   two-point plan <-> room transform
  roomScan.ts    Quest room planes -> foundation walls
  store.ts       undo/redo via Immer patches
src/xr/        three.js / IWSDK layer
  app.ts         the planner: tools, menu, keypad, scan import, autosave
  input.ts       hand/controller aim with One-Euro smoothing, pinch-lock, fine mode
  planView.ts    wall meshes + labels
  preview.ts     cursor, dashed guides, rubber-band wall, door preview
  panel.ts       poke-able button panels (wrist menu, keypad)
  tools/         walls, doors, delete, align
```

Deploys to GitHub Pages from `main` via `.github/workflows/pages.yml`.

## Roadmap

- v1.1: top-down 2D plan view with dimensions (print / PDF), DXF export
- v2: framing generation (studs, plates, headers), x-ray view, materials list, drag-to-edit, windows
- v3: ceiling zones / soffits, floor finishes, editing in the 2D view
