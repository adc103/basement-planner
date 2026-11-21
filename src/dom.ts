import { planFromJson, planToJson } from './core/persistence.js';
import { createEmptyPlan } from './core/plan.js';
import { FINISH_NAMES, renderPlanSvg, roomSummaries } from './core/plan2d.js';
import type { PlannerApp } from './xr/app.js';

/**
 * The flat page shown outside the headset session: enter AR, export/import,
 * start over, and a short controls guide.
 */
export function mountDom(app: PlannerApp): void {
  const el = document.createElement('div');
  el.id = 'planner-dom';
  el.innerHTML = `
  <style>
    #planner-dom { position: fixed; inset: 0; overflow: auto; background: #10141b; color: #e6edf5;
      font: 16px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; z-index: 10; }
    #planner-dom main { max-width: 760px; margin: 0 auto; padding: 32px 20px 60px; }
    #planner-dom h1 { font-size: 28px; margin: 0 0 4px; }
    #planner-dom .sub { color: #9fb0c3; margin: 0 0 24px; }
    #planner-dom .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
    #planner-dom button { font: inherit; font-weight: 600; padding: 12px 18px; border-radius: 10px; border: 0;
      background: #2a3240; color: #fff; cursor: pointer; }
    #planner-dom button.primary { background: #2f86e6; font-size: 20px; padding: 16px 28px; }
    #planner-dom button.danger { background: #5a2525; }
    #planner-dom button:disabled { opacity: .5; cursor: default; }
    #planner-dom .card { background: #18202b; border-radius: 12px; padding: 16px 18px; margin: 18px 0; }
    #planner-dom .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
    #planner-dom .stat b { display: block; font-size: 22px; }
    #planner-dom .stat span { color: #9fb0c3; font-size: 13px; }
    #planner-dom table { border-collapse: collapse; width: 100%; font-size: 15px; }
    #planner-dom td { padding: 6px 4px; border-top: 1px solid #263142; vertical-align: top; }
    #planner-dom td:first-child { color: #9fb0c3; white-space: nowrap; padding-right: 14px; }
    #planner-dom .msg { color: #ffd479; min-height: 1.4em; }
    #planner-dom h2 { font-size: 18px; margin: 0 0 8px; }
    #planner-dom .plan-wrap { background: #fff; border-radius: 8px; overflow: auto; max-height: 70vh; }
    #planner-dom .plan-wrap svg { width: 100%; height: auto; display: block; }
    #planner-dom .rooms td:nth-child(2), #planner-dom .rooms td:nth-child(3) { color: #e6edf5; }
    #planner-dom .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
    #planner-dom .head .row { margin: 0; }
    #planner-dom button.small { padding: 8px 12px; font-size: 14px; }
    @media print {
      body > *:not(#planner-dom) { display: none !important; }
      #planner-dom { position: static; background: #fff; color: #000; overflow: visible; }
      #planner-dom main > *:not(#bp-plan-card) { display: none !important; }
      #planner-dom .card { background: #fff; padding: 0; }
      #planner-dom .head .row, #planner-dom .no-print { display: none !important; }
      #planner-dom .plan-wrap { max-height: none; overflow: visible; }
      #planner-dom .rooms td { color: #000 !important; border-color: #ccc; }
      #planner-dom h2 { color: #000; }
    }
  </style>
  <main>
    <h1>Basement Planner</h1>
    <p class="sub">Lay out walls and doors in your real basement with Meta Quest.</p>
    <div class="row"><button class="primary" id="bp-enter">Enter AR</button></div>
    <p class="msg" id="bp-msg"></p>
    <div class="card">
      <h2>This plan</h2>
      <div class="stats" id="bp-stats"></div>
    </div>
    <div class="card" id="bp-plan-card">
      <div class="head">
        <h2 id="bp-plan-title">Floor plan</h2>
        <div class="row">
          <button class="small" id="bp-print">Print / save PDF</button>
          <button class="small" id="bp-svg">Download SVG</button>
        </div>
      </div>
      <div class="plan-wrap" id="bp-plan"></div>
      <table class="rooms" id="bp-rooms"></table>
    </div>
    <div class="row">
      <button id="bp-export">Export plan (.json)</button>
      <button id="bp-import">Import plan</button>
      <button class="danger" id="bp-new">Start over</button>
      <input type="file" id="bp-file" accept="application/json,.json" hidden />
    </div>
    <div class="card">
      <h2>Controls</h2>
      <table>
        <tr><td>Place a corner</td><td>Pinch (hands) or trigger (controllers), aimed at the floor. The point is placed when you let go.</td></tr>
        <tr><td>Precise placement</td><td>Hold the pinch or trigger for half a second: fine mode moves the point at 1/4 speed.</td></tr>
        <tr><td>Finish a chain</td><td>Place the same spot twice, close the loop, press A, or tap Finish.</td></tr>
        <tr><td>Menu</td><td>Turn your left palm toward you (hands), or it sits above the left controller. Tabs on the left: Build, Edit, Measure, Rooms, Room scan, View. Poke with your right index finger or point and pinch. X hides it.</td></tr>
        <tr><td>Switch tools fast</td><td>Controllers: flick the right thumbstick left or right.</td></tr>
        <tr><td>Move things</td><td>Edit &gt; Select: pinch a corner and drag. Drag a door along its wall. Tap a wall to change its length, height or 2x4/2x6.</td></tr>
        <tr><td>Measure</td><td>Measure &gt; Tape: pinch two spots on the floor or on walls.</td></tr>
        <tr><td>Rooms</td><td>Rooms tab: tap inside a closed area, then pick a name and floor finish.</td></tr>
        <tr><td>Walls the scan missed</td><td>Build &gt; Capture: tap a real wall and the app finds its full length from the room mesh (tap again to add). Or hold the pinch and sweep along the wall, then let go.</td></tr>
        <tr><td>Undo</td><td>Menu Undo, or B / Y on controllers.</td></tr>
        <tr><td>Exact length</td><td>Menu Length... then type, e.g. <code>10'4 1/2</code>. A bare number is inches.</td></tr>
        <tr><td>Wall height</td><td>Menu H..., or the right thumbstick up/down (1" steps).</td></tr>
        <tr><td>Room scan</td><td>Your Quest Space Setup (walls, ceiling height, furniture boxes) loads automatically. New walls snap 1" off foundation walls and to object corners.</td></tr>
        <tr><td>Coming back later</td><td>The plan normally reappears in place. If not: Align, then click Ref 1 and Ref 2 (the two floor corners you saved the first time).</td></tr>
      </table>
    </div>
  </main>`;
  document.body.appendChild(el);

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>(`#${id}`)!;
  const msg = (t: string) => ($('bp-msg').textContent = t);

  const render = () => {
    const s = app.status();
    $('bp-stats').innerHTML = [
      [s.walls, 'new walls'],
      [`${s.linearFeet.toFixed(1)} ft`, 'of new wall'],
      [s.openings, 'doors / openings'],
      [s.existing, 'scanned walls'],
      [s.savedAt ?? (s.restored ? 'restored' : 'not yet'), 'last saved'],
    ]
      .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`)
      .join('');
  };
  let lastPlan: unknown = null;
  const renderPlan = () => {
    const plan = app.store.plan;
    if (plan === lastPlan) return;
    lastPlan = plan;
    $('bp-plan-title').textContent = `Floor plan: ${plan.name}`;
    $('bp-plan').innerHTML = renderPlanSvg(plan);
    const rooms = roomSummaries(plan);
    const totals = new Map<string, number>();
    for (const r of rooms) if (r.finish !== 'none') totals.set(FINISH_NAMES[r.finish], (totals.get(FINISH_NAMES[r.finish]) ?? 0) + r.areaSqFt);
    $('bp-rooms').innerHTML = rooms.length
      ? `<tr><td>Room</td><td>Area</td><td>Floor</td></tr>` +
        rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.areaSqFt.toFixed(0)} sq ft</td><td>${FINISH_NAMES[r.finish]}</td></tr>`).join('') +
        [...totals].map(([f, a]) => `<tr><td>Total ${esc(f)}</td><td>${a.toFixed(0)} sq ft</td><td>+10% waste: ${(a * 1.1).toFixed(0)}</td></tr>`).join('')
      : `<tr><td colspan="3">Name rooms in the headset (Rooms tab) to list them here.</td></tr>`;
  };
  app.onChange(() => {
    render();
    renderPlan();
  });
  render();
  renderPlan();

  $('bp-print').onclick = () => window.print();
  $('bp-svg').onclick = () => {
    const blob = new Blob([renderPlanSvg(app.store.plan, { title: app.store.plan.name })], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `basement-plan-${new Date().toISOString().slice(0, 10)}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const enter = $<HTMLButtonElement>('bp-enter');
  if (!navigator.xr) {
    enter.disabled = true;
    msg('WebXR is not available in this browser. Open this page in the Meta Quest Browser.');
  } else {
    navigator.xr
      .isSessionSupported('immersive-ar')
      .then((ok) => {
        if (!ok) {
          enter.disabled = true;
          msg('This browser does not support AR sessions. Open this page in the Meta Quest Browser.');
        }
      })
      .catch(() => {});
  }
  enter.onclick = () => {
    msg('');
    app.enterAR();
  };

  $('bp-export').onclick = () => {
    app.saveNow();
    const blob = new Blob([planToJson(app.store.plan)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `basement-plan-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const file = $<HTMLInputElement>('bp-file');
  $('bp-import').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const plan = planFromJson(await f.text());
      if (app.store.plan.walls.length && !confirm('Replace the current plan with this file?')) return;
      app.loadPlan(plan);
      msg(`Loaded ${f.name}`);
    } catch (e) {
      msg((e as Error).message);
    }
  };

  $('bp-new').onclick = () => {
    if (!confirm('Delete this plan and start over? Export it first if you want to keep it.')) return;
    app.loadPlan(createEmptyPlan());
    msg('Started a new plan');
  };

  function esc(t: string): string {
    return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  }

  // Hide the page while immersive (the headset hides it anyway; emulators don't).
  app.onSession((active) => {
    el.style.display = active ? 'none' : '';
    render();
  });
}
