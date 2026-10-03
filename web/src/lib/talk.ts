import { streamUrl } from './api';

export type TalkState = 'idle' | 'connecting' | 'live' | 'error';

/**
 * Envia o microfone do navegador para o alto-falante da câmera.
 *
 * Abre um WebRTC só de envio contra a stream "<id>_talk" do go2rtc, cuja
 * origem é o canal de retorno DVRIP (intercomunicador do ICSee). O go2rtc
 * converte para G.711 e manda em blocos de 320 bytes, como a câmera exige.
 */
export class TalkSession {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private media?: MediaStream;
  private audioCtx?: AudioContext;
  private analyser?: AnalyserNode;
  private closed = false;

  constructor(
    private stream: string,
    private onState: (state: TalkState, error?: string) => void,
  ) {}

  /** Nível do microfone (0–1) para o medidor da interface. */
  level() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  }

  async start() {
    this.onState('connecting');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.fail('O navegador só libera o microfone em https ou em localhost. Abra o painel por http://localhost:5173 neste computador.');
      return;
    }
    try {
      this.media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.fail(
        (err as DOMException).name === 'NotAllowedError'
          ? 'Permissão do microfone negada. Libere o microfone para este site no navegador.'
          : `Não foi possível abrir o microfone: ${(err as Error).message}`,
      );
      return;
    }
    if (this.closed) return this.stop();

    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.audioCtx.createMediaStreamSource(this.media).connect(this.analyser);

    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [] });
    this.pc = pc;
    for (const track of this.media.getAudioTracks()) pc.addTransceiver(track, { direction: 'sendonly' });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.onState('live');
      if (pc.connectionState === 'failed') this.fail('A conexão de áudio com a câmera caiu.');
    });

    const url = new URL(streamUrl(this.stream), location.href);
    url.protocol = url.protocol.replace('http', 'ws');
    const ws = new WebSocket(url);
    this.ws = ws;

    pc.addEventListener('icecandidate', (ev) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webrtc/candidate', value: ev.candidate ? ev.candidate.candidate : '' }));
      }
    });

    ws.addEventListener('open', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'webrtc/offer', value: offer.sdp }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data as string) as { type: string; value: string };
      if (msg.type === 'webrtc/answer') pc.setRemoteDescription({ type: 'answer', sdp: msg.value }).catch(() => {});
      if (msg.type === 'webrtc/candidate' && msg.value) pc.addIceCandidate({ candidate: msg.value, sdpMid: '0' }).catch(() => {});
      if (msg.type === 'error') this.fail(friendlyTalkError(msg.value));
    });
    ws.addEventListener('close', () => {
      if (!this.closed && pc.connectionState !== 'connected') this.fail('O servidor de vídeo encerrou a conexão de áudio.');
    });
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.pc?.close();
    this.media?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close().catch(() => {});
    this.analyser = undefined;
    this.onState('idle');
  }

  private fail(error: string) {
    if (this.closed) return;
    this.stop();
    this.onState('error', error);
  }
}

function friendlyTalkError(msg: string) {
  // OPTalk Ret 503: o intercomunicador já está em uso (ex.: app ICSee aberto falando)
  if (/503/.test(msg)) return 'O intercomunicador da câmera está em uso (o app ICSee pode estar com o áudio aberto).';
  if (/codec|media/i.test(msg)) return `A câmera não aceitou o formato de áudio: ${msg}`;
  return msg;
}
