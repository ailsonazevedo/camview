import { api, type CaptureFile, type Crop } from './api';

/**
 * Tira uma foto do quadro atual do vídeo na resolução real (HD quando a tela
 * cheia está em HD), recortando a lente visível, e salva na galeria do servidor.
 */
export async function takeCapture(video: HTMLVideoElement, cameraId: string, crop: Crop): Promise<CaptureFile> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('O vídeo ainda não carregou.');
  const sh = crop ? vh / 2 : vh;
  const sy = crop === 'bottom' ? vh / 2 : 0;

  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = sh;
  canvas.getContext('2d')!.drawImage(video, 0, sy, vw, sh, 0, 0, vw, sh);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Não foi possível gerar a imagem.');
  return api.uploadCapture(cameraId, crop ?? 'full', blob);
}
