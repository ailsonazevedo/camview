import { api, type Camera, type PtzCalibration, type PtzDirection } from './api';
import { estimateShift, type Gray, grabGray, locate, locateMultiScale, type Match, resize } from './vision';

/**
 * Mira por clique, sem depender de comando proprietário: o navegador mede
 * quanto a imagem anda por segundo em cada sentido (calibração) e converte o
 * clique em pulsos de movimento, conferindo o resultado pela imagem.
 *
 * Convenção: "deslocamento" (dx, dy) = quanto o CONTEÚDO da imagem andou para
 * a esquerda/para cima, em frações da largura/altura. Girar para a direita
 * gera dx > 0; para centralizar um ponto à direita do centro, queremos dx > 0.
 */

const SHIFT_W = 96;
const SHIFT_H = 54;
const LOCATE_W = 128;
const LOCATE_H = 72;
const SETTLE_MS = 1200; // latência do vídeo + parada do motor
const CAL_SPEED = 5;
const MIN_PULSE_MS = 60;
const MAX_PULSE_MS = 5000;
/** Abaixo disso o ponto já é considerado centralizado (fração da imagem). */
const DEAD_ZONE = 0.04;
export const MATCH_MIN_SCORE = 0.45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AimContext {
  camera: Camera;
  /** Vídeo com o quadro completo da câmera (as duas lentes). */
  video: () => HTMLVideoElement | null;
  /** Metade do quadro que é a lente móvel (null = câmera de uma lente). */
  ptzCrop: 'top' | 'bottom' | null;
  onProgress?: (msg: string) => void;
}

type Rates = NonNullable<PtzCalibration['rates']>;

function fixedCrop(ctx: AimContext) {
  return ctx.ptzCrop === 'top' ? 'bottom' : ctx.ptzCrop === 'bottom' ? 'top' : null;
}

async function grab(ctx: AimContext, crop: 'top' | 'bottom' | null, w: number, h: number): Promise<Gray> {
  // aba escondida = o player pausa o vídeo e o navegador atrasa os timers
  if (document.hidden) throw new Error('Deixe a aba do painel visível enquanto a câmera se move.');
  for (let i = 0; i < 10; i++) {
    const v = ctx.video();
    const g = v && !v.paused && grabGray(v, crop, w, h);
    if (g) return g;
    await sleep(200);
  }
  throw new Error('O vídeo não está rodando — aguarde a imagem carregar e tente de novo.');
}

/** Garante que o vídeo está atualizando (quadros congelados dariam medidas falsas). */
async function assertLive(ctx: AimContext) {
  const a = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
  await sleep(700);
  const b = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
  if (diff === 0) throw new Error('O vídeo parece congelado. Aguarde ele voltar e tente de novo.');
}

async function pulse(cameraId: string, dir: PtzDirection, ms: number, speed: number) {
  await api.ptz(cameraId, { command: dir, action: 'pulse', durationMs: Math.round(ms), speed });
}

/** Taxas por sentido: as de calibrações antigas (só pan/tilt) viram simétricas. */
function ratesOf(cal: PtzCalibration): Rates {
  return cal.rates ?? { right: cal.panRate, left: -cal.panRate, down: cal.tiltRate, up: -cal.tiltRate };
}

/**
 * Desloca o conteúdo da imagem móvel em (dx, dy). Para cada eixo escolhe o
 * comando cuja taxa medida tem o mesmo sinal do deslocamento desejado — assim
 * funciona mesmo em câmeras espelhadas ou com sentidos de velocidades diferentes.
 */
async function moveBy(ctx: AimContext, rates: Rates, speed: number, dx: number, dy: number) {
  const axes: [number, [PtzDirection, number][]][] = [
    [dx, [['DirectionRight', rates.right], ['DirectionLeft', rates.left]]],
    [dy, [['DirectionDown', rates.down], ['DirectionUp', rates.up]]],
  ];
  for (const [want, options] of axes) {
    if (Math.abs(want) <= DEAD_ZONE) continue;
    const pick = options.find(([, r]) => Math.sign(r) === Math.sign(want) && Math.abs(r) > 1e-3);
    if (!pick) continue;
    const ms = Math.min(MAX_PULSE_MS, Math.max(MIN_PULSE_MS, (want / pick[1]) * 1000));
    await pulse(ctx.camera.id, pick[0], ms, speed);
  }
}

