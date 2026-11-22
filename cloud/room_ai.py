"""
Room AI: runs SpatialLM on a scanned point cloud and returns walls, doors,
windows and furniture boxes. Deployed to Modal by .github/workflows/room-ai.yml.

Endpoints (all need the X-Key header, or ?key=, matching the ROOM_AI_KEY secret):
  GET  /          upload page
  POST /layout    body: an ASCII or binary .ply (meters, z up). Returns JSON.

SpatialLM (https://github.com/manycore-research/SpatialLM) is licensed for
non-commercial use (its point encoder is CC-BY-NC-4.0). Runs on an A10G GPU.
"""

import os

import modal

SPATIALLM_COMMIT = "8913c44d84a450c53e9340b13317f8cf7144a738"
MODEL_ID = "manycore-research/SpatialLM1.1-Qwen-0.5B"
MODEL_DIR = "/models/spatiallm"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libgomp1", "libglib2.0-0")
    .pip_install("torch==2.4.1", "torchvision==0.19.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install("torch-scatter", find_links="https://data.pyg.org/whl/torch-2.4.0+cu124.html")
    .pip_install(
        "transformers==4.46.1",
        "tokenizers==0.20.3",
        "huggingface_hub==0.26.2",
        "safetensors==0.4.5",
        "numpy==1.26.4",
        "scipy==1.15.2",
        "scikit-learn==1.6.1",
        "pandas==2.2.3",
        "einops==0.8.1",
        "toml",
        "shapely==2.0.7",
        "bbox==0.9.4",
        "terminaltables",
        "open3d==0.18.0",
        "addict",
        "timm",
        "spconv-cu120",
        "fastapi[standard]",
    )
    .run_commands(
        f"git clone https://github.com/manycore-research/SpatialLM.git /opt/SpatialLM && cd /opt/SpatialLM && git checkout {SPATIALLM_COMMIT}",
        f"python -c \"from huggingface_hub import snapshot_download; snapshot_download('{MODEL_ID}', local_dir='{MODEL_DIR}')\"",
    )
    .env({"PYTHONPATH": "/opt/SpatialLM"})
)

app = modal.App("room-ai")
secret = modal.Secret.from_name("room-ai")


@app.cls(image=image, gpu="A10G", timeout=600, scaledown_window=120)
class SpatialLM:
    @modal.enter()
    def load(self):
        import torch
        import spatiallm.model.sonata_encoder as se

        # FlashAttention needs a build step and newer GPUs; the plain attention path is fine here.
        orig = se.Sonata.__init__

        def init(s, *a, **k):
            k["enable_flash"] = False
            orig(s, *a, **k)

        se.Sonata.__init__ = init

        from transformers import AutoModelForCausalLM, AutoTokenizer
        import spatiallm  # noqa: F401  registers the model classes

        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
        self.model = AutoModelForCausalLM.from_pretrained(MODEL_DIR, torch_dtype=torch.bfloat16)
        self.model.to("cuda")
        self.model.set_point_backbone_dtype(torch.float32)
        self.model.eval()

    @modal.method()
    def layout(self, ply: bytes, detect: str = "all", seed: int = 0) -> dict:
        import dataclasses
        import sys
        import tempfile
        import time

        import numpy as np

        sys.path.insert(0, "/opt/SpatialLM")
        from inference import generate_layout, preprocess_point_cloud
        from spatiallm import Layout
        from spatiallm.pcd import cleanup_pcd, get_points_and_colors, load_o3d_pcd

        t0 = time.time()
        with tempfile.NamedTemporaryFile(suffix=".ply") as f:
            f.write(ply)
            f.flush()
            pcd = load_o3d_pcd(f.name)
        n_in = len(pcd.points)
        num_bins = self.model.config.point_config["num_bins"]
        grid = Layout.get_grid_size(num_bins)
        pcd = cleanup_pcd(pcd, voxel_size=grid)
        points, colors = get_points_and_colors(pcd)
        min_extent = np.min(points, axis=0)
        tensor = preprocess_point_cloud(points, colors, grid, num_bins)
        layout = generate_layout(
            self.model,
            tensor,
            self.tokenizer,
            "/opt/SpatialLM/code_template.txt",
            seed=seed,
            detect_type=detect,
        )
        layout.translate(min_extent)

        def rows(items):
            return [{k: (float(v) if isinstance(v, (float, np.floating)) else v) for k, v in dataclasses.asdict(e).items()} for e in items]

        return {
            "model": MODEL_ID,
            "points_in": n_in,
            "points_used": int(len(points)),
            "seconds": round(time.time() - t0, 1),
            "walls": rows(layout.walls),
            "doors": rows(layout.doors),
            "windows": rows(layout.windows),
            "boxes": rows(layout.bboxes),
            "text": layout.to_language_string(),
        }


web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(image=web_image, secrets=[secret], timeout=900)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def web():
    import hmac

    from fastapi import FastAPI, Header, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import HTMLResponse

    api = FastAPI()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["https://adc103.github.io", "http://localhost:8081", "https://localhost:8081"],
        allow_methods=["GET", "POST"],
        allow_headers=["X-Key", "Content-Type"],
    )
    want = os.environ["ROOM_AI_KEY"]

    def check(key: str | None):
        if not key or not hmac.compare_digest(key, want):
            raise HTTPException(401, "Wrong or missing key")

    @api.get("/", response_class=HTMLResponse)
    def page():
        return PAGE

    @api.post("/layout")
    async def layout(request: Request, x_key: str | None = Header(None), key: str | None = None, detect: str = "all", seed: int = 0):
        check(x_key or key)
        body = await request.body()
        if len(body) < 100 or len(body) > 60_000_000:
            raise HTTPException(400, "Send a .ply point cloud as the request body")
        if detect not in ("all", "arch", "object"):
            raise HTTPException(400, "detect must be all, arch or object")
        return await SpatialLM().layout.remote.aio(body, detect, seed)

    return api


