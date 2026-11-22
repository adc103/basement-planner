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
  {
    const over = await page.evaluate(() => window.basementPlanner.menu?.overflow ?? null);
    if (over) check(over.length === 0, `every menu row fits on the panel${over.length ? ` (overflow: ${over.join(', ')})` : ''}`);
  }
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

      // Slide the selected wall sideways by dragging it.
      const n0 = p3.nodes.find((n) => n.id === sw.a);
      // a quarter of the way along (the middle has the door in it)
      const wa = { x: (a3.x * 0.8 + b3.x * 0.2) * 0.0254, z: (a3.y * 0.8 + b3.y * 0.2) * 0.0254 };
      const pose = async (dz) =>
        page.evaluate(({ m0, dz }) => {
          // plan -> world through the plan root (the floor finder may have moved it)
          const r = window.basementPlanner.view.root;
          r.updateWorldMatrix(true, false);
          const e = r.matrixWorld.elements;
          const lx = m0.x, ly = 0.6, lz = m0.z;
          const m = { x: e[0] * lx + e[4] * ly + e[8] * lz + e[12], y: e[1] * lx + e[5] * ly + e[9] * lz + e[13], z: e[2] * lx + e[6] * ly + e[10] * lz + e[14] };
          const c = window.__dev.controllers.right;
          c.position.set(m.x + 0.6, m.y + 0.5, m.z + 0.6 + dz);
          const dx = -0.6, dy = -0.5, ddz = -0.6;
          const l = Math.hypot(dx, dy, ddz);
          const t = [dx / l, dy / l, ddz / l];
          const cx = t[1], cy = -t[0], cz = 0, ww = 1 - t[2];
          const n = Math.hypot(cx, cy, cz, ww);
          c.quaternion.set(cx / n, cy / n, cz / n, ww / n);
        }, { m0: wa, dz });
      await pose(0);
      await frames(6);
      await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 1));
      await frames(4);
      for (let i = 1; i <= 6; i++) {
        await pose(-0.05 * i);
        await frames(2);
      }
      await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 0));
      await frames(4);
      const p4 = await plan();
      const n1 = p4.nodes.find((n) => n.id === sw.a);
      const slid = n1 ? Math.hypot(n1.x - n0.x, n1.y - n0.y) : 0;
      check(slid > 8 && slid < 16 && p4.walls.length === p3.walls.length, `dragging a wall slides it sideways (${slid.toFixed(1)}")`);
      const und = await page.evaluate(() => window.basementPlanner.store.undoLabel);
      check(und === 'Slide wall', `wall slide is one undo step (${und})`);

      // Lock it from the Edit tab: the same drag now does nothing.
      check(await clickButton(menu, 'btn:e-lock'), 'Lock chip on the selected wall');
      let p5 = await plan();
      check(p5.walls.find((x) => x.id === sel)?.locked === true, 'wall is locked');
      await pose(0);
      await frames(6);
      await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 1));
      await frames(4);
      for (let i = 1; i <= 6; i++) {
        await pose(-0.05 * i);
        await frames(2);
      }
      await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 0));
      await frames(4);
      p5 = await plan();
      const n2 = p5.nodes.find((n) => n.id === sw.a);
      check(!!n2 && Math.hypot(n2.x - n1.x, n2.y - n1.y) < 1e-6, 'a locked wall can\'t be dragged');
      const viaCmd = await page.evaluate((id) => window.basementPlanner.cmd.exec('wall.setHeight', { id, height: 80 }, 'assistant'), sel);
      check(viaCmd.ok === false && /locked/.test(viaCmd.error), `commands refuse locked walls (${viaCmd.error})`);
      check(await clickButton(menu, 'btn:e-lock'), 'Unlock chip');
      p5 = await plan();
      check(p5.walls.find((x) => x.id === sel)?.locked === false, 'wall is unlocked');
      const j = await page.evaluate(() => window.basementPlanner.cmd.journal.map((e) => e.name));
      check(j.includes('wall.place') && j.includes('element.setLocked') && j.includes('wall.add'), `edits are journaled as commands (${[...new Set(j)].join(', ')})`);
    }
  }

  // Dimension tool: pick two parallel walls, type the hall width, keep it, then edit and check it holds.
  {
    check(await clickButton(menu, 'btn:tab-edit'), 'Edit tab for dimensions');
    check(await clickButton(menu, 'btn:tool-dimension'), 'Dimension tool tile');
    const ids = await page.evaluate(() => {
      const app = window.basementPlanner;
      const w1 = app.cmd.run('wall.add', { a: { x: 2000, y: 2000 }, b: { x: 2120, y: 2000 } });
      const w2 = app.cmd.run('wall.add', { a: { x: 2000, y: 2040 }, b: { x: 2120, y: 2040 } });
      app.dimTool.a = w1;
      app.dimTool.b = w2;
      app.menu.panel.refresh();
      return { w1, w2 };
    });
    await frames(3);
    check(await clickButton(menu, 'btn:d-type'), 'Type distance chip shows for parallel walls');
    await clickButton(keypad, 'btn:kclr');
    for (const k of ['3', '6']) await clickButton(keypad, `btn:k${k}`);
    await clickButton(keypad, 'btn:kok');
    const gap = () =>
      page.evaluate(({ w1, w2 }) => {
        // Clear distance from each end of wall 2 to wall 1's line (equal when parallel).
        const p = window.basementPlanner.store.plan;
        const ends = (id) => {
          const w = p.walls.find((x) => x.id === id);
          return [p.nodes.find((n) => n.id === w.a), p.nodes.find((n) => n.id === w.b), w.thickness];
        };
        const [a0, a1, ta] = ends(w1);
        const [b0, b1, tb] = ends(w2);
        const L = Math.hypot(a1.x - a0.x, a1.y - a0.y);
        const off = (q) => Math.abs((q.x - a0.x) * -(a1.y - a0.y) / L + (q.y - a0.y) * (a1.x - a0.x) / L) - (ta + tb) / 2;
        return { clear: off(b0), clear2: off(b1), slope: b1.y - b0.y };
      }, ids);
    let g = await gap();
    check(Math.abs(g.clear - 36) < 0.01, `typed 36 sets the clear distance (${g.clear.toFixed(3)}")`);
    check(await clickButton(menu, 'btn:d-keep'), 'Keep chip');
    const nKeep = await page.evaluate(() => window.basementPlanner.store.plan.constraints.length);
    check(nKeep === 1, 'the distance is kept as a lock');
    // Drag one end of the first wall: the second follows.
    await page.evaluate(({ w1 }) => {
      const app = window.basementPlanner;
      const n = app.store.plan.walls.find((w) => w.id === w1).b;
      app.cmd.run('node.move', { id: n, x: 2120, y: 1990 });
    }, ids);
    g = await gap();
    check(Math.abs(g.clear - 36) < 0.02 && Math.abs(g.clear2 - 36) < 0.02 && g.slope < -9, `the kept 36" holds when a wall moves (${g.clear.toFixed(3)}" and ${g.clear2.toFixed(3)}" at the two ends)`);
    const why = await page.evaluate(({ w1, w2 }) => {
      const app = window.basementPlanner;
      app.cmd.run('element.setLocked', { id: w2, locked: true });
      const n = app.store.plan.walls.find((w) => w.id === w1).a;
      const r = app.cmd.exec('node.move', { id: n, x: 2000, y: 1980 });
      app.cmd.run('element.delete', { id: w1 });
      app.cmd.run('element.setLocked', { id: w2, locked: false });
      app.cmd.run('element.delete', { id: w2 });
      return r;
    }, ids);
    check(!why.ok && /3' 0"/.test(why.error), `an edit that breaks the lock is refused with the reason (${why.error})`);
    await clickButton(menu, 'btn:tab-build');
  }

  // Box tool and push/pull: make a bench, then drag its end face out with the Select tool.
  {
    check(await clickButton(menu, 'btn:tab-build'), 'Build tab for boxes');
    check(await clickButton(menu, 'btn:tool-box'), 'Box tool tile');
    check(await clickButton(menu, 'btn:box-0'), 'Bench preset');
    const id = await page.evaluate(() =>
      window.basementPlanner.cmd.run('box.add', { poly: [{ x: 120, y: 100 }, { x: 168, y: 100 }, { x: 168, y: 118 }, { x: 120, y: 118 }], z1: 18, label: 'Bench' }),
    );
    check(!!id, 'bench added');
    check(await clickButton(menu, 'btn:tab-edit'), 'Edit tab for push/pull');
    check(await clickButton(menu, 'btn:tool-edit'), 'Select tool');
    // Aim the right controller at a point on the bench's end face (plan x = 168), from 0.7 m out.
    const aimAt = (px, py, pz) =>
      page.evaluate(({ px, py, pz }) => {
        const r = window.basementPlanner.view.root;
        r.updateWorldMatrix(true, false);
        const e = r.matrixWorld.elements;
        const lx = px * 0.0254, ly = pz * 0.0254, lz = py * 0.0254;
        const t = { x: e[0] * lx + e[4] * ly + e[8] * lz + e[12], y: e[1] * lx + e[5] * ly + e[9] * lz + e[13], z: e[2] * lx + e[6] * ly + e[10] * lz + e[14] };
        const ex = 168 * 0.0254 + 0.7, ey = 0.9, ez = 109 * 0.0254; // fixed controller spot (plan-local, root has no rotation here)
        const o = { x: e[0] * ex + e[4] * ey + e[8] * ez + e[12], y: e[1] * ex + e[5] * ey + e[9] * ez + e[13], z: e[2] * ex + e[6] * ey + e[10] * ez + e[14] };
        const c = window.__dev.controllers.right;
        c.position.set(o.x, o.y, o.z);
        const d = { x: t.x - o.x, y: t.y - o.y, z: t.z - o.z };
        const l = Math.hypot(d.x, d.y, d.z);
        const v = [d.x / l, d.y / l, d.z / l];
        // Rotate -z onto v.
        const ax = v[1], ay = -v[0], w = 1 - v[2];
        const n = Math.hypot(ax, ay, w);
        c.quaternion.set(ax / n, ay / n, 0, w / n);
      }, { px, py, pz });
    await aimAt(168, 109, 9);
    await frames(6);
    const hit = await page.evaluate(() => window.basementPlanner.editTool.hovered?.kind ?? null);
    check(hit === 'box', `the ray hits the bench (${hit ?? 'nothing'})`);
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 1));
    await frames(4);
    for (let i = 1; i <= 6; i++) {
      await aimAt(168 + i * 2, 109, 9);
      await frames(2);
    }
    await page.evaluate(() => window.__dev.controllers.right.updateButtonValue('trigger', 0));
    await frames(4);
    const b = await page.evaluate((id) => window.basementPlanner.store.plan.boxes.find((x) => x.id === id), id);
    const w = Math.max(...b.poly.map((p) => p.x)) - Math.min(...b.poly.map((p) => p.x));
    check(w > 54 && w < 64 && Math.min(...b.poly.map((p) => p.x)) === 120, `pulling the end face makes the bench longer, far end stays (${w.toFixed(2)}" long)`);
    const und = await page.evaluate(() => window.basementPlanner.store.undoLabel);
    check(und === 'Push/pull', `push/pull is one undo step (${und})`);
    await page.evaluate((id) => window.basementPlanner.cmd.run('element.delete', { id }), id);
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

  // Section plane and dollhouse (View tab).
  {
    check(await clickButton(menu, 'btn:tab-view'), 'View tab for section and dollhouse');
    const sec = await page.evaluate(() => {
      const app = window.basementPlanner;
      app.setSection({ a: { x: -80, y: -20 }, b: { x: 120, y: -20 }, keep: 1 });
      const mats = app.view.wallMeshes.map((m) => m.material);
      return { n: app.view.clip.length, shared: mats.every((m) => m.clippingPlanes === app.view.clip), enabled: app.world?.renderer?.localClippingEnabled ?? null };
    });
    check(sec.n === 1 && sec.shared, `a section plane clips every wall material (${sec.n} plane)`);
    // The kept side is left of the cut line (plan y > -20): check points either side.
    const side = await page.evaluate(() => {
      const app = window.basementPlanner;
      const root = app.view.root;
      root.updateWorldMatrix(true, false);
      const at = (x, y) => root.localToWorld(new (root.position.constructor)(x * 0.0254, 1, y * 0.0254));
      const pl = app.view.clip[0];
      return { kept: pl.distanceToPoint(at(20, 0)), cut: pl.distanceToPoint(at(20, -50)) };
    });
    check(side.kept > 0 && side.cut < 0, `the section keeps one side and cuts the other (${side.kept.toFixed(2)} / ${side.cut.toFixed(2)} m)`);
    check(await clickButton(menu, 'btn:sec-cut'), 'Cut 4 ft chip');
    const n2 = await page.evaluate(() => window.basementPlanner.view.clip.length);
    check(n2 === 2, `cut height adds a horizontal plane (${n2})`);
    await page.screenshot({ path: 'artifacts/e2e-section.png' });
    check(await clickButton(menu, 'btn:sec-cut'), 'Cut 4 ft off');
    check(await clickButton(menu, 'btn:sec-clear'), 'Clear section');
    const n3 = await page.evaluate(() => window.basementPlanner.view.clip.length);
    check(n3 === 0, 'section cleared');
    check(await clickButton(menu, 'btn:doll'), 'Dollhouse chip');
    await frames(4);
    const d = await page.evaluate(() => {
      const dh = window.basementPlanner.dollhouse;
      let meshes = 0;
      dh.group.traverse((o) => { if (o.isMesh && o.visible) meshes++; });
      const p = new (dh.group.position.constructor)();
      dh.group.getWorldPosition(p);
      return { shown: dh.shown, visible: dh.group.visible, meshes, y: p.y, scale: dh.scale };
    });
    check(d.shown && d.visible && d.meshes >= 3, `dollhouse shows the plan (${d.meshes} meshes, at ${d.y.toFixed(2)} m)`);
    check(await clickButton(menu, 'btn:doll-b'), 'Dollhouse Bigger');
    await frames(3);
    await page.screenshot({ path: 'artifacts/e2e-dollhouse.png' });
    check(await clickButton(menu, 'btn:doll'), 'Dollhouse off');
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

  // Scan basement: start/stop with depth (emulator may lack it), then detect from a synthetic room.
  {
    check(await clickButton(menu, 'btn:tab-scan'), 'Room tab opens for scanning');
    check(await clickButton(menu, 'btn:scan-depth'), 'Scan button starts a scan');
    await page.waitForTimeout(1200);
    const scanning = await page.evaluate(() => window.basementPlanner.scan.scanning);
    check(scanning, 'scan is running');
    // The emulator has no depth sensor: hand the room mesh a few frames of a flat wall 2 m ahead.
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
    check(tris > 1000, `depth frames build a live room mesh (${tris} triangles)`);
    // A real wall drawn 1.5" off that mesh wall: Check finds it, Fit to scan moves it onto it.
    {
      const r = await page.evaluate(() => {
        const app = window.basementPlanner;
        const face = 28 / 0.0254; // the flat wall's face, plan inches (it faces +y, so the wall sits on the -y side)
        const id = app.cmd.run('wall.add', { a: { x: 1110, y: face - 2.25 + 1.5 }, b: { x: 1250, y: face - 2.25 + 1.5 }, kind: 'existing', thickness: 4.5, height: 96 });
        const before = app.verifyWalls([id])?.[0]?.check.deviation ?? null;
        app.editTool.select({ kind: 'wall', id });
        app.fitSelectedToScan();
        const after = app.verifyWalls([id])?.[0]?.check.deviation ?? null;
        const w = app.store.plan.walls.find((x) => x.id === id);
        const undo = app.store.undoLabel;
        app.cmd.run('element.delete', { id });
        app.editTool.select(null);
        return { before, after, evidence: w?.evidence, undo };
      });
      check(r.before !== null && Math.abs(r.before - 1.5) < 0.5, `wall check measures the 1.5" error (${r.before?.toFixed(2)}")`);
      check(r.after !== null && r.after < 0.3 && r.evidence === 'measured', `Fit to scan puts it on the mesh (${r.after?.toFixed(2)}" off, ${r.evidence})`);
      check(r.undo === 'Fit to scan', `fit is one undo step (${r.undo})`);
    }
    // See-through: a real wall in front of that mesh wall opens as a window onto it.
    {
      // Stand where the fake depth camera stood (plan-root (30, 1.6, 30) m), facing the mesh wall.
      const headBefore = await page.evaluate(() => {
        const d = window.__dev;
        const before = { p: [d.position.x, d.position.y, d.position.z], q: [d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w] };
        const root = window.basementPlanner.view.root;
        root.updateWorldMatrix(true, false);
        const at = root.localToWorld(new (root.position.constructor)(30, 1.6, 30));
        d.position.set(at.x, at.y, at.z);
        d.quaternion.set(0, 0, 0, 1);
        return before;
      });
      await frames(4);
      const r = await page.evaluate(() => {
        const app = window.basementPlanner;
        const face = 28 / 0.0254;
        const id = app.cmd.run('wall.add', { a: { x: 1110, y: face + 40 }, b: { x: 1250, y: face + 40 }, kind: 'existing', thickness: 4.5, height: 96 });
        app.editTool.select({ kind: 'wall', id });
        const behind = app.meshBehind(id);
        app.toggleSeeThrough();
        const open = app.portals.has(id);
        const hidden = app.view.wallMeshes.find((m) => m.userData.wallId === id)?.visible === false;
        return { id, behind, open, hidden };
      });
      check(r.behind > 100, `mesh found behind the wall (${r.behind} points)`);
      check(r.open && r.hidden, 'See through opens the wall and hides its model');
      await frames(3);
      const t = await page.evaluate((id) => {
        const app = window.basementPlanner;
        const p = app.portals.portals.get(id);
        const V = app.view.root.position.constructor;
        const E = app.world.camera.getWorldPosition(new V());
        // Through the window's middle, a meter past the wall: inside every plane.
        const w = app.store.plan.walls.find((x) => x.id === id);
        const A = app.store.plan.nodes.find((n) => n.id === w.a), B = app.store.plan.nodes.find((n) => n.id === w.b);
        const mid = app.view.root.localToWorld(new V(((A.x + B.x) / 2) * 0.0254, 1.2, ((A.y + B.y) / 2) * 0.0254));
        const thru = mid.clone().sub(E).normalize().multiplyScalar(E.distanceTo(mid) + 1).add(E);
        const beside = app.view.root.localToWorld(new V(((A.x + B.x) / 2) * 0.0254 + 6, 1.2, ((A.y + B.y) / 2) * 0.0254 - 1));
        const inside = (q) => p.planes.every((pl) => pl.distanceToPoint(q) >= 0);
        return { mirrors: p.mirrors.size, thru: inside(thru), beside: inside(beside), near: inside(mid) };
      }, r.id);
      check(t.mirrors > 0, `the window draws the room mesh (${t.mirrors} chunks)`);
      await page.screenshot({ path: 'artifacts/e2e-seethrough.png' });
      check(t.thru && !t.beside && !t.near, `the view is cut to the window and to beyond the wall (through ${t.thru}, beside ${t.beside}, at the wall ${t.near})`);
      await page.evaluate(({ id, h }) => {
        const app = window.basementPlanner;
        app.toggleSeeThrough();
        app.cmd.run('element.delete', { id });
        app.editTool.select(null);
        window.__dev.position.set(...h.p);
        window.__dev.quaternion.set(...h.q);
      }, { id: r.id, h: headBefore });
      await frames(4);
    }
    const before = await page.evaluate(() => window.basementPlanner.store.plan.walls.length);
    // Paint a 20' x 14' box room 30 ft away from the drawn walls, so detection has real structure.
    await page.evaluate(() => {
      const m = window.basementPlanner.scan.map;
      const ox = 400, oy = 400, W = 240, D = 168, H = 96;
      for (let k = 0; k < 2; k++) {
        for (let x = 0; x <= W; x += 2) for (let z = 0; z <= H; z += 3) { m.add(ox + x, oy, z); m.add(ox + x, oy + D, z); }
        for (let y = 0; y <= D; y += 2) for (let z = 0; z <= H; z += 3) { m.add(ox, oy + y, z); m.add(ox + W, oy + y, z); }
        for (let x = 0; x <= W; x += 4) for (let y = 0; y <= D; y += 4) { m.add(ox + x, oy + y, 0); m.add(ox + x, oy + y, H); }
      }
    });
    check(await clickButton(menu, 'btn:scan-depth'), 'Scan button stops the scan');
    const rec = await page.evaluate(() => ({ n: window.basementPlanner.scan.recorder.count, depth: window.basementPlanner.scan.depthOk }));
    {
      const cap = await page.evaluate(() => {
        const app = window.basementPlanner;
        app.toggleDetailedCapture();
        const on = app.scan.sampler.width;
        const ex = app.captureExtras();
        app.toggleDetailedCapture();
        return { on, off: app.scan.sampler.width, keys: Object.keys(ex), version: ex.app.version, walls: ex.plan.walls.length };
      });
      check(cap.on === 160 && cap.off === 80, `Detailed capture switches depth to 160x120 and back (${cap.on} / ${cap.off})`);
      check(['app', 'device', 'plan', 'proposals', 'spaceSetup', 'journal'].every((k) => cap.keys.includes(k)) && cap.version && cap.version !== 'dev', `review capture carries the app state (${cap.keys.join(', ')}, version ${cap.version})`);
    }
    check(rec.depth ? rec.n > 0 : rec.n === 0, `scan recording follows depth (${rec.n} frames, depth ${rec.depth ? 'on' : 'off in the emulator'})`);
    await page.waitForFunction(() => window.basementPlanner.scan.reviewing, null, { timeout: 15000 }).catch(() => {});
    const found = await page.evaluate(() => window.basementPlanner.scan.count());
    check(found >= 4, `scan finds the walls (${found} items)`);
    const review = await page.evaluate(() => {
      const s = window.basementPlanner.scan;
      const n0 = s.count();
      s.toggle('walls:0');
      const n1 = s.count();
      s.toggle('walls:0');
      return { n0, n1, tool: window.basementPlanner.toolName };
    });
    check(review.n1 === review.n0 - 1 && review.tool === 'review', `clicking a found wall skips it (${JSON.stringify(review)})`);
    check(await clickButton(menu, 'btn:scan-kind-posts'), 'posts toggle chip');
    check(await clickButton(menu, 'btn:scan-accept'), 'Add found button');
    const after = await page.evaluate(() => window.basementPlanner.store.plan.walls.length);
    check(after - before >= 4, `scanned walls added to the plan (${after - before})`);
    await page.evaluate(() => window.basementPlanner.store.undo());
    await clickButton(menu, 'btn:tab-build');
  }

  // Whole-floor finish and ceiling, without walling in a room.
  {
    await page.evaluate(() => window.basementPlanner.roomsTool.select(null));
    check(await clickButton(menu, 'btn:tab-rooms'), 'Rooms tab opens');
    await page.evaluate(() => window.basementPlanner.roomsTool.select(null));
    check(await clickButton(menu, 'btn:finish-lvp'), 'whole-floor finish button');
    const ff = await page.evaluate(() => ({ f: window.basementPlanner.store.plan.settings.floorFinish, sel: window.basementPlanner.roomsTool.selectedRoom()?.finish ?? null, tool: window.basementPlanner.toolName }));
    check(ff.f === 'lvp', `whole floor set to LVP (${JSON.stringify(ff)})`);
    await page.evaluate(() => window.basementPlanner.store.edit('hide', (d) => { d.settings.showCeiling = false; }));
    check(await clickButton(menu, 'btn:tab-ceiling'), 'Ceiling tab opens again');
    check(await clickButton(menu, 'btn:ceil-open'), 'ceiling type button');
    check(await page.evaluate(() => window.basementPlanner.store.plan.settings.showCeiling), 'picking a ceiling type shows the ceiling');
    await clickButton(menu, 'btn:tab-build');
  }

  // Real walls: shown -> outlines -> hidden, via the View tab.
  {
    check(await clickButton(menu, 'btn:tab-view'), 'View tab opens');
    check(await clickButton(menu, 'btn:realwalls'), 'real walls display chip');
    const st1 = await page.evaluate(() => window.basementPlanner.store.plan.settings.realWalls);
    await clickButton(menu, 'btn:realwalls');
    const st2 = await page.evaluate(() => window.basementPlanner.store.plan.settings.realWalls);
    await clickButton(menu, 'btn:realwalls');
    check(st1 === 'outline' && st2 === 'hidden', `real walls cycle through outline and hidden (${st1}, ${st2})`);
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
