import { createHash } from 'node:crypto';
import net from 'node:net';

/**
 * Cliente mínimo do protocolo DVRIP/Sofia (XiongMai/XMeye/ICSee) — só o
 * necessário para comandos de controle (login, info, PTZ). O vídeo continua
 * com o go2rtc.
 *
 * Pacote: cabeçalho de 20 bytes little-endian + JSON + "\n\0"
 *   u8 0xFF | u8 versão | 2 reserv. | u32 sessão | u32 seq | 2 reserv. | u16 msgId | u32 tamanho
 */

export const MSG = {
  LOGIN: 1000,
  KEEPALIVE: 1006,
  SYSTEM_INFO: 1020,
  CONFIG_GET: 1042,
  ABILITY_GET: 1360,
  PTZ: 1400,
  CHANNEL_TITLE_GET: 1048,
} as const;

export const RET_OK = new Set([100, 515]);

const RET_MESSAGES: Record<number, string> = {
  101: 'erro desconhecido',
  103: 'comando não suportado',
  106: 'usuário sem permissão',
  107: 'sem permissão',
  203: 'senha incorreta',
  204: 'usuário não existe',
  205: 'login recusado (usuário/senha incorretos)',
  206: 'conta bloqueada por excesso de tentativas',
  207: 'usuário na lista negra',
  208: 'usuário já logado',
};

export class DvripError extends Error {
  constructor(
    message: string,
    public ret?: number,
  ) {
    super(message);
  }
}

/** Hash de senha "Sofia": md5 → pares de bytes somados mod 62. */
export function sofiaHash(password: string) {
  const md5 = createHash('md5').update(password, 'utf8').digest();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 16; i += 2) out += chars[(md5[i] + md5[i + 1]) % 62];
  return out;
}

export interface DvripOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs?: number;
}

type Reply = Record<string, any> & { Ret?: number };

export class DvripClient {
  private socket?: net.Socket;
  private session = 0;
  private seq = 0;
  private buffer = Buffer.alloc(0);
  private waiting?: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private queue: Promise<unknown> = Promise.resolve();
  private keepAliveTimer?: NodeJS.Timeout;
  closed = false;

  constructor(private opts: DvripOptions) {}

  get sessionHex() {
    return `0x${this.session.toString(16).toUpperCase().padStart(8, '0')}`;
  }

  async connect() {
    const { host, port, timeoutMs = 5000 } = this.opts;
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DvripError(`Tempo esgotado conectando em ${host}:${port}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.socket = socket;
    });
    this.socket!.on('data', (chunk) => this.onData(chunk));
    this.socket!.on('close', () => this.onClose());
    this.socket!.on('error', () => {});

    const reply = await this.request(MSG.LOGIN, {
      EncryptType: 'MD5',
      LoginType: 'DVRIP-Web',
      PassWord: sofiaHash(this.opts.password),
      UserName: this.opts.username,
    });
    if (!RET_OK.has(reply.Ret ?? 0)) {
      this.close();
      throw new DvripError(`Login falhou: ${RET_MESSAGES[reply.Ret!] ?? `Ret ${reply.Ret}`}`, reply.Ret);
    }
    this.session = Number.parseInt(reply.SessionID, 16);
    const alive = Math.max(5, Number(reply.AliveInterval) || 20);
    this.keepAliveTimer = setInterval(() => {
      this.request(MSG.KEEPALIVE, { Name: 'KeepAlive', SessionID: this.sessionHex }).catch(() => this.close());
    }, alive * 1000);
    return reply;
  }

  /** Envia um comando e espera a resposta (comandos são serializados). */
  request(msgId: number, body: object): Promise<Reply> {
    const run = () =>
      new Promise<Reply>((resolve, reject) => {
        if (!this.socket || this.closed) return reject(new DvripError('Conexão DVRIP fechada'));
        const json = Buffer.from(JSON.stringify(body), 'utf8');
        const header = Buffer.alloc(20);
        header.writeUInt8(0xff, 0);
        header.writeUInt8(0, 1);
        header.writeUInt32LE(this.session, 4);
        header.writeUInt32LE(this.seq++, 8);
        header.writeUInt16LE(msgId, 14);
        header.writeUInt32LE(json.length + 2, 16);
        const timer = setTimeout(() => {
          this.waiting = undefined;
          reject(new DvripError('Câmera não respondeu ao comando'));
          this.close();
        }, this.opts.timeoutMs ?? 5000);
        this.waiting = { resolve, reject, timer };
        this.socket.write(Buffer.concat([header, json, Buffer.from([0x0a, 0x00])]));
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async command(msgId: number, name: string, data?: object) {
    const body: Record<string, unknown> = { Name: name, SessionID: this.sessionHex };
    if (data !== undefined) body[name] = data;
    return this.request(msgId, body);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    this.socket?.destroy();
  }

  private onClose() {
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(new DvripError('Conexão DVRIP encerrada pela câmera'));
      this.waiting = undefined;
    }
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 20) {
      const len = this.buffer.readUInt32LE(16);
      if (this.buffer.length < 20 + len) return;
      const payload = this.buffer.subarray(20, 20 + len);
      this.buffer = this.buffer.subarray(20 + len);
      const text = payload.toString('utf8').replace(/[\0\n\r]+$/g, '');
      let reply: Reply;
      try {
        reply = JSON.parse(text);
      } catch {
        // alguns firmwares mandam caracteres de controle no JSON
        try {
          reply = JSON.parse(text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''));
        } catch {
          reply = { Ret: 101, raw: text };
        }
      }
      const w = this.waiting;
      if (w) {
        this.waiting = undefined;
        clearTimeout(w.timer);
        w.resolve(reply);
      }
    }
  }
}

export const PTZ_COMMANDS = [
  'DirectionUp',
  'DirectionDown',
  'DirectionLeft',
  'DirectionRight',
  'DirectionLeftUp',
  'DirectionLeftDown',
  'DirectionRightUp',
  'DirectionRightDown',
  'ZoomTile',
  'ZoomWide',
  'FocusNear',
  'FocusFar',
  'GotoPreset',
  'SetPreset',
  'ClearPreset',
] as const;
export type PtzCommand = (typeof PTZ_COMMANDS)[number];

/**
 * Comando PTZ. Movimento contínuo: `start` (Preset 65535) começa a mover,
 * `stop` (Preset -1) para. Presets usam o número do preset.
 */
export function ptzBody(command: PtzCommand, channel: number, opts: { action?: 'start' | 'stop'; preset?: number; speed?: number }) {
  const isPreset = command.endsWith('Preset');
  return {
    Command: command,
    Parameter: {
      AUX: { Number: 0, Status: 'On' },
      Channel: channel,
      MenuOpts: 'Enter',
      POINT: { bottom: 0, left: 0, right: 0, top: 0 },
      Pattern: 'SetBegin',
      Preset: isPreset ? (opts.preset ?? 1) : opts.action === 'stop' ? -1 : 65535,
      Step: opts.speed ?? 5,
      Tour: 0,
    },
  };
}
