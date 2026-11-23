import { planFromJson, planToJson } from './core/persistence.js';
import { exportDxf } from './core/exportDxf.js';
import { exportIfc } from './core/exportIfc.js';
import { FINISH_NAMES, renderPlanSvg, roomSummaries } from './core/plan2d.js';
import type { PlannerApp } from './xr/app.js';
import { SplatMaker } from './xr/splatMaker.js';

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
    #planner-dom label.check { display: flex; align-items: center; gap: 8px; font-size: 15px; opacity: 0.85; }
    #planner-dom label.check input { width: 22px; height: 22px; }
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
    <p class="sub">Lay out walls and doors in your real basement with Meta Quest. <span style="opacity:.6">Version ${__APP_VERSION__}</span></p>
    <div class="row"><button class="primary" id="bp-enter">Enter AR</button>
      <label class="check"><input type="checkbox" id="bp-large" /> Large space (no Quest boundary, walk the whole basement)</label></div>
    <p class="msg" id="bp-msg"></p>
    <div class="card">
      <h2>This plan</h2>
      <div class="stats" id="bp-stats"></div>
    </div>
    <div class="card" id="bp-rec-card" style="display:none">
      <div class="head">
        <h2>Scan recording</h2>
        <div class="row"><button class="small" id="bp-rec">Save scan recording</button></div>
      </div>
      <p class="sub" id="bp-rec-info"></p>
    </div>
    <div class="card" id="bp-splat-card">
      <div class="head">
        <h2>Photoreal splat</h2>
        <div class="row">
          <button class="small" id="bp-splat-make">Make splat on this headset</button>
          <button class="small" id="bp-splat-finish" style="display:none">Finish now</button>
          <button class="small" id="bp-splat-data">Save splat training set (.zip)</button>
          <button class="small" id="bp-splat-load">Load splat (.ply / .spz)</button>
          <input type="file" id="bp-splat-file" accept=".ply,.spz,.splat,.ksplat,.sog" style="display:none" />
        </div>
      </div>
      <p class="sub" id="bp-splat-info"></p>
    </div>
    <div class="card" id="bp-plan-card">
      <div class="head">
        <h2 id="bp-plan-title">Floor plan</h2>
        <div class="row">
          <button class="small" id="bp-print">Print / save PDF</button>
          <button class="small" id="bp-svg">Download SVG</button>
          <button class="small" id="bp-dxf" title="CAD drawing for AutoCAD, SketchUp, Fusion, LibreCAD">Download DXF</button>
          <button class="small" id="bp-ifc" title="3D building model for Revit, ArchiCAD, BlenderBIM and BIM viewers">Download IFC</button>
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
        <tr><td>Start</td><td>Run Space Setup in Quest settings first. In the app, Room &gt; Space Setup brings in its walls, doors and windows as your existing walls.</td></tr>
        <tr><td>Menu</td><td>Turn your left palm toward you (hands), or it sits above the left controller. Tabs: Room, Edit, Measure, View. Poke with your right index finger or point and pinch. X hides it.</td></tr>
        <tr><td>Correct a wall</td><td>Edit &gt; Select: pinch a corner and drag it. Tap a wall, then Snap to scan to slide it onto the real wall the room mesh shows (scan first: Room &gt; Scan).</td></tr>
        <tr><td>Add a missing wall</td><td>Edit &gt; Wall: pinch at each corner. Finish with A or Finish.</td></tr>
        <tr><td>Doors</td><td>Edit &gt; Door: pick a width, then point at a wall.</td></tr>
        <tr><td>Measure</td><td>Measure &gt; Tape: pinch two spots. Then Tape says... to enter what a real tape measure reads.</td></tr>
        <tr><td>Precise placement</td><td>Hold the pinch or trigger for half a second: fine mode moves the point at 1/4 speed.</td></tr>
        <tr><td>Switch tools fast</td><td>Controllers: flick the right thumbstick left or right.</td></tr>
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

  // The depth frames of your scan, as a file that replays through the scanner.
  const renderRec = () => {
    const rec = app.scan?.recorder;
    const n = rec?.count ?? 0;
    $('bp-rec-card').style.display = n ? '' : 'none';
    if (rec) $('bp-rec-info').textContent = `${n} depth frames (${Math.round(rec.seconds / 6) / 10} min of scanning), ${rec.photos.length} camera photos. Stays on this headset unless you save it. Clear the scan in the Room tab to start over.`;
  };
  setTimeout(renderRec, 1500);
  app.onSession((active) => {
    if (!active) renderRec();
  });
  $('bp-rec').onclick = async () => {
    const blob = await app.captureFile?.();
    if (!blob) return msg('Nothing recorded yet');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `basement-scan-${new Date().toISOString().slice(0, 16).replace(':', '')}.bpscan.gz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // Splats: the scan as a training set (photos lined up with the scan, its points to
  // start from), and loading a trained splat back to show over the room.
  const renderSplat = () => {
    const n = app.scan?.views.size ?? 0;
    const name = app.splat?.name;
    $('bp-splat-info').textContent =
      `${n} sharp photos from this session's scan${n < 8 ? ' (scan more to make a training set)' : ''}. ` +
      (name ? `Splat on this headset: ${name}. In the headset, the Mesh button shows it over the room.` : 'No splat yet. Make one here (it trains on this headset; it pauses while you are in the headset view), or train the zip elsewhere and load the .ply.');
    ($('bp-splat-data') as HTMLButtonElement).disabled = n < 8;
    ($('bp-splat-make') as HTMLButtonElement).disabled = n < 8 || maker.running || !SplatMaker.supported;
    if (!SplatMaker.supported) $('bp-splat-info').textContent += ' This browser has no WebGPU, so it cannot train here.';
  };
  const maker = app.splatMaker;
  $('bp-splat-make').onclick = async () => {
    const input = app.scan?.splatInput();
    if (!input) return msg('Scan the room with color on first (8 or more photos)');
    const btn = $('bp-splat-make') as HTMLButtonElement;
    btn.disabled = true;
    $('bp-splat-finish').style.display = '';
    let trainT0 = 0;
    try {
      const ply = await maker.make(input.views, input.seed, (p) => {
        if (p.phase === 'align') {
          $('bp-splat-info').textContent = `Lining up photos with the scan: ${p.step} of ${p.steps}. Keep this page open.`;
          return;
        }
        if (!trainT0) trainT0 = performance.now();
        const min = (performance.now() - trainT0) / 60000;
        const left = p.step ? (min / p.step) * (p.steps - p.step) : NaN;
        $('bp-splat-info').textContent =
          `Training the splat: step ${p.step} of ${p.steps}, ${Math.round(p.gaussians / 1000)}k splats` + (Number.isFinite(left) ? `, about ${Math.max(1, Math.round(left))} min left` : '') + '. Keep this page open.';
      });
      const name = `room-${new Date().toISOString().slice(0, 16).replace(':', '')}.ply`;
      await app.splat?.save(name, ply.buffer as ArrayBuffer);
      msg('Splat ready: in the headset, the Mesh button shows it over the room');
    } catch (err) {
      msg(`Splat training stopped: ${(err as Error).message}`);
    } finally {
      $('bp-splat-finish').style.display = 'none';
      renderSplat();
    }
  };
  $('bp-splat-finish').onclick = () => maker.finish();
  setTimeout(renderSplat, 1600);
  app.onSession((active) => {
    // Training and the headset view share the GPU: training waits while you're in there.
    app.splatMaker.pause(active);
    if (!active) renderSplat();
  });
  $('bp-splat-data').onclick = () => {
    const zip = app.scan?.splatData();
    if (!zip) return msg('Scan the room with color on first (8 or more photos)');
    download(zip as unknown as BlobPart, 'application/zip', 'splat-data.zip');
  };
  $('bp-splat-load').onclick = () => ($('bp-splat-file') as HTMLInputElement).click();
  ($('bp-splat-file') as HTMLInputElement).onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    await app.splat?.save(f.name, await f.arrayBuffer());
    msg(`Loaded ${f.name}: in the headset, the Mesh button shows it over the room`);
    renderSplat();
  };

  const download = (data: BlobPart, type: string, ext: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    const name = (app.store.plan.name || 'basement').replace(/[^\w-]+/g, '-').toLowerCase();
    a.download = `${name}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('bp-dxf').onclick = () => download(exportDxf(app.store.plan), 'application/dxf', 'dxf');
  $('bp-ifc').onclick = () => download(exportIfc(app.store.plan, { now: new Date() }), 'application/x-step', 'ifc');

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
  const large = $('bp-large') as HTMLInputElement;
  large.checked = app.largeSpace;
  large.onchange = () => app.setLargeSpace(large.checked);
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
    if (!confirm('Erase the plan, all walls, the scan and the scan recording? Export first if you want to keep them.')) return;
    app.startOver(true);
    renderRec();
    msg('Started over: plan and scan erased');
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
