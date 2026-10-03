import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

export interface FoundDevice {
  host: string;
  /** Portas abertas encontradas (34567 = DVRIP, 554 = RTSP, 8899 = ONVIF). */
  ports: number[];
  name?: string;
  serial?: string;
  /** Respondeu ao broadcast de descoberta XMeye — é quase certamente uma câmera ICSee. */
  xmeye: boolean;
}

const SCAN_PORTS = [34567, 554, 8899];

function localSubnets() {
  const subnets: { address: string; prefix: string }[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      // só IPv4 privado; varre o /24 da interface
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      subnets.push({ address: a.address, prefix: a.address.split('.').slice(0, 3).join('.') });
    }
  }
  return subnets;
}

function isPortOpen(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function scanPorts(hosts: string[], timeoutMs = 600, concurrency = 128) {
  const tasks = hosts.flatMap((host) => SCAN_PORTS.map((port) => ({ host, port })));
  const open = new Map<string, number[]>();
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const { host, port } = tasks[next++];
      if (await isPortOpen(host, port, timeoutMs)) {
        open.set(host, [...(open.get(host) ?? []), port]);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return open;
}

/** "0x7100A8C0" (little-endian) → "192.168.0.113" */
function parseXmeyeIp(hex: string) {
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return undefined;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}

/**
 * Broadcast UDP de descoberta usado pelo CMS/VMS da XiongMai (porta 34569).
 * Cada câmera responde com um JSON contendo IP, nome e número de série.
 */
function xmeyeBroadcast(timeoutMs = 2500) {
  return new Promise<FoundDevice[]>((resolve) => {
    const found = new Map<string, FoundDevice>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      try {
        socket.close();
      } catch {}
      resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', (msg) => {
      const json = msg.subarray(20).toString('utf8').replace(/\0+$/, '');
      try {
        const data = JSON.parse(json);
        const info = data['NetWork.NetCommon'];
        if (!info) return;
        const host = parseXmeyeIp(info.HostIP);
        if (!host) return;
        found.set(host, {
          host,
          ports: info.TCPPort ? [info.TCPPort] : [34567],
          name: info.HostName,
          serial: info.SN,
          xmeye: true,
        });
      } catch {}
    });
    socket.bind(34569, () => {
      socket.setBroadcast(true);
      const packet = Buffer.from('ff00000000000000000000000000fa0500000000', 'hex');
      socket.send(packet, 34569, '255.255.255.255');
      setTimeout(finish, timeoutMs);
    });
  });
}

export async function discover(): Promise<FoundDevice[]> {
  const subnets = localSubnets();
  const self = new Set(subnets.map((s) => s.address));
  const hosts = [...new Set(subnets.map((s) => s.prefix))]
    .flatMap((prefix) => Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`))
    .filter((h) => !self.has(h));

  const [broadcast, scanned] = await Promise.all([xmeyeBroadcast().catch(() => []), scanPorts(hosts)]);

  const result = new Map<string, FoundDevice>();
  for (const [host, ports] of scanned) {
    result.set(host, { host, ports: ports.sort((a, b) => a - b), xmeye: false });
  }
  for (const dev of broadcast) {
    const prev = result.get(dev.host);
    result.set(dev.host, { ...dev, ports: [...new Set([...(prev?.ports ?? []), ...dev.ports])].sort((a, b) => a - b) });
  }
  // câmeras XMeye primeiro, depois quem tem a porta DVRIP aberta
  return [...result.values()].sort(
    (a, b) => Number(b.xmeye) - Number(a.xmeye) || Number(b.ports.includes(34567)) - Number(a.ports.includes(34567)),
  );
}

export async function reachable(host: string, port: number) {
  return isPortOpen(host, port, 1500);
}
