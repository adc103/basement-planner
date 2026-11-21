// End-to-end smoke test: production build + IWER (Meta's WebXR emulator) in headless Chrome.
// Drives a virtual Quest 3 controller to draw walls, press menu buttons and undo,
// then checks the saved plan. Usage: npm run build && node scripts/e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iwerSrc = readFileSync(require.resolve('iwer/build/iwer.min.js'), 'utf8');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const server = await preview({ preview: { port: 4179, host: '127.0.0.1' }, logLevel: 'error' });
const url = 'https://127.0.0.1:4179/';
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-proxy-server', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
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

try {
  await page.goto(url);
  await page.waitForSelector('#planner-dom', { timeout: 30000 });
  check(true, 'page loads and the planner mounts');
  check(await page.locator('#bp-enter').isEnabled(), 'Enter AR is available with the emulator');

  await page.click('#bp-enter');
  await page.waitForFunction(() => !!window.__dev.activeSession, null, { timeout: 15000 });
  const mode = await page.evaluate(() => window.__dev.activeSession?.mode ?? window.__dev.activeSession?.[Object.getOwnPropertySymbols(window.__dev.activeSession)[0]]?.mode);
  check(true, `XR session started (${mode ?? 'immersive'})`);
  await frames(20);

  // Keep the left controller out of the way, pointing up.
  await page.evaluate(() => {
    const c = window.__dev.controllers.left;
    c.position.set(-0.4, 1.0, 0.2);
    c.quaternion.set(0, 0, 0, 1);
  });

  // Draw an L: (0,-1) -> (2.0,-1) -> (2.0,-2.5). Lengths ~78.74" and ~59.06".
  await aimDown('right', 0, -1);
  await frames(4);
  await press('right');
  await aimDown('right', 2.0, -1.005); // slightly off axis: the 0° guide should catch it
  await frames(4);
  await press('right');
  await aimDown('right', 2.004, -2.5);
  await frames(4);
  await press('right');
  // Same spot again ends the chain.
  await press('right');
  await frames(6);

  let p = await plan();
  const lens = wallLens(p);
  check(p.walls.length === 2, `two walls drawn (got ${p.walls.length})`);
  check(lens.every((l) => Math.abs(l - Math.round(l)) < 1e-6), `lengths snap to whole inches (${lens.map((l) => l.toFixed(3)).join(', ')})`);
  check(Math.abs(lens[0] - 79) <= 1 && Math.abs(lens[1] - 59) <= 1, 'lengths match the aimed points within 1"');
  const n = p.nodes;
  const ang = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const [w1, w2] = p.walls.map((w) => [n.find((x) => x.id === w.a), n.find((x) => x.id === w.b)]);
  const turn = Math.abs(((ang(...w2) - ang(...w1) + 540) % 360) - 180);
  check(Math.abs(turn - 90) < 1e-6, `corner is exactly 90° (got ${turn.toFixed(4)}°)`);

  // Undo with B removes the second wall.
  await press('right', 'b-button');
  p = await plan();
  check(p.walls.length === 1, `B undoes the last wall (now ${p.walls.length})`);

  // Press the Doors button on the menu with the controller ray, then place a door.
  const btn = await page.evaluate(() => {
    const app = window.basementPlanner;
    const panel = app.menu.panel;
    const mesh = panel.root.getObjectByName('btn:tool-doors');
    if (!panel.visible || !mesh) return null;
    mesh.updateWorldMatrix(true, false);
    const v = mesh.getWorldPosition(mesh.position.clone());
    const q = mesh.getWorldQuaternion(mesh.quaternion.clone());
    const n = mesh.up.clone().set(0, 0, 1).applyQuaternion(q); // panel front normal
    return { x: v.x, y: v.y, z: v.z, nx: n.x, ny: n.y, nz: n.z };
  });
  check(!!btn, 'wrist menu is shown above the left controller');
  if (btn) {
    await page.evaluate((b) => {
      const c = window.__dev.controllers.right;
      // Stand 40 cm in front of the button and point straight at it.
      c.position.set(b.x + b.nx * 0.4, b.y + b.ny * 0.4, b.z + b.nz * 0.4);
      // Rotate the controller's -Z onto -normal.
      const fx = 0, fy = 0, fz = -1;
      const tx = -b.nx, ty = -b.ny, tz = -b.nz;
      const cx = fy * tz - fz * ty, cy = fz * tx - fx * tz, cz = fx * ty - fy * tx;
      const w = 1 + fx * tx + fy * ty + fz * tz;
      const l = Math.hypot(cx, cy, cz, w);
      c.quaternion.set(cx / l, cy / l, cz / l, w / l);
    }, btn);
    await frames(6);
    await press('right');
    await frames(4);
    const tool = await page.evaluate(() => window.basementPlanner.toolName);
    check(tool === 'doors', `menu click switches to the door tool (tool=${tool})`);
    p = await plan();
    check(p.walls.length === 1, 'clicking the menu did not draw anything');
  }

  // Aim at the middle of the remaining wall (z = -1) from in front of it.
  await page.evaluate(() => {
    const c = window.__dev.controllers.right;
    c.position.set(1.0, 1.2, 0.2);
    // Point forward and a bit down at the wall face.
    const pitch = -Math.atan2(1.2 - 1.0, 1.2) / 2;
    c.quaternion.set(Math.sin(pitch), 0, 0, Math.cos(pitch));
  });
  await frames(6);
  await press('right');
  await frames(4);
  p = await plan();
  check(p.openings.length === 1, `door placed on the wall (openings=${p.openings.length})`);
  if (p.openings[0]) check(p.openings[0].width === 32 && p.openings[0].height === 80, 'door is the 32" x 80" default');

  // Typed length through the menu + keypad (controller ray clicks).
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
      const cx = -tz * 0 + ty, cy = -tx, cz = 0; // (0,0,-1) x t
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
  check(await clickButton(menu, 'btn:tool-walls'), 'Walls tool tile');
  check(await clickButton(menu, 'btn:len'), 'Length... button reachable');
  check(await page.evaluate(() => window.basementPlanner.keypad.open), 'keypad opens');
  check(await clickButton(keypad, 'btn:kclr'), 'keypad Clear');
  for (const k of ['1', '2', '0']) await clickButton(keypad, `btn:k${k}`);
  await clickButton(keypad, 'btn:kok');
  p = await plan();
  check(Math.abs(wallLens(p)[0] - 120) < 1e-9, `typed 120 sets the wall to 10' 0" (got ${wallLens(p)[0]})`);
  check(!(await page.evaluate(() => window.basementPlanner.keypad.open)), 'keypad closes after OK');

  // Hand tracking: switch the emulator to hands and draw with pinches.
  await clickButton(menu, 'btn:tool-walls');
  await page.evaluate(() => (window.__dev.primaryInputMode = 'hand'));
  await frames(10);
  const handAim = (x, z) => page.evaluate(({ x, z }) => {
    const h = window.__dev.hands.right;
    h.position.set(x, 1.2, z);
    const s = Math.SQRT1_2;
    h.quaternion.set(-s, 0, 0, s);
  }, { x, z });
  const pinch = async () => {
    await page.evaluate(() => window.__dev.hands.right.updatePinchValue(1));
    await frames(4);
    await page.evaluate(() => window.__dev.hands.right.updatePinchValue(0));
    await frames(4);
  };
  const before = (await plan()).walls.length;
  await handAim(-1, 0.5);
  await frames(12);
  const isHand = await page.evaluate(() => window.basementPlanner.hands.right.isHand);
  check(isHand, 'right input is a tracked hand');
  await pinch();
  await handAim(-1, -1);
  await frames(20);
  await pinch();
  await pinch();
  p = await plan();
  check(p.walls.length === before + 1, `pinch draws a wall with hands (walls ${before} -> ${p.walls.length})`);
  await page.evaluate(() => (window.__dev.primaryInputMode = 'controller'));
  await frames(6);

  // Edit: drag a corner to a new spot (snapped), then select a wall and type its length.
  {
    check(await clickButton(menu, 'btn:tab-edit'), 'Edit tab opens');
    const tool = await page.evaluate(() => window.basementPlanner.toolName);
    check(tool === 'edit', `Edit tab selects the Select tool (tool=${tool})`);
    // The first wall runs from (0,-1) m; drag that corner to (-0.3,-1.2) m.
    const before = await plan();
    const start = before.nodes.reduce((a, n) => (Math.hypot(n.x, n.y + 39.37) < Math.hypot(a.x, a.y + 39.37) ? n : a));
    await aimDown('right', start.x * 0.0254, start.y * 0.0254);
    await frames(5);
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 1));
    await frames(4);
    for (let i = 1; i <= 6; i++) {
      await aimDown('right', start.x * 0.0254 - 0.05 * i, start.y * 0.0254 - 0.0333 * i);
      await frames(2);
    }
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 0));
    await frames(4);
    const after = await plan();
    const moved = after.nodes.find((n) => n.id === start.id);
    const dx = moved ? (moved.x - start.x) * 0.0254 : 0;
    check(!!moved && Math.abs(dx + 0.3) < 0.03, `dragging moves the corner (${dx.toFixed(3)} m in x)`);
    check(after.walls.length === before.walls.length, 'dragging keeps the walls connected');
    const undoOne = await page.evaluate(() => {
      window.basementPlanner.menu.panel.refresh();
      return window.basementPlanner.store.undoLabel;
    });
    check(undoOne === 'Move corner', `the whole drag is one undo step (${undoOne})`);

    // Tap the middle of the first wall to select it.
    const w = after.walls[0];
    const A = after.nodes.find((n) => n.id === w.a);
    const B = after.nodes.find((n) => n.id === w.b);
    const mid = { x: ((A.x + B.x) / 2) * 0.0254, z: ((A.y + B.y) / 2) * 0.0254 };
    await page.evaluate((m) => {
      const c = window.__dev.controllers.right;
      c.position.set(m.x + 0.6, 1.0, m.z + 0.6);
      const dx = -0.6, dy = -0.5, dz = -0.6;
      const l = Math.hypot(dx, dy, dz);
      const t = [dx / l, dy / l, dz / l];
      // rotate (0,0,-1) onto t
      const cx = t[1], cy = -t[0], cz = 0, ww = 1 - t[2];
      const n = Math.hypot(cx, cy, cz, ww);
      c.quaternion.set(cx / n, cy / n, cz / n, ww / n);
    }, mid);
    await frames(6);
    await press('right');
    await frames(4);
    const selKind = await page.evaluate(() => window.basementPlanner.editTool.selection?.kind ?? null);
    check(selKind === 'wall', `tapping a wall selects it (${selKind})`);
    if (selKind === 'wall') {
      check(await clickButton(menu, 'btn:e-len'), 'selection Length chip');
      await clickButton(keypad, 'btn:kclr');
      for (const k of ['9', '6']) await clickButton(keypad, `btn:k${k}`);
      await clickButton(keypad, 'btn:kok');
      const sel = await page.evaluate(() => window.basementPlanner.editTool.selection.id);
      const p3 = await plan();
      const sw = p3.walls.find((x) => x.id === sel);
      const a3 = p3.nodes.find((n) => n.id === sw.a);
      const b3 = p3.nodes.find((n) => n.id === sw.b);
      check(Math.abs(Math.hypot(a3.x - b3.x, a3.y - b3.y) - 96) < 1e-6, 'selected wall set to 8\' 0" from the keypad');
    }
  }

  // Tape measure: two floor points 1 m apart.
  {
    check(await clickButton(menu, 'btn:tab-measure'), 'Measure tab opens');
    const n0 = (await plan()).measures.length;
    await aimDown('right', 1.5, 0.5);
    await frames(5);
    await press('right');
    await aimDown('right', 2.5, 0.5);
    await frames(5);
    await press('right');
    const p4 = await plan();
    const m = p4.measures.at(-1);
    const len = m ? Math.hypot(m.a.x - m.b.x, m.a.y - m.b.y, m.a.z - m.b.z) : 0;
    check(p4.measures.length === n0 + 1 && Math.abs(len - 39.37) < 0.5, `tape measures ~39 3/8" (${len.toFixed(2)})`);
    await clickButton(menu, 'btn:tab-build');
  }

  // Depth occlusion is wired to the planned-wall materials and can be toggled.
  {
    const patched = await page.evaluate(() =>
      window.basementPlanner.view.occludableMaterials().every((m) => typeof m.onBeforeCompile === 'function' && m.transparent),
    );
    check(patched, 'planned-wall materials are registered for depth occlusion');
    check(await clickButton(menu, 'btn:tab-view'), 'View tab opens');
    check(await clickButton(menu, 'btn:occlusion'), 'occlusion toggle reachable');
    check(!(await page.evaluate(() => window.basementPlanner.occlusionOn)), 'occlusion can be turned off');
    await clickButton(menu, 'btn:occlusion');
    check(await page.evaluate(() => window.basementPlanner.occlusionOn), 'and back on');
  }

  // Pins: an outlet on a wall and a water heater on the floor.
  {
    check(await clickButton(menu, 'btn:tab-pins'), 'Pins tab opens');
    await clickButton(menu, 'btn:pin-outlet');
    const p0 = await plan();
    const w = p0.walls.find((x) => x.kind === 'new');
    const A = p0.nodes.find((n) => n.id === w.a);
    const B = p0.nodes.find((n) => n.id === w.b);
    // Near the far end of the wall (the door is nearer the middle).
    const mid = { x: (A.x + (B.x - A.x) * 0.85) * 0.0254, z: (A.y + (B.y - A.y) * 0.85) * 0.0254 };
    // Aim horizontally at the wall from 1 m away along its normal, at outlet height.
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const n = { x: -(B.y - A.y) / len, z: (B.x - A.x) / len };
    await page.evaluate(({ mid, n }) => {
      const c = window.__dev.controllers.right;
      c.position.set(mid.x + n.x, 0.31, mid.z + n.z);
      const t = [-n.x, 0, -n.z];
      const cx = t[1], cy = -t[0], cz = 0, ww = 1 - t[2];
      const l = Math.hypot(cx, cy, cz, ww) || 1;
      c.quaternion.set(cx / l, cy / l, cz / l, ww / l);
    }, { mid, n });
    await frames(6);
    await press('right');
    const p1 = await plan();
    const outlet = p1.markers.find((m) => m.type === 'outlet');
    check(!!outlet && outlet.wallId === w.id && outlet.z === 12, `outlet pinned to the wall at 12" (${outlet?.z})`);
    await clickButton(menu, 'btn:pin-water-heater');
    await aimDown('right', 2.5, -2);
    await frames(5);
    await press('right');
    const p2 = await plan();
    check(p2.markers.some((m) => m.type === 'water-heater' && m.z === 0), 'water heater pinned on the floor');
  }

  // X-ray: framing appears with studs and headers.
  {
    await clickButton(menu, 'btn:tab-view');
    check(await clickButton(menu, 'btn:mode-xray'), 'X-ray view button');
    const f = await page.evaluate(() => {
      const v = window.basementPlanner.view;
      return { members: v.framing.length, headers: v.framing.filter((m) => m.kind === 'header').length, text: window.basementPlanner.menu.panel.root.getObjectByName('btn:text-view') ? 'ok' : '' };
    });
    check(f.members > 20 && f.headers >= 1, `framing generated (${f.members} pieces, ${f.headers} headers)`);
    await page.evaluate(() => {
      const d = window.__dev;
      d.position.set(1, 1.7, 1.2);
    });
    await frames(10);
    await page.screenshot({ path: 'artifacts/e2e-xray.png' });
    await clickButton(menu, 'btn:mode-ghost');
    await page.evaluate(() => window.__dev.position.set(0, 1.6, 0));
    await frames(10);
  }

  // Rooms: draw a closed 2 m square, name it and give it a floor.
  {
    await clickButton(menu, 'btn:tab-build');
    await clickButton(menu, 'btn:tool-walls');
    for (const [x, z] of [[-3, 1], [-1, 1], [-1, 3], [-3, 3], [-3, 1]]) {
      await aimDown('right', x, z);
      await frames(5);
      await press('right');
    }
    check(await clickButton(menu, 'btn:tab-rooms'), 'Rooms tab opens');
    await aimDown('right', -2, 2);
    await frames(5);
    await press('right');
    const sel = await page.evaluate(() => window.basementPlanner.roomsTool.selectedId);
    check(!!sel, 'tapping inside the square selects a room');
    await clickButton(menu, 'btn:room-office');
    await clickButton(menu, 'btn:finish-lvp');
    const r = (await plan()).rooms.find((x) => x.id === sel);
    check(r && r.name === 'Office' && r.finish === 'lvp', `room named Office with LVP (${r?.name}, ${r?.finish})`);
    const desc = await page.evaluate(() => window.basementPlanner.roomsTool.describe());
    check(/Office: 3[6-9] sq ft/.test(desc), `room area shown (${desc})`);
    await clickButton(menu, 'btn:tab-build');
  }

  // Fine mode: hold the trigger, then move; the point moves at 1/4 speed.
  {
    await clickButton(menu, 'btn:tool-walls');
    await aimDown('right', 0.5, 1.0);
    await frames(5);
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 1));
    await page.waitForTimeout(700);
    await frames(5);
    // Tilt the ray ~5.7 degrees: at 1.2 m that is ~12 cm normally, ~3 cm in fine mode.
    await page.evaluate(() => {
      const c = window.__dev.controllers.right;
      const a = -Math.PI / 2 + 0.1;
      c.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
    });
    await frames(6);
    const phase = await page.evaluate(() => window.basementPlanner.hands.right.phase);
    check(phase === 'fine', `holding the trigger enters fine mode (phase=${phase})`);
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 0));
    await frames(4);
    const chainStart = await page.evaluate(() => window.basementPlanner.wallTool.chain[0]);
    const dz = chainStart ? chainStart.y - 1.0 / 0.0254 : NaN;
    check(Math.abs(dz) > 0.3 && Math.abs(dz) < 2.5, `fine mode moved the point ${dz.toFixed(2)}" instead of ~4.7"`);
    await page.evaluate(() => window.basementPlanner.wallTool.endChain());
  }

  // Two-point alignment: save references, knock the plan out of place, re-align.
  {
    check(await clickButton(menu, 'btn:tab-scan'), 'Room tab opens');
    check(await clickButton(menu, 'btn:tool-align'), 'Align tool selected');
    const corner = async (x, z) => {
      await aimDown('right', x, z);
      await frames(5);
      await press('right');
    };
    await corner(-1.5, 1.5);
    await corner(2.5, 1.5);
    let p2 = await plan();
    check(!!p2.reference, 'two clicks save the reference corners');
    const good = await page.evaluate(() => ({ ...window.basementPlanner.transform }));
    // Simulate a new session where the room anchor moved: shift + rotate the plan.
    await page.evaluate(() => window.basementPlanner.setTransform({ theta: 0.2, tx: 0.3, tz: -0.25 }));
    await frames(3);
    check(await clickButton(menu, 'btn:tool-align'), 'Align again');
    await corner(-1.5, 1.5);
    await corner(2.5, 1.5);
    const t = await page.evaluate(() => ({ ...window.basementPlanner.transform }));
    const errIn = Math.hypot(t.tx - good.tx, t.tz - good.tz) / 0.0254;
    check(Math.abs(t.theta - good.theta) < 0.002 && errIn < 0.5, `re-align restores the plan (offset ${errIn.toFixed(3)}", angle ${(t.theta - good.theta).toFixed(5)} rad)`);
    await clickButton(menu, 'btn:tab-build');
    await clickButton(menu, 'btn:tool-walls');
  }

  // Ceiling: drag a soffit, switch the ceiling type.
  {
    check(await clickButton(menu, 'btn:tab-ceiling'), 'Ceiling tab opens');
    check(await clickButton(menu, 'btn:tool-soffit'), 'Soffit tool');
    await aimDown('right', 0.5, 2.0);
    await frames(5);
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 1));
    await frames(3);
    for (let i = 1; i <= 5; i++) {
      await aimDown('right', 0.5 + i * 0.12, 2.0 + i * 0.06);
      await frames(2);
    }
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 0));
    await frames(4);
    const sf = (await plan()).soffits;
    check(sf.length === 1 && sf[0].bottom === 84, `soffit added at 7' (${sf.length})`);
    await clickButton(menu, 'btn:ceil-drop');
    // A room is still selected from the Rooms step, so the change applies to that room.
    const pc = await plan();
    const sel = await page.evaluate(() => window.basementPlanner.roomsTool.selectedId);
    const target = sel ? pc.rooms.find((r) => r.id === sel)?.ceilingType : pc.settings.ceilingType;
    check(target === 'drop' && pc.settings.showCeiling, `ceiling set to drop and shown (${sel ? 'selected room' : 'all rooms'})`);
    await clickButton(menu, 'btn:tab-build');
  }

  // Camera test (Chrome's fake camera stands in for the passthrough camera).
  {
    check(await clickButton(menu, 'btn:tab-scan'), 'Room tab opens');
    check(await clickButton(menu, 'btn:camtest'), 'Camera test button');
    const r = await page
      .waitForFunction(() => JSON.parse(localStorage.getItem('basement-planner:camera-probe:v1') || 'null'), null, { timeout: 25000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    const row = (n) => r?.rows.find((x) => x.name === n);
    check(!!row('Camera stream during AR')?.ok, `camera stream opens during the AR session (${row('Camera stream during AR')?.detail})`);
    check(!!row('Frame capture')?.ok && !!r?.thumb, `a frame is captured (${row('Frame capture')?.detail})`);
    check(!!row('Frame rate')?.ok, `frame rate measured (${row('Frame rate')?.detail})`);
    await clickButton(menu, 'btn:tab-build');
  }

  const anchorsSaved = await page.evaluate(() => !!localStorage.getItem('basement-planner:ref-anchors:v1'));
  check(anchorsSaved, 'reference corners are saved as persistent anchors');
  const goodT = await page.evaluate(() => ({ ...window.basementPlanner.transform }));

  // Autosave reaches localStorage.
  await page.waitForTimeout(700);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('basement-planner:plan:v1') || 'null'));
  check(saved && saved.walls.length >= 1 && saved.openings.length === 1, 'plan is autosaved to localStorage');

  await page.screenshot({ path: 'artifacts/e2e-xr.png' });

  // Reload: the plan comes back.
  await page.evaluate(() => window.__dev.activeSession?.end());
  await page.reload();
  await page.waitForSelector('#planner-dom');
  const after = await plan();
  check(after.walls.length === saved.walls.length && after.openings.length === 1, 'plan restores after a reload');
  // Next session: the plan is knocked out of place, and the anchors pull it back.
  await page.evaluate(() => window.basementPlanner.setTransform({ theta: 0.3, tx: 0.4, tz: -0.3 }));
  await page.click('#bp-enter');
  await page.waitForFunction(() => !!window.__dev.activeSession, null, { timeout: 15000 });
  await page.waitForFunction(
    (g) => {
      const t = window.basementPlanner.transform;
      return Math.abs(t.theta - g.theta) < 0.002 && Math.hypot(t.tx - g.tx, t.tz - g.tz) < 0.01;
    },
    goodT,
    { timeout: 8000 },
  ).then(() => check(true, 'saved anchors re-lock the plan in a new session'), () => check(false, 'saved anchors re-lock the plan in a new session'));
  await page.evaluate(() => window.__dev.activeSession?.end());
  await page.waitForTimeout(300);
  const stats = await page.locator('#bp-stats').innerText();
  check(new RegExp(`${after.walls.length}\\s*new walls`, 'i').test(stats.replace(/\n/g, ' ')), 'flat page shows plan stats');
  await page.screenshot({ path: 'artifacts/e2e-page.png' });
} catch (e) {
  console.error(e);
  failures++;
} finally {
  if (offlineHosts.length) console.log(`note: could not reach ${[...new Set(offlineHosts)].join(', ')} (offline sandbox)`);
  // The desktop emulator can't hit-test real surfaces without its synthetic-room module; the headset can.
  const relevant = errors.filter(
    (e) =>
      !/favicon|DevTools|WebGL|GPU stall|gl_|Synthethic Environment Module/i.test(e) &&
      !(offlineHosts.length && /ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_PROXY/.test(e)),
  );
  check(relevant.length === 0, `no page errors${relevant.length ? ':\n  ' + relevant.join('\n  ') : ''}`);
  await browser.close();
  server.httpServer.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
  process.exit(failures ? 1 : 0);
}