/** Volta (em malha fechada) para a vista da imagem de referência. */
async function returnTo(ctx: AimContext, ref: Gray, rates: Rates, speed: number) {
  let lastError = Infinity;
  for (let i = 0; i < 4; i++) {
    await sleep(SETTLE_MS);
    const cur = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
    const s = estimateShift(ref, cur);
    if (s.atEdge || s.confidence < 0.1) return false; // longe demais para reconhecer
    const error = Math.hypot(s.dx, s.dy);
    if (Math.abs(s.dx) <= DEAD_ZONE && Math.abs(s.dy) <= DEAD_ZONE) return true;
    if (error > lastError * 0.9) return false; // a correção não está ajudando: para de mexer
    lastError = error;
    await moveBy(ctx, rates, speed, -s.dx, -s.dy);
  }
  return false;
}

/**
 * Mede um eixo nos dois sentidos: pulso de ida (mede), pulso de volta (mede).
 * Ajusta a duração até a imagem andar uma distância boa de medir (10–35%).
 */
async function measureAxis(ctx: AimContext, forward: PtzDirection, back: PtzDirection, axis: 'x' | 'y') {
  const pick = (s: { dx: number; dy: number }) => (axis === 'x' ? s.dx : s.dy);
  let ms = 600;
  for (let attempt = 0; attempt < 4; attempt++) {
    const a = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
    await pulse(ctx.camera.id, forward, ms, CAL_SPEED);
    await sleep(SETTLE_MS);
    const b = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
    await pulse(ctx.camera.id, back, ms, CAL_SPEED);
    await sleep(SETTLE_MS);
    const c = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);

    const go = estimateShift(a, b);
    const ret = estimateShift(b, c);
    const moved = Math.abs(pick(go));
    if (go.atEdge) {
      ms *= 0.5;
      continue;
    }
    if (moved < 0.1 || go.confidence < 0.15) {
      ms = Math.min(2500, ms * (moved > 0.01 ? 0.2 / moved : 2));
      continue;
    }
    const fwdRate = pick(go) / (ms / 1000);
    // a volta pode ter batido no limite ou ficado sem textura: usa o simétrico
    const backOk = !ret.atEdge && ret.confidence >= 0.15 && Math.abs(pick(ret)) > 0.03 && Math.sign(pick(ret)) === -Math.sign(fwdRate);
    const backRate = backOk ? pick(ret) / (ms / 1000) : -fwdRate;
    return { fwdRate, backRate };
  }
  return null;
}

const SCALES = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * Calibra a mira (~20–30s). Ao final — mesmo se falhar — guia a câmera de
 * volta para a vista em que estava, comparando com a imagem inicial.
 */
