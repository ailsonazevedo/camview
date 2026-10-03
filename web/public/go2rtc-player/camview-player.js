// Player do CamView: estende o VideoRTC oficial do go2rtc (video-rtc.js, sem
// alterações) e troca a UI por eventos DOM que o React escuta.
//   evento "cv-status" → detail: { state: 'loading'|'live'|'error', mode?, error?, width?, height? }
// Atributos:
//   controls        controles nativos + áudio liberado
//   fit             contain | cover (quadro inteiro)
//   crop            top | bottom — mostra só a metade do quadro (câmeras de 2 lentes)
import {VideoRTC} from './video-rtc.js';

class CamViewPlayer extends VideoRTC {
    constructor() {
        super();
        // rede local: não precisamos de STUN público
        this.pcConfig = {...this.pcConfig, iceServers: []};
        this.currentMode = '';
    }

    emit(detail) {
        this.dispatchEvent(new CustomEvent('cv-status', {detail}));
    }

    oninit() {
        super.oninit();
        const controls = this.hasAttribute('controls');
        const crop = this.getAttribute('crop');
        this.video.controls = controls && !crop;
        this.video.muted = !controls;
        this.style.overflow = 'hidden';

        if (crop === 'top' || crop === 'bottom') {
            // o quadro tem as duas lentes empilhadas: vídeo com o dobro da altura
            // e deslocado para mostrar só a metade pedida
            this.video.style.height = '200%';
            this.video.style.objectFit = 'fill';
            this.video.style.transform = crop === 'bottom' ? 'translateY(-50%)' : '';
        } else {
            this.video.style.objectFit = this.getAttribute('fit') || 'contain';
        }

        const live = () => this.emit({
            state: 'live',
            mode: this.currentMode,
            width: this.video.videoWidth,
            height: this.video.videoHeight,
        });
        this.video.addEventListener('playing', live);
        this.video.addEventListener('resize', () => {
            if (!this.video.paused) live();
        });
    }

    onconnect() {
        const result = super.onconnect();
        if (result) this.emit({state: 'loading'});
        return result;
    }

    onopen() {
        const result = super.onopen();
        this.onmessage['camview'] = msg => {
            if (msg.type === 'error') {
                this.emit({state: 'error', error: msg.value});
            } else if (['mse', 'hls', 'mp4', 'mjpeg'].includes(msg.type)) {
                this.currentMode = msg.type.toUpperCase();
            }
        };
        return result;
    }

    onpcvideo(ev) {
        super.onpcvideo(ev);
        if (this.pcState !== WebSocket.CLOSED) this.currentMode = 'WebRTC';
    }
}

customElements.define('camview-player', CamViewPlayer);
