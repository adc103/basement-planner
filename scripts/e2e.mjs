// End-to-end smoke test: production build + IWER (Meta's WebXR emulator) in headless Chrome.
// Fresh start, phase 1: Space Setup import, correcting walls (draw, drag, snap to the
// scanned surface), doors, measuring with tape checks, and the room mesh. Usage: npm run build && node scripts/e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const iwerSrc = readFileSync(require.resolve('iwer/build/iwer.min.js'), 'utf8');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const server = await preview({ preview: { port: 4179, host: '127.0.0.1' }, logLevel: 'error' });
const url = 'https://127.0.0.1:4179/';
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-proxy-server', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// Remote assets (controller/hand models, fonts) can't load in an offline sandbox; they do on the headset.
const offlineHosts = [];
page.on('requestfailed', (r) => offlineHosts.push(new URL(r.url()).host));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
await page.addInitScript(iwerSrc);
await page.addInitScript(() => {
  const d = new IWER.XRDevice(IWER.metaQuest3);
  d.installRuntime({ forceInstall: true });
  d.primaryInputMode = 'controller';
  window.__dev = d;
});

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const frames = (n = 6) => page.evaluate((n) => new Promise((r) => {
  let i = 0;
  const s = window.__dev.activeSession;
  const tick = () => (++i >= n ? r() : s ? s.requestAnimationFrame(tick) : setTimeout(tick, 16));
  s ? s.requestAnimationFrame(tick) : setTimeout(tick, 16);
}), n);

// Point the right controller straight down from 1.2 m above floor point (x, z).
const aimDown = (side, x, z) =>
  page.evaluate(({ side, x, z }) => {
    const c = window.__dev.controllers[side];
    c.position.set(x, 1.2, z);
    // -90° about X: the controller's -Z (ray) points at the floor.
    const s = Math.SQRT1_2;
    c.quaternion.set(-s, 0, 0, s);
  }, { side, x, z });

const press = async (side, button = 'trigger') => {
  await page.evaluate(({ side, button }) => window.__dev.controllers[side].updateButtonValue(button, 1), { side, button });
  await frames(3);
  await page.evaluate(({ side, button }) => window.__dev.controllers[side].updateButtonValue(button, 0), { side, button });
  await frames(3);
};

const plan = () => page.evaluate(() => JSON.parse(JSON.stringify(window.basementPlanner.store.plan)));
const wallLens = (p) =>
  p.walls.map((w) => {
    const a = p.nodes.find((n) => n.id === w.a);
    const b = p.nodes.find((n) => n.id === w.b);
    return Math.hypot(a.x - b.x, a.y - b.y);
  });


const clickButton = async (panelExpr, name) => {
  const b = await page.evaluate(({ panelExpr, name }) => {
    const panel = eval(panelExpr);
    const mesh = panel.root.getObjectByName(name);
    if (!panel.visible || !mesh) return null;
    mesh.updateWorldMatrix(true, false);
    const v = mesh.getWorldPosition(mesh.position.clone());
    const n = mesh.up.clone().set(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(mesh.quaternion.clone()));
    return { x: v.x, y: v.y, z: v.z, nx: n.x, ny: n.y, nz: n.z };
  }, { panelExpr, name });
  if (!b) return false;
  await page.evaluate((b) => {
    const c = window.__dev.controllers.right;
    c.position.set(b.x + b.nx * 0.3, b.y + b.ny * 0.3, b.z + b.nz * 0.3);
    const tx = -b.nx, ty = -b.ny, tz = -b.nz;
    const cx = ty, cy = -tx, cz = 0; // (0,0,-1) x t
    const w = 1 - tz;
    const l = Math.hypot(cx, cy, cz, w) || 1;
    c.quaternion.set(cx / l, cy / l, cz / l, w / l);
  }, b);
  await frames(5);
  await press('right');
  await frames(3);
  await page.waitForTimeout(200); // human-speed taps
  return true;
};
const menu = 'window.basementPlanner.menu.panel';
const keypad = 'window.basementPlanner.keypad.panel';