@app.local_entrypoint()
def selftest():
    """Runs the model on one of SpatialLM's own test scenes, to prove the install works."""
    from huggingface_hub import hf_hub_download

    path = hf_hub_download("manycore-research/SpatialLM-Testset", "pcd/scene0000_00.ply", repo_type="dataset")
    with open(path, "rb") as f:
        res = SpatialLM().layout.remote(f.read(), "all", 0)
    print(f"selftest: {len(res['walls'])} walls, {len(res['doors'])} doors, {len(res['windows'])} windows, {len(res['boxes'])} boxes in {res['seconds']} s from {res['points_used']} points")
    assert res["walls"], "no walls found"


PAGE = """<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<title>Room AI</title><style>
body{font:15px system-ui;margin:16px;background:#111;color:#eee}input,button,select{font:inherit;margin:4px 0;padding:8px}
button{background:#3b82f6;color:#fff;border:0;border-radius:6px}svg{background:#fff;width:100%;max-width:900px;border-radius:6px}
pre{white-space:pre-wrap;font-size:12px;color:#aaa}#msg{color:#facc15}
</style></head><body>
<h2>Room AI (SpatialLM)</h2>
<p>Pick a .ply from the planner's "Point cloud (.ply)" button. The first run takes a minute or two while a GPU starts.</p>
<div><input id=key type=password placeholder="Key"></div>
<div><input id=file type=file accept=".ply"></div>
<div><select id=detect><option value=all>Walls, doors, windows, furniture</option><option value=arch>Walls, doors, windows only</option></select>
<button id=go>Find the layout</button></div>
<p id=msg></p><svg id=svg viewBox="0 0 10 10"></svg><pre id=out></pre>
<script>
const $=id=>document.getElementById(id);
$('key').value=localStorage.getItem('roomAiKey')||'';
function parsePly(buf){
  const head=new TextDecoder().decode(new Uint8Array(buf,0,Math.min(buf.byteLength,2000)));
  const end=head.indexOf('end_header')+11;const n=+(/element vertex (\\d+)/.exec(head)||[0,0])[1];
  const pts=[];if(!/format ascii/.test(head)){return pts}
  const lines=new TextDecoder().decode(new Uint8Array(buf,end)).split('\\n');
  const step=Math.max(1,Math.floor(n/20000));
  for(let i=0;i<lines.length;i+=step){const v=lines[i].split(' ').map(Number);if(v.length>=3&&v[2]>0.3&&v[2]<2.0)pts.push(v)}
  return pts;
}
function draw(pts,res){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;for(const p of pts){x0=Math.min(x0,p[0]);x1=Math.max(x1,p[0]);y0=Math.min(y0,p[1]);y1=Math.max(y1,p[1])}
  for(const w of res.walls){x0=Math.min(x0,w.ax,w.bx);x1=Math.max(x1,w.ax,w.bx);y0=Math.min(y0,w.ay,w.by);y1=Math.max(y1,w.ay,w.by)}
  const pad=0.3;$('svg').setAttribute('viewBox',`${x0-pad} ${-(y1+pad)} ${x1-x0+2*pad} ${y1-y0+2*pad}`);
  let s='';for(const p of pts)s+=`<circle cx="${p[0]}" cy="${-p[1]}" r="0.01" fill="#bbb"/>`;
  for(const w of res.walls)s+=`<line x1="${w.ax}" y1="${-w.ay}" x2="${w.bx}" y2="${-w.by}" stroke="#dc2626" stroke-width="${Math.max(w.thickness,0.03)}" opacity=".85"/>`;
  for(const d of res.doors)s+=`<circle cx="${d.position_x}" cy="${-d.position_y}" r="${d.width/2}" fill="none" stroke="#0891b2" stroke-width="0.04"/>`;
  for(const d of res.windows)s+=`<circle cx="${d.position_x}" cy="${-d.position_y}" r="${d.width/2}" fill="none" stroke="#16a34a" stroke-width="0.04"/>`;
  for(const b of res.boxes){s+=`<g transform="translate(${b.position_x} ${-b.position_y}) rotate(${-b.angle_z*180/Math.PI})"><rect x="${-b.scale_x/2}" y="${-b.scale_y/2}" width="${b.scale_x}" height="${b.scale_y}" fill="#a855f733" stroke="#a855f7" stroke-width="0.02"/></g>`}
  $('svg').innerHTML=s;
}
$('go').onclick=async()=>{
  const f=$('file').files[0];if(!f){$('msg').textContent='Pick a .ply first';return}
  localStorage.setItem('roomAiKey',$('key').value);
  $('msg').textContent='Working... (first run starts a GPU, up to a few minutes)';$('out').textContent='';
  const buf=await f.arrayBuffer();const t=Date.now();
  try{
    const r=await fetch('layout?detect='+$('detect').value,{method:'POST',headers:{'X-Key':$('key').value},body:buf});
    if(!r.ok)throw new Error(r.status+' '+(await r.text()));
    const res=await r.json();
    $('msg').textContent=`${res.walls.length} walls, ${res.doors.length} doors, ${res.windows.length} windows, ${res.boxes.length} objects. Model ${res.seconds}s, total ${Math.round((Date.now()-t)/1000)}s. Red walls, blue doors, green windows, purple objects.`;
    draw(parsePly(buf),res);$('out').textContent=res.text;
  }catch(e){$('msg').textContent='Failed: '+e.message}
};
</script></body></html>"""
