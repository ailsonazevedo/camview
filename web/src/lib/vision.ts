/**
 * Visão computacional mínima, no navegador, para a mira por clique.
 * Tudo em tons de cinza e em baixa resolução: rápido e suficiente para
 * medir deslocamentos de câmera e achar uma imagem dentro da outra.
 */

export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

/**
 * Captura o quadro atual do vídeo em cinza, já reduzido.
 * `crop`: metade do quadro (câmeras de duas lentes) ou null para o quadro todo.
 */
export function grabGray(video: HTMLVideoElement, crop: 'top' | 'bottom' | null, w: number, h: number): Gray | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sh = crop ? vh / 2 : vh;
  const sy = crop === 'bottom' ? vh / 2 : 0;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, sy, vw, sh, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  return blur({ w, h, data });
}

/** Desfoque 3×3 leve: tira ruído de compressão antes de comparar. */
function blur(img: Gray): Gray {
  const { w, h, data } = img;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += data[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return { w, h, data: out };
}

/** Reamostra para outro tamanho (bilinear). */
export function resize(img: Gray, w: number, h: number): Gray {
  const out = new Float32Array(w * h);
  const sx = (img.w - 1) / Math.max(1, w - 1);
  const sy = (img.h - 1) / Math.max(1, h - 1);
  for (let y = 0; y < h; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.w - 1, x0 + 1);
      const tx = fx - x0;
      const a = img.data[y0 * img.w + x0] * (1 - tx) + img.data[y0 * img.w + x1] * tx;
      const b = img.data[y1 * img.w + x0] * (1 - tx) + img.data[y1 * img.w + x1] * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return { w, h, data: out };
}

export interface Shift {
  /** Deslocamento em frações da largura/altura: b(x,y) ≈ a(x+dx, y+dy). */
  dx: number;
  dy: number;
  /** 0–1: quão melhor foi o melhor encaixe em relação ao típico. */
  confidence: number;
  /** O melhor encaixe ficou na borda da busca (movimento maior que o alcance). */
  atEdge: boolean;
}

/**
 * Mede quanto o conteúdo andou entre dois quadros da MESMA lente
 * (diferença absoluta média, sem a média de brilho, sobre a área em comum).
 */
export function estimateShift(a: Gray, b: Gray, maxFracX = 0.45, maxFracY = 0.45): Shift {
  const { w, h } = a;
  const mx = Math.round(w * maxFracX);
  const my = Math.round(h * maxFracY);
  let best = Infinity;
  let bx = 0;
  let by = 0;
  const costs: number[] = [];
  for (let dy = -my; dy <= my; dy++) {
    for (let dx = -mx; dx <= mx; dx++) {
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(w, w - dx);
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(h, h - dy);
      const n = (x1 - x0) * (y1 - y0);
      if (n < w * h * 0.3) continue;
      // médias da área em comum (tolerante a mudança de exposição)
      let sa = 0;
      let sb = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          sa += a.data[(y + dy) * w + x + dx];
          sb += b.data[y * w + x];
        }
      }
      const cnt = Math.ceil((x1 - x0) / 2) * Math.ceil((y1 - y0) / 2);
      const off = (sa - sb) / cnt;
      let cost = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          cost += Math.abs(a.data[(y + dy) * w + x + dx] - b.data[y * w + x] - off);
        }
      }
      cost /= cnt;
      costs.push(cost);
      if (cost < best) {
        best = cost;
        bx = dx;
        by = dy;
      }
    }
  }
  costs.sort((p, q) => p - q);
  const median = costs[Math.floor(costs.length / 2)] || 1;
  return {
    dx: bx / w,
    dy: by / h,
    confidence: Math.max(0, Math.min(1, 1 - best / median)),
    atEdge: Math.abs(bx) >= mx - 1 || Math.abs(by) >= my - 1,
  };
}

export interface Match {
  /** Retângulo em frações da imagem maior. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Correlação normalizada (−1 a 1). Acima de ~0.5 é um encaixe confiável. */
  score: number;
}

/**
 * Procura `tpl` (já no tamanho certo) dentro de `img` por correlação
 * normalizada (ZNCC) — insensível a diferenças de brilho/contraste entre os
 * dois sensores.
 */
export function locate(img: Gray, tpl: Gray): Match | null {
  const { w, h, data } = img;
  const tw = tpl.w;
  const th = tpl.h;
  if (tw > w || th > h || tw < 4 || th < 4) return null;
  const n = tw * th;

  let tMean = 0;
  for (let i = 0; i < n; i++) tMean += tpl.data[i];
  tMean /= n;
  const t = new Float32Array(n);
  let tVar = 0;
  for (let i = 0; i < n; i++) {
    t[i] = tpl.data[i] - tMean;
    tVar += t[i] * t[i];
  }
  if (tVar < 1e-6) return null;

  // imagens integrais para soma e soma dos quadrados de cada janela
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }

  let best = -2;
  let bx = 0;
  let by = 0;
  for (let y = 0; y <= h - th; y++) {
    for (let x = 0; x <= w - tw; x++) {
      const s = sum[(y + th) * W + x + tw] - sum[y * W + x + tw] - sum[(y + th) * W + x] + sum[y * W + x];
      const q = sq[(y + th) * W + x + tw] - sq[y * W + x + tw] - sq[(y + th) * W + x] + sq[y * W + x];
      const iVar = q - (s * s) / n;
      if (iVar < 1e-6) continue;
      let cross = 0;
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * w + x;
        const trow = ty * tw;
        for (let tx = 0; tx < tw; tx++) cross += data[row + tx] * t[trow + tx];
      }
      const score = cross / Math.sqrt(iVar * tVar);
      if (score > best) {
        best = score;
        bx = x;
        by = y;
      }
    }
  }
  return { x: bx / w, y: by / h, w: tw / w, h: th / h, score: best };
}

/** Procura a imagem da lente móvel dentro da fixa testando vários tamanhos. */
export function locateMultiScale(fixed: Gray, ptz: Gray, scales: number[]): (Match & { scale: number }) | null {
  let best: (Match & { scale: number }) | null = null;
  for (const s of scales) {
    const tw = Math.round(fixed.w * s);
    const th = Math.round(fixed.h * s);
    const m = locate(fixed, resize(ptz, tw, th));
    if (m && (!best || m.score > best.score)) best = { ...m, scale: s };
  }
  return best;
}
