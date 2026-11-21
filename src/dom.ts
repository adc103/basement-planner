import { planFromJson, planToJson } from './core/persistence.js';
import { createEmptyPlan } from './core/plan.js';
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
        <tr><td>Menu</td><td>Turn your left palm toward you (hands), or it sits above the left controller. Poke buttons with your right index finger or point and pinch. X hides it.</td></tr>
        <tr><td>Undo</td><td>Menu Undo, or B / Y on controllers.</td></tr>
        <tr><td>Exact length</td><td>Menu Length... then type, e.g. <code>10'4 1/2</code>. A bare number is inches.</td></tr>
        <tr><td>Wall height</td><td>Menu H..., or the right thumbstick up/down (1" steps).</td></tr>
        <tr><td>Foundation walls</td><td>Import scan pulls in walls from your Quest Space Setup. New walls snap 1" off them.</td></tr>
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
  app.onChange(render);
  render();

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

  // Hide the page while immersive (the headset hides it anyway; emulators don't).
  app.onSession((active) => {
    el.style.display = active ? 'none' : '';
    render();
  });
}
