# Basement Planner

Lay out new walls and doors in your real basement with a Meta Quest 3/3S. Runs in the
Quest Browser (WebXR) and is built on Meta's [Immersive Web SDK](https://iwsdk.dev).

## Using it

Open the site in the **Meta Quest Browser** and tap **Enter AR** (large-space mode is on by
default: no Quest boundary, walk the whole basement).

**Scan the basement** from the Room tab: walk slowly and look at every wall, the floor and the
ceiling. Walls appear while you walk; **Stop** finds the real walls (with their doors, wide
openings and windows), the ceiling height, low areas under ducts and beams, posts and the
floor area. Click any found item to skip it, then **Add**. Walls join at exact corners and
tees, so rooms close and can be named. Space Setup (if you have one) still imports too.

How the scan finds walls: every depth ray also proves the space it crossed is empty, so a
doorway (seen through) is told apart from a wall hidden behind a shelf (never seen). Walls must
reach up to the joists, so shelves and appliances don't become walls. See
`src/core/wallFinder.ts`.

The **wrist menu** appears when you turn your left palm toward you (or above the left
controller). Tabs down the left side:

| Tab | What it does |
| --- | --- |
| **Build** | **Walls** (pinch corners; same spot twice, close the loop or **Finish** to end), **Doors** (30/32/36", 36" opening, custom), **Capture** (tap a real wall the scan missed to find its full length, tap again to add; or hold and sweep along it) |
| **Edit** | **Select**: drag corners, drag a wall to slide it, slide doors, move pins; tap a wall for length, height, thickness, 2x4/2x6, split, real/planned; tap a door for width, height, type (door / opening / window), flip. **Delete** tool |
| **Measure** | Tape measure between any two spots on the floor or walls; saved lines appear in the plan |
| **Rooms** | Tap inside a closed area, pick a name and floor finish; area in sq ft |
| **Pins** | Outlets, switches, panel (on walls, snapping to 12"/48"/54"), lights (ceiling), water heater, furnace, drain, pipe, post (floor) |
| **Ceiling** | Ceiling type (drywall / drop / open joists) and height, plan-wide or for the selected room; show it in AR; **Soffit** tool (drag a rectangle under a duct or beam) |
| **Room** | **Scan** the basement (see above), import Space Setup, auto-import on/off, **Align** with two reference corners (saved as persistent anchors: the plan relocks itself next session) |
| **View** | Ghost / Solid / **X-ray** (generated framing: layout at 16" o.c. from the corner, corner and tee backing, kings, jacks, headers, cripples, sills; real stud walls too), real walls shown / as outlines / hidden, labels, snapping, real objects hide walls, menu on wrist / floating / pinned, exit |

Undo/redo sit in the menu's top-right corner (B/Y on controllers). Controllers: flick the
right thumbstick left/right to switch tools; up/down changes wall height in the Walls tool.
Precise placement: hold the pinch or trigger for half a second (1/4 speed fine mode).

On the flat page: a dimensioned **2D floor plan** (print / save PDF / SVG), a room list with
floor-finish totals (+10% waste), and plan export/import. Everything stays on the headset
(browser storage, marked persistent); export the JSON to keep a backup.

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

- Windows, ceiling zones / soffits, materials list from the framing, DXF export
- Editing in the 2D view, wall end style option