export async function calibrate(ctx: AimContext): Promise<PtzCalibration> {
  await assertLive(ctx);
  const start = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
  // taxas provisórias (para conseguir voltar mesmo se a medição falhar no meio)
  const rates: Rates = { right: 0.1, left: -0.1, down: 0.1, up: -0.1 };
  let failure: string | null = null;

  try {
    ctx.onProgress?.('Medindo o giro horizontal…');
    const pan = await measureAxis(ctx, 'DirectionRight', 'DirectionLeft', 'x');
    if (!pan) throw new Error('Não consegui medir o giro horizontal. Aponte a lente móvel para uma área com mais detalhes (ou longe do limite do giro) e tente de novo.');
    rates.right = pan.fwdRate;
    rates.left = pan.backRate;
    await returnTo(ctx, start, rates, CAL_SPEED);

    ctx.onProgress?.('Medindo a inclinação…');
    const tilt = await measureAxis(ctx, 'DirectionDown', 'DirectionUp', 'y');
    if (!tilt) throw new Error('Não consegui medir a inclinação. A lente pode estar no limite de cima/baixo — mova um pouco pelo joystick e tente de novo.');
    rates.down = tilt.fwdRate;
    rates.up = tilt.backRate;
  } catch (err) {
    failure = (err as Error).message;
  }

  ctx.onProgress?.('Voltando para a posição inicial…');
  const back = await returnTo(ctx, start, rates, CAL_SPEED).catch(() => false);
  if (failure) {
    throw new Error(back ? failure : `${failure} Não consegui voltar exatamente para a posição inicial — ajuste pelo joystick.`);
  }

  let scale: number | null = null;
  const fc = fixedCrop(ctx);
  if (ctx.ptzCrop && fc) {
    ctx.onProgress?.('Procurando a lente móvel dentro da imagem fixa…');
    const fixed = await grab(ctx, fc, LOCATE_W, LOCATE_H);
    const ptz = await grab(ctx, ctx.ptzCrop, LOCATE_W, LOCATE_H);
    const m = locateMultiScale(fixed, ptz, SCALES);
    if (m && m.score >= MATCH_MIN_SCORE) scale = m.scale;
  }
  return {
    speed: CAL_SPEED,
    panRate: (rates.right - rates.left) / 2,
    tiltRate: (rates.down - rates.up) / 2,
    rates,
    scale,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clique na própria lente móvel: traz o ponto (x, y ∈ 0–1) para o centro,
 * conferindo pela imagem e corrigindo uma vez se precisar.
 */
export async function centerOn(ctx: AimContext, cal: PtzCalibration, x: number, y: number) {
  const rates = ratesOf(cal);
  const before = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
  const want = { dx: x - 0.5, dy: y - 0.5 };
  await moveBy(ctx, rates, cal.speed, want.dx, want.dy);
  await sleep(SETTLE_MS);
  // quanto andou de verdade? corrige o que faltou (ou sobrou)
  const after = await grab(ctx, ctx.ptzCrop, SHIFT_W, SHIFT_H);
  const s = estimateShift(before, after);
  if (!s.atEdge && s.confidence >= 0.15) {
    await moveBy(ctx, rates, cal.speed, want.dx - s.dx, want.dy - s.dy);
  }
}

/** Onde a lente móvel está olhando, como retângulo dentro da imagem fixa. */
export async function locatePtzInFixed(ctx: AimContext, cal: PtzCalibration): Promise<Match | null> {
  const fc = fixedCrop(ctx);
  if (!cal.scale || !ctx.ptzCrop || !fc || document.hidden) return null;
  const fixed = await grab(ctx, fc, LOCATE_W, LOCATE_H);
  const ptz = await grab(ctx, ctx.ptzCrop, LOCATE_W, LOCATE_H);
  const m = locate(fixed, resize(ptz, Math.round(LOCATE_W * cal.scale), Math.round(LOCATE_H * cal.scale)));
  return m && m.score >= MATCH_MIN_SCORE ? m : null;
}

/**
 * Experimental — clique na imagem fixa: localiza a lente móvel dentro da
 * fixa e a guia até o ponto clicado, corrigindo em até 3 passos.
 */
export async function aimFromFixed(ctx: AimContext, cal: PtzCalibration, x: number, y: number) {
  if (!cal.scale) throw new Error('A calibração não encontrou a lente móvel dentro da fixa. Recalibre com a lente móvel apontada para uma área que a fixa também vê.');
  const rates = ratesOf(cal);
  for (let step = 0; step < 3; step++) {
    ctx.onProgress?.(step === 0 ? 'Localizando a lente móvel…' : 'Ajustando a mira…');
    const m = await locatePtzInFixed(ctx, cal);
    if (!m) {
      throw new Error(
        step === 0
          ? 'Não encontrei a imagem da lente móvel dentro da fixa (ela pode estar apontando para fora da área da fixa). Use o joystick para trazê-la para perto e tente de novo.'
          : 'Perdi a lente móvel durante o ajuste. Clique de novo para continuar.',
      );
    }
    // diferença na fixa → em "larguras da imagem móvel"
    const dx = (x - (m.x + m.w / 2)) / cal.scale;
    const dy = (y - (m.y + m.h / 2)) / cal.scale;
    if (Math.abs(dx) <= DEAD_ZONE * 2 && Math.abs(dy) <= DEAD_ZONE * 2) return;
    ctx.onProgress?.('Movendo…');
    await moveBy(ctx, rates, cal.speed, dx, dy);
    await sleep(SETTLE_MS);
  }
}