try {
  await page.goto(url);
  await page.waitForSelector('#planner-dom', { timeout: 30000 });
  check(true, 'page loads and the planner mounts');
  check(/Version \w+/.test(await page.locator('#planner-dom').innerText()), 'flat page shows the app version');
  {
    const over = await page.evaluate(() => window.basementPlanner.menu?.overflow ?? null);
    check(Array.isArray(over) && over.length === 0, `every menu row fits on the panel${over?.length ? ` (overflow: ${over.join(', ')})` : ''}`);
  }
  await page.click('#bp-enter');
  await page.waitForFunction(() => !!window.__dev.activeSession, null, { timeout: 15000 });
  check(true, 'XR session started');
  await frames(20);
  // Keep the left controller out of the way, pointing up.
  await page.evaluate(() => {
    const c = window.__dev.controllers.left;
    c.position.set(-0.4, 1.0, 0.2);
    c.quaternion.set(0, 0, 0, 1);
  });

  // --- Room tab: Space Setup import (the emulator has no Space Setup) ---------------
  check(await clickButton(menu, 'btn:import'), 'Room tab shows the Space Setup button');
  const status = await page.evaluate(() => window.basementPlanner.menu.panel && window.basementPlanner['roomStatus']());
  check(/Space Setup/.test(status), `room status points to Space Setup when there are no walls (${status})`);

  // --- Edit tab: draw a missing wall ---------------------------------------------------
  check(await clickButton(menu, 'btn:tab-edit'), 'Edit tab opens');
  check(await clickButton(menu, 'btn:tool-walls'), 'Wall tool tile');
  check(await page.evaluate(() => window.basementPlanner.toolName === 'walls'), 'the wall tool is active');
  // Draw an L: (0,-1) -> (2.0,-1) -> (2.0,-2.5).
  await aimDown('right', 0, -1);
  await frames(4);
  await press('right');
  await aimDown('right', 2.0, -1.005);
  await frames(4);
  await press('right');
  await aimDown('right', 2.004, -2.5);
  await frames(4);
  await press('right');
  await press('right');
  await frames(6);
  let p = await plan();
  const lens = wallLens(p);
  check(p.walls.length === 2, `two walls drawn (got ${p.walls.length})`);
  check(Math.abs(lens[0] - 79) <= 1 && Math.abs(lens[1] - 59) <= 1, `lengths match the aimed points within 1" (${lens.map((l) => l.toFixed(1)).join(', ')})`);
  await press('right', 'b-button');
  p = await plan();
  check(p.walls.length === 1, `B undoes the last wall (now ${p.walls.length})`);

  // --- Door on that wall ------------------------------------------------------------------
  check(await clickButton(menu, 'btn:tool-doors'), 'Door tool tile');
  check(await clickButton(menu, 'btn:preset-door-32'), '32" door preset');
  await page.evaluate(() => {
    const c = window.__dev.controllers.right;
    c.position.set(1.0, 1.2, 0.2);
    const pitch = -Math.atan2(1.2 - 1.0, 1.2) / 2;
    c.quaternion.set(Math.sin(pitch), 0, 0, Math.cos(pitch));
  });
  await frames(6);
  await press('right');
  await frames(4);
  p = await plan();
  check(p.openings.length === 1 && p.openings[0].width === 32, `door placed on the wall (${p.openings.map((o) => o.width).join(', ')})`);

  // --- Select a wall and type its length on the keypad ----------------------------------
  check(await clickButton(menu, 'btn:tool-edit'), 'Select tool tile');
  await page.evaluate(() => {
    const app = window.basementPlanner;
    app.editTool.select({ kind: 'wall', id: app.store.plan.walls[0].id });
    app.menu.panel.refresh();
  });
  await frames(3);
  check(await clickButton(menu, 'btn:e-len'), 'Length button shows for a selected wall');
  check(await page.evaluate(() => window.basementPlanner.keypad.open), 'keypad opens');
  await clickButton(keypad, 'btn:kclr');
  for (const k of ['1', '0', '0']) await clickButton(keypad, `btn:k${k}`);
  await clickButton(keypad, 'btn:kok');
  p = await plan();
  check(Math.round(wallLens(p)[0]) === 100, `typed length sets the wall to 100" (${wallLens(p)[0].toFixed(2)})`);

  // --- Room mesh, then Snap to scan ----------------------------------------------------------
  check(await clickButton(menu, 'btn:tab-room'), 'Room tab opens');
  check(await clickButton(menu, 'btn:scan'), 'Scan button starts a scan');
  await page.waitForTimeout(800);
  check(await page.evaluate(() => window.basementPlanner.scan.scanning), 'scan is running');
  // The emulator has no depth sensor: hand the room mesh frames of a flat wall 2 m ahead.
  await page.evaluate(() => {
    const W = 80, H = 60;
    const proj = new Float32Array(16);
    proj[0] = 1; proj[5] = 1.33; proj[10] = -1; proj[11] = -1; proj[14] = -0.2;
    for (let n = 0; n < 6; n++) {
      const depthMM = new Uint16Array(W * H).fill(2000 + n);
      const viewToRoot = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 1.5, 30, 1]);
      window.basementPlanner.scan.mesh.push({ t: n, w: W, h: H, depthMM, proj, viewToRoot, head: [30, 1.5, 30], handL: [30, 0, 31], handR: [30, 0, 31] });
    }
  });
  const tris = await page
    .waitForFunction(() => window.basementPlanner.scan.mesh.triangles > 0 && window.basementPlanner.scan.mesh.triangles, null, { timeout: 8000 })
    .then((h) => h.jsonValue())
    .catch(() => 0);
  check(tris > 1000, `depth frames build the room mesh (${tris} triangles)`);
  {
    await page.waitForTimeout(700);
    const hud = await page.evaluate(() => {
      const app = window.basementPlanner;
      return { shown: app.scanHud.sprite.visible && app.scanTip.sprite.visible, text: app.scanHud.text, tip: app.scanTip.text, coverageSkin: app.scan.mesh.coverageOn.value };
    });
    check(hud.shown && /Scanning|photos/.test(hud.text) && hud.tip.length > 10 && hud.coverageSkin === 1, `scanning shows what's captured and what to do next (${hud.text} | ${hud.tip})`);
  }
  check(await clickButton(menu, 'btn:scan'), 'Stop scan');
  check(await page.evaluate(() => !window.basementPlanner.scan.scanning), 'scan stopped');
  {
    const r = await page.evaluate(() => {
      const app = window.basementPlanner;
      const face = 28 / 0.0254; // the flat wall's face, plan inches
      const id = app.cmd.run('wall.add', { a: { x: 1110, y: face - 2.25 + 1.5 }, b: { x: 1250, y: face - 2.25 + 1.5 }, kind: 'existing', thickness: 4.5, height: 96 });
      const before = app.verifyWalls([id])?.[0]?.check.deviation ?? null;
      app.editTool.select({ kind: 'wall', id });
      app.menuApi().snapSelected();
      const after = app.verifyWalls([id])?.[0]?.check.deviation ?? null;
      const undo = app.store.undoLabel;
      app.cmd.run('element.delete', { id });
      app.editTool.select(null);
      return { before, after, undo };
    });
    check(r.before !== null && Math.abs(r.before - 1.5) < 0.5, `wall check measures a 1.5" error (${r.before?.toFixed(2)}")`);
    check(r.after !== null && r.after < 0.3, `Snap to scan puts the wall on the mesh (${r.after?.toFixed(2)}" off)`);
    check(r.undo === 'Fit to scan', `snapping is one undo step (${r.undo})`);
  }
  {
    // Real wall: point at the scanned wall and tap (the emulator has no controller aim here,
    // so the tap's ray is handed to the tool). The wall is found on the room mesh in the
    // fusion worker, measured, and added; a second tap on it ends it there.
    const r = await page.evaluate(async () => {
      const app = window.basementPlanner;
      app.setTool('trace');
      const face = 28 / 0.0254;
      const tool = app.tools.trace;
      const eye = { x: 1181, y: 1181, z: 60 };
      const aimAt = (x) => {
        const d = { x: x - eye.x, y: face - eye.y, z: 50 - eye.z };
        const L = Math.hypot(d.x, d.y, d.z);
        return { ray: { o: eye, d: { x: d.x / L, y: d.y / L, z: d.z / L } }, surface: null, floor: null, wall: null, eye: { x: eye.x, y: eye.y } };
      };
      const settle = async () => {
        for (let i = 0; i < 100 && (tool.busy || tool.inFlight); i++) await new Promise((res) => setTimeout(res, 50));
      };
      // Hovering shows the wall before you tap.
      tool.hover(aimAt(1180));
      await settle();
      tool.hover(aimAt(1180));
      const previewed = !!(tool.found && tool.found.proposal);
      const before = app.store.plan.walls.length;
      tool.commit(aimAt(1180));
      await settle();
      const w = app.store.plan.walls.at(-1);
      const added = app.store.plan.walls.length - before;
      const len = (id) => {
        const ww = app.store.plan.walls.find((x) => x.id === id);
        const a = app.store.plan.nodes.find((n) => n.id === ww.a), b = app.store.plan.nodes.find((n) => n.id === ww.b);
        return Math.hypot(b.x - a.x, b.y - a.y);
      };
      const full = len(w.id);
      const dev = app.verifyWalls([w.id])?.[0]?.check.deviation ?? null;
      const undo1 = app.store.undoLabel;
      // Tap the same wall 30" in from one end: that end moves there.
      tool.commit(aimAt(1130));
      await settle();
      const trimmed = len(w.id);
      const undo2 = app.store.undoLabel;
      const count2 = app.store.plan.walls.length - before;
      app.undo();
      app.undo();
      const after = app.store.plan.walls.length - before;
      app.setTool('edit');
      return { previewed, added, kind: w.kind, full, dev, undo1, trimmed, undo2, count2, after };
    });
    check(r.previewed, 'pointing at a scanned wall previews it before the tap');
    check(r.added === 1 && r.kind === 'existing', `one tap on a scanned wall adds one real wall (${r.added}, ${r.kind})`);
    check(r.full > 140 && r.full < 170, `the wall runs the length of the scanned face (${r.full.toFixed(0)}")`);
    check(r.dev !== null && r.dev < 0.3, `the wall lands on the scanned surface (${r.dev?.toFixed(2)}" off)`);
    check(r.undo1 === 'Trace real wall', `adding is one undo step (${r.undo1})`);
    check(r.count2 === 1 && r.trimmed < r.full - 20, `tapping the same wall again ends it there (${r.full.toFixed(0)}" to ${r.trimmed.toFixed(0)}")`);
    check(r.undo2 === 'End real wall' && r.after === 0, `ending is its own undo step (${r.undo2})`);
  }
  {
    // Real door: a wall with an open 32" x 80" doorway, scanned (synthetic depth frames,
    // well away from the other test geometry), traced as a plan wall, then measured by
    // pointing through the doorway.
    const frames = JSON.parse(
      execSync(
        `npx tsx -e "
import { depthFramesFor } from './tests/synthScan';
const X = 2000, Y = 2000, H = 92;
const box = (x0, y0, z0, x1, y1, z1) => ({ min: [X + x0, Y + y0, z0], max: [X + x1, Y + y1, z1] });
const boxes = [box(-60, -60, -6, 160, 160, 0), box(-60, -60, H, 160, 160, H + 6),
  box(0, -60, 0, 4.5, 30, H), box(0, 30, 80, 4.5, 62, H), box(0, 62, 0, 4.5, 160, H)];
const fr = depthFramesFor({ boxes, eyes: [[X - 50, Y + 46], [X + 50, Y + 46], [X - 40, Y + 10], [X + 40, Y + 90]] }, { yawStep: 20 });
process.stdout.write(JSON.stringify(fr.map((f) => ({ t: f.t, w: f.w, h: f.h, d: Array.from(f.depthMM), proj: Array.from(f.proj), v: Array.from(f.viewToRoot) }))));
"`,
        { maxBuffer: 1 << 28 },
      ).toString(),
    );
    const r = await page.evaluate(async (frames) => {
      const app = window.basementPlanner;
      for (const f of frames) app.scan.mesh.push({ t: f.t, w: f.w, h: f.h, depthMM: new Uint16Array(f.d), proj: new Float32Array(f.proj), viewToRoot: new Float32Array(f.v), head: [0, 0, 0], handL: [0, 0, 0], handR: [0, 0, 0] });
      app.scan.mesh.send({ type: 'mesh' }); // mesh the new frames (the app does this while scanning)
      await new Promise((res) => setTimeout(res, 3000));
      const wallId = app.cmd.run('wall.add', { a: { x: 2002.25, y: 1980 }, b: { x: 2002.25, y: 2140 }, kind: 'existing', thickness: 4.5, height: 92 });
      app.menuApi().setMeasureDoors();
      const tool = app.tools.doors;
      // Pointing through the doorway 6" off its center, 40" up.
      const aim = { wall: { wallId, point: { x: 2002.25, y: 2052 }, z: 40, distM: 1 }, floor: null, surface: null, eye: { x: 1950, y: 2046 } };
      const before = app.store.plan.openings.length;
      tool.commit(aim);
      for (let i = 0; i < 100 && tool.busy; i++) await new Promise((res) => setTimeout(res, 50));
      const o = app.store.plan.openings.at(-1);
      const added = app.store.plan.openings.length - before;
      // The door's center is 46" from the wall's a end (y 1980 -> 2026 + 20).
      const res = { added, type: o?.type, kind: o?.kind, width: o?.width, height: o?.height, offset: o?.offset, undo: app.store.undoLabel };
      // Pointing at solid wall finds nothing and adds nothing.
      tool.commit({ ...aim, wall: { ...aim.wall, point: { x: 2002.25, y: 2110 } } });
      for (let i = 0; i < 100 && tool.busy; i++) await new Promise((res) => setTimeout(res, 50));
      res.afterSolid = app.store.plan.openings.length - before;
      app.undo();
      app.cmd.run('element.delete', { id: wallId });
      app.setTool('edit');
      return res;
    }, frames);
    check(r.added === 1 && r.type === 'door' && r.kind === 'existing', `pointing through a real doorway adds a real door (${r.added}, ${r.type}, ${r.kind})`);
    check(Math.abs(r.width - 32) <= 1 && Math.abs(r.height - 80) <= 1.5, `the door is measured on the scan (${r.width}" x ${r.height}", truth 32 x 80)`);
    check(Math.abs(r.offset - 66) <= 1, `the door is where the doorway is (center ${r.offset?.toFixed(1)}" along the wall, truth 66)`);
    check(r.undo === 'Measure door' && r.afterSolid === 1, `one undo step; solid wall adds nothing (${r.undo}, ${r.afterSolid})`);
  }
  {
    // Select without moving: pressing an unselected wall (with hand jitter) only selects it;
    // a selected wall moves only once the aim has clearly turned.
    const r = await page.evaluate(() => {
      const app = window.basementPlanner;
      app.setTool('edit');
      const id = app.cmd.run('wall.add', { a: { x: -200, y: -200 }, b: { x: -80, y: -200 }, kind: 'new', thickness: 4.5, height: 96 });
      const ends = () => { const w = app.store.plan.walls.find((x) => x.id === id); const a = app.store.plan.nodes.find((n) => n.id === w.a); return a.y; };
      const aim = (y, dz) => ({ floor: { x: -140, y }, wall: { wallId: id, point: { x: -140, y: -200 }, z: 40, distM: 2 }, ray: { o: { x: -140, y: -120, z: 60 }, d: { x: 0, y: -0.8, z: -0.6 + dz } }, surface: null, box: null, ceiling: null, eye: { x: -140, y: -120 } });
      const tool = app.editTool;
      tool.select(null);
      tool.pressStart(aim(-200, 0));
      tool.drag(aim(-197, 0.01)); // jitter: 3" on the floor, under a degree of aim
      tool.drag(aim(-190, 0.2)); // even a real swing: not selected yet, so nothing moves
      tool.commit(aim(-190, 0.2));
      const afterFirst = ends();
      const selected = tool.selection?.id === id;
      // Now selected: a small wobble still doesn't move it, a clear drag does.
      tool.pressStart(aim(-200, 0));
      tool.drag(aim(-199, 0.01));
      const wobble = ends();
      tool.drag(aim(-188, 0.2));
      tool.commit(aim(-188, 0.2));
      const dragged = ends();
      app.cmd.run('element.delete', { id });
      return { afterFirst, selected, wobble, dragged };
    });
    check(r.selected && r.afterFirst === -200, `pressing an unselected wall selects it without moving it (${r.afterFirst})`);
    check(r.wobble === -200 && Math.abs(r.dragged + 188) < 1.5, `a selected wall ignores wobble, then slides with a clear drag (${r.wobble} -> ${r.dragged})`);
  }
  {
    // Real wall on a wall that's already in the plan (e.g. from Space Setup): fits it, no duplicate.
    const r = await page.evaluate(async () => {
      const app = window.basementPlanner;
      const face = 28 / 0.0254;
      const id = app.cmd.run('wall.add', { a: { x: 1120, y: face - 2.25 + 3 }, b: { x: 1240, y: face - 2.25 + 3 }, kind: 'existing', thickness: 4.5, height: 96 });
      const before = app.store.plan.walls.length;
      app.setTool('trace');
      const tool = app.tools.trace;
      const eye = { x: 1181, y: 1181, z: 60 };
      const d = { x: 0, y: face - eye.y, z: -10 };
      const L = Math.hypot(d.x, d.y, d.z);
      tool.commit({ ray: { o: eye, d: { x: 0, y: d.y / L, z: d.z / L } }, surface: null, floor: null, wall: null, eye: { x: eye.x, y: eye.y } });
      for (let i = 0; i < 100 && tool.busy; i++) await new Promise((res) => setTimeout(res, 50));
      const count = app.store.plan.walls.length - before;
      const dev = app.verifyWalls([id])?.[0]?.check.deviation ?? null;
      const label = app.store.undoLabel;
      app.undo();
      app.cmd.run('element.delete', { id });
      app.setTool('edit');
      return { count, dev, label };
    });
    check(r.count === 0 && r.label === 'Fit real wall', `pointing at a wall already in the plan fits it instead of adding another (${r.count}, ${r.label})`);
    check(r.dev !== null && r.dev < 0.3, `that wall now sits on the scanned surface (${r.dev?.toFixed(2)}" off)`);
  }
  {
    // Color: a camera photo of the scanned wall is kept as a texture and drawn sharp on it.
    const r = await page.evaluate(async () => {
      const app = window.basementPlanner;
      const m = app.scan.mesh;
      const w = 640, h = 480;
      const rgba = new Uint8Array(w * h * 4);
      // Stripes 16 px wide: detail far finer than the 4 cm voxels.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set((x >> 4) & 1 ? [200, 40, 40, 255] : [40, 40, 200, 255], (y * w + x) * 4);
      const camToRoot = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 1.5, 30, 1]);
      m.colorize({ rgba, w, h, camToRoot, fx: 320, fy: 320, cx: 320, cy: 240 });
      await new Promise((res) => setTimeout(res, 1500));
      m.send({ type: 'mesh' });
      await new Promise((res) => setTimeout(res, 2500));
      let textured = 0;
      for (const [, piece] of m.chunks()) {
        const a = piece.geometry.getAttribute('photo');
        for (let i = 0; i < a.count; i++) if (a.getX(i) !== 255) textured++;
      }
      const kept = !!m.photoU.photoTex.value;
      // Two more photos from either side: the wall counts as covered (seen from 3 sides).
      for (const [x, yaw] of [[28.6, -0.6], [31.4, 0.6]]) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        m.markSeen({ w, h, fx: 320, fy: 320, cx: 320, cy: 240, camToRoot: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.5, 30, 1] });
      }
      await new Promise((res) => setTimeout(res, 800));
      m.send({ type: 'mesh' });
      await new Promise((res) => setTimeout(res, 2000));
      const cv = m.coverage();
      const coverage = Math.round(cv.covered * cv.total);
      // Draw it in color mode for a few frames (shader compiles, no GL errors).
      const api = app.menuApi();
      while (api.roomMeshMode() !== 'color') api.cycleRoomMesh();
      return { textured, kept, coverage };
    });
    await frames(10);
    check(r.kept && r.textured > 500, `a photo of the scanned wall is kept as its texture (${r.textured} vertices textured)`);
    check(r.coverage > 1500, `photos from three sides cover the wall (${r.coverage} vertices covered)`);
    await page.evaluate(() => {
      const api = window.basementPlanner.menuApi();
      while (api.roomMeshMode() !== 'mesh') api.cycleRoomMesh();
    });
  }
  {
    // Virtual holes: a door cut into a real wall, and a real wall removed, are seen through.
    const r = await page.evaluate(() => {
      const app = window.basementPlanner;
      const stencil = !!app.world?.renderer?.getContext().getContextAttributes().stencil;
      const id = app.cmd.run('wall.add', { a: { x: -300, y: -300 }, b: { x: -150, y: -300 }, kind: 'existing', thickness: 4.5, height: 92 });
      app.editTool.select({ kind: 'wall', id });
      const api = app.menuApi();
      api.toggleRemove();
      const removed = app.store.plan.walls.find((w) => w.id === id).demolish;
      api.toggleRemove();
      const kept = !app.store.plan.walls.find((w) => w.id === id).demolish;
      app.setTool('doors');
      app.menuApi().setPreset('door', 32);
      const tool = app.tools.doors;
      tool.commit({ wall: { wallId: id, point: { x: -225, y: -300 }, z: 40, distM: 2 }, floor: null, surface: null, eye: { x: -225, y: -200 } });
      const o = app.store.plan.openings.find((x) => x.wallId === id);
      app.cmd.run('wall.setDemolish', { id, demolish: true });
      return { stencil, removed, kept, cutKind: o?.kind, id };
    });
    await frames(6);
    const after = await page.evaluate((id) => {
      const app = window.basementPlanner;
      const removedShown = app.holes.removedWalls.includes(id);
      app.cmd.run('element.delete', { id });
      app.editTool.select(null);
      app.setTool('edit');
      app.menuApi().setMeasureDoors();
      app.setTool('edit');
      return { removedShown };
    }, r.id);
    check(r.stencil, 'the renderer has a stencil buffer (virtual holes need it)');
    check(r.removed && r.kept, `Remove wall marks a real wall to tear out, and Keep wall undoes it (${r.removed}, ${r.kept})`);
    check(r.cutKind === 'new', `a door placed on a real wall is a planned cut (${r.cutKind})`);
    check(after.removedShown, 'a removed real wall is shown as a hole');
  }
  {
    const cyc = await page.evaluate(() => {
      const app = window.basementPlanner;
      const api = app.menuApi();
      const seen = [api.roomMeshMode()];
      for (let i = 0; i < 3; i++) {
        api.cycleRoomMesh();
        seen.push(api.roomMeshMode());
      }
      return seen.join(' > ');
    });
    check(cyc === 'mesh > color > off > mesh', `Mesh button cycles see-through, color, hidden (${cyc})`);
  }

  {
    // A splat of the room: loaded, the Mesh button shows it over the room (Spark).
    const r = await page.evaluate(async () => {
      const app = window.basementPlanner;
      // A tiny 3D Gaussian splat PLY (two splats).
      const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
      const head = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex 2\n${props.map((q) => `property float ${q}`).join('\n')}\nend_header\n`);
      const body = new Float32Array([0, 1.5, -2, 1, 0, 0, 2, -3, -3, -3, 1, 0, 0, 0, 0.2, 1.5, -2, 0, 1, 0, 2, -3, -3, -3, 1, 0, 0, 0]);
      const bytes = new Uint8Array(head.length + body.byteLength);
      bytes.set(head);
      bytes.set(new Uint8Array(body.buffer), head.length);
      await app.splat.save('test.ply', bytes.buffer);
      const api = app.menuApi();
      const seen = [];
      for (let i = 0; i < 5; i++) {
        api.cycleRoomMesh();
        seen.push(api.roomMeshMode());
      }
      await new Promise((res) => setTimeout(res, 3000));
      while (api.roomMeshMode() !== 'splat') api.cycleRoomMesh();
      await new Promise((res) => setTimeout(res, 3000));
      const shown = !!app.splat.mesh && app.splat.mesh.visible;
      while (api.roomMeshMode() !== 'mesh') api.cycleRoomMesh();
      return { seen: seen.join(' > '), shown };
    });
    await frames(4);
    check(r.seen.includes('splat') && r.shown, `a loaded splat shows from the Mesh button (${r.seen}; shown ${r.shown})`);
  }

  {
    // Training a splat on the device (WebGPU in a worker): a few steps on photos of a
    // colored wall, the result loads into the splat view.
    const r = await page.evaluate(async () => {
      const app = window.basementPlanner;
      if (!('gpu' in navigator)) return { skipped: 'no WebGPU' };
      const W = 64, H = 48;
      const c = new OffscreenCanvas(W, H);
      const x = c.getContext('2d');
      const views = [];
      for (let i = 0; i < 8; i++) {
        x.fillStyle = '#c04020';
        x.fillRect(0, 0, W, H);
        x.fillStyle = '#2040c0';
        x.fillRect(W / 2, 0, W / 2, H);
        const jpeg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
        // Camera at z = 1.5 m looking down -z at a wall on z = 0, a little to either side.
        const ox = (i - 3.5) * 0.05;
        views.push({ jpeg, w: W, h: H, camToRoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ox, 1.2, 1.5, 1], fx: 50, fy: 50, cx: W / 2, cy: H / 2 });
      }
      const n = 400;
      const pos = new Float32Array(n * 3), rgb = new Uint8Array(n * 3).fill(128), normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos.set([((i % 20) / 19 - 0.5) * 2, 1.2 + (Math.floor(i / 20) / 19 - 0.5) * 1.5, 0], i * 3);
        normals.set([0, 0, 1], i * 3);
      }
      const t0 = performance.now();
      let progress = 0;
      try {
        const ply = await app.splatMaker.make(views, { pos, rgb, normals }, () => progress++, { steps: 40, w: W, h: H });
        const head = new TextDecoder().decode(ply.slice(0, 800));
        await app.splat.save('trained.ply', ply.buffer);
        return { ok: head.includes('element vertex') && head.includes('rot_3'), ms: Math.round(performance.now() - t0), name: app.splat.name, bytes: ply.length };
      } catch (e) {
        return { error: String(e) };
      }
    });
    if (r.skipped) console.log(`  (splat training not checked: ${r.skipped})`);
    else check(r.ok && r.name === 'trained.ply', `a splat trains on the device and loads (${JSON.stringify(r)})`);
  }

  // --- Measure and Tape says ------------------------------------------------------------
  {
    const r = await page.evaluate(() => {
      const app = window.basementPlanner;
      app.cmd.run('measure.add', { a: { x: 0, y: 0, z: 0 }, b: { x: 120, y: 0, z: 0 } });
      return app.store.plan.measures.length;
    });
    check(r === 1, 'a measurement is recorded');
    check(await clickButton(menu, 'btn:tab-measure'), 'Measure tab opens');
    check(await clickButton(menu, 'btn:m-truth'), 'Tape says... opens the keypad');
    await clickButton(keypad, 'btn:kclr');
    for (const k of ['1', '2', '0']) await clickButton(keypad, `btn:k${k}`);
    await clickButton(keypad, 'btn:kok');
    const truth = await page.evaluate(() => window.basementPlanner.store.plan.measures[0].truth);
    check(truth === 120, `the tape value is stored with the measurement (${truth})`);
  }

  // --- Save and reload ----------------------------------------------------------------------
  await page.waitForTimeout(700);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('basement-planner:plan:v1') || 'null'));
  check(saved && saved.walls.length >= 1 && saved.openings.length === 1, 'plan is autosaved');
  await page.evaluate(() => window.__dev.activeSession?.end());
  await page.reload();
  await page.waitForSelector('#planner-dom');
  p = await plan();
  check(p.walls.length === saved.walls.length && p.measures.length === 1, 'plan restores after a reload');

  // --- Start over erases everything ---------------------------------------------------------
  page.once('dialog', (d) => d.accept());
  await page.click('#bp-new');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const app = window.basementPlanner;
    return { walls: app.store.plan.walls.length, tris: app.scan.mesh.triangles, rec: app.scan.recorder.count };
  });
  check(after.walls === 0 && after.tris === 0 && after.rec === 0, `Start over erases plan and scan (${JSON.stringify(after)})`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  if (offlineHosts.length) console.log(`note: could not reach ${[...new Set(offlineHosts)].join(', ')} (offline sandbox)`);
  const relevant = errors.filter(
    (e) =>
      !/favicon|DevTools|WebGL|GPU stall|gl_|Synthethic Environment Module/i.test(e) &&
      !(offlineHosts.length && /ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_PROXY/.test(e)),
  );
  check(relevant.length === 0, `no page errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
  await browser.close();
  await server.close();
  // The splat trainer's GPU kernel against its CPU reference (same gradients).
  try {
    const { execFileSync } = await import('node:child_process');
    const out = JSON.parse(execFileSync('node', ['scripts/gpu/run.mjs', 'scripts/gpu/check.ts'], { encoding: 'utf8', timeout: 300000 }));
    check(!out.error && out.rel < 1e-3 && out.imgErr < 0.01, `splat GPU kernel matches the CPU reference (gradient error ${out.rel?.toExponential(1)}, image ${out.imgErr?.toFixed(3)})${out.error ? ' ' + out.error : ''}`);
  } catch (e) {
    check(false, `splat GPU kernel check ran (${e})`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
  process.exit(failures ? 1 : 0);
}
