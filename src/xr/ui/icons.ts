/**
 * Tiny vector icon set drawn with Canvas 2D on a 24x24 grid (no fonts or downloads).
 */
export type IconName =
  | 'walls'
  | 'door'
  | 'capture'
  | 'edit'
  | 'trash'
  | 'measure'
  | 'rooms'
  | 'pin'
  | 'scan'
  | 'eye'
  | 'undo'
  | 'redo'
  | 'flag'
  | 'align'
  | 'import'
  | 'xray'
  | 'exit'
  | 'thumbtack'
  | 'keypad'
  | 'height'
  | 'magnet'
  | 'build';

export function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const P = new Path2D();
  const line = (pts: number[]) => {
    P.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) P.lineTo(pts[i], pts[i + 1]);
  };
  const arc = (x: number, y: number, r: number, a0: number, a1: number, ccw = false) => {
    P.moveTo(x + r * Math.cos(a0), y + r * Math.sin(a0));
    P.arc(x, y, r, a0, a1, ccw);
  };
  let fill = false;
  switch (name) {
    case 'walls':
    case 'build':
      line([4, 20, 4, 4, 20, 4]);
      line([10, 20, 10, 10, 20, 10]);
      line([4, 20, 10, 20]);
      line([20, 4, 20, 10]);
      break;
    case 'door':
      line([5, 21, 5, 3, 19, 3, 19, 21]);
      line([5, 21, 14, 17]);
      line([14, 17, 14, 4]);
      P.moveTo(12, 12);
      P.arc(12, 12, 0.8, 0, Math.PI * 2);
      break;
    case 'capture':
      P.moveTo(19, 12);
      P.arc(12, 12, 7, 0, Math.PI * 2);
      line([12, 2, 12, 7]);
      line([12, 17, 12, 22]);
      line([2, 12, 7, 12]);
      line([17, 12, 22, 12]);
      P.moveTo(13.5, 12);
      P.arc(12, 12, 1.5, 0, Math.PI * 2);
      break;
    case 'edit':
      // four-way move arrows
      line([12, 3, 12, 21]);
      line([3, 12, 21, 12]);
      line([9, 6, 12, 3, 15, 6]);
      line([9, 18, 12, 21, 15, 18]);
      line([6, 9, 3, 12, 6, 15]);
      line([18, 9, 21, 12, 18, 15]);
      break;
    case 'trash':
      line([4, 6, 20, 6]);
      line([9, 6, 9, 3, 15, 3, 15, 6]);
      line([6, 6, 7, 21, 17, 21, 18, 6]);
      line([10, 10, 10, 17]);
      line([14, 10, 14, 17]);
      break;
    case 'measure':
      line([2, 16, 16, 2, 22, 8, 8, 22, 2, 16]);
      line([6, 12, 8, 14]);
      line([9, 9, 12, 12]);
      line([12, 6, 14, 8]);
      line([15, 3, 18, 6]);
      break;
    case 'rooms':
      line([3, 3, 21, 3, 21, 21, 3, 21, 3, 3]);
      line([12, 3, 12, 10]);
      line([12, 14, 12, 21]);
      line([12, 12, 21, 12]);
      break;
    case 'pin':
      P.moveTo(12, 22);
      P.bezierCurveTo(12, 22, 4, 14, 4, 9);
      P.arc(12, 9, 8, Math.PI, 0);
      P.bezierCurveTo(20, 14, 12, 22, 12, 22);
      P.moveTo(15, 9);
      P.arc(12, 9, 3, 0, Math.PI * 2);
      break;
    case 'scan':
      arc(12, 20, 4, Math.PI * 1.2, Math.PI * 1.8);
      arc(12, 20, 9, Math.PI * 1.2, Math.PI * 1.8);
      arc(12, 20, 14, Math.PI * 1.2, Math.PI * 1.8);
      P.moveTo(13, 20);
      P.arc(12, 20, 1, 0, Math.PI * 2);
      break;
    case 'eye':
      P.moveTo(2, 12);
      P.quadraticCurveTo(12, 2, 22, 12);
      P.quadraticCurveTo(12, 22, 2, 12);
      P.moveTo(15, 12);
      P.arc(12, 12, 3, 0, Math.PI * 2);
      break;
    case 'undo':
      arc(13, 13, 7, Math.PI * 1.15, Math.PI * 0.6, false);
      line([4, 5, 5.5, 10.5, 11, 9]);
      break;
    case 'redo':
      arc(11, 13, 7, -Math.PI * 0.15, Math.PI * 0.4, true);
      line([20, 5, 18.5, 10.5, 13, 9]);
      break;
    case 'flag':
      line([5, 22, 5, 3]);
      line([5, 4, 19, 4, 15, 9, 19, 14, 5, 14]);
      break;
    case 'align':
      P.moveTo(7, 17);
      P.arc(5, 17, 2, 0, Math.PI * 2);
      P.moveTo(21, 7);
      P.arc(19, 7, 2, 0, Math.PI * 2);
      line([7, 16, 17, 8]);
      line([3, 22, 3, 20]);
      line([21, 2, 21, 4]);
      break;
    case 'import':
      line([12, 3, 12, 15]);
      line([7, 10, 12, 15, 17, 10]);
      line([4, 17, 4, 21, 20, 21, 20, 17]);
      break;
    case 'xray':
      line([3, 3, 21, 3]);
      line([3, 21, 21, 21]);
      line([5, 3, 5, 21]);
      line([10, 3, 10, 21]);
      line([14, 3, 14, 21]);
      line([19, 3, 19, 21]);
      line([10, 9, 14, 9]);
      break;
    case 'exit':
      line([14, 3, 4, 3, 4, 21, 14, 21]);
      line([9, 12, 21, 12]);
      line([17, 8, 21, 12, 17, 16]);
      break;
    case 'thumbtack':
      line([9, 3, 15, 3]);
      line([10, 3, 10, 10, 7, 14, 17, 14, 14, 10, 14, 3]);
      line([12, 14, 12, 22]);
      break;
    case 'keypad':
      for (const y of [5, 12, 19]) for (const x of [5, 12, 19]) {
        P.moveTo(x + 1.6, y);
        P.arc(x, y, 1.6, 0, Math.PI * 2);
      }
      fill = true;
      break;
    case 'height':
      line([12, 3, 12, 21]);
      line([8, 7, 12, 3, 16, 7]);
      line([8, 17, 12, 21, 16, 17]);
      line([4, 3, 20, 3]);
      line([4, 21, 20, 21]);
      break;
    case 'magnet':
      P.moveTo(5, 4);
      P.lineTo(5, 12);
      P.arc(12, 12, 7, Math.PI, 0, true);
      P.lineTo(19, 4);
      line([5, 8, 9, 8]);
      line([15, 8, 19, 8]);
      line([9, 4, 9, 12]);
      P.arc(12, 12, 3, Math.PI, 0, true);
      P.lineTo(15, 4);
      break;
  }
  if (fill) ctx.fill(P);
  else ctx.stroke(P);
  ctx.restore();
}
