export type M5StackStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';
export interface M5StackTelemetry { ax: number; ay: number; az: number; delta: number; pulses: number; events: number }

export class ShakeTurnGate {
  private usedTurnKey: string | null = null;

  hasUsed(turnKey: string): boolean {
    return this.usedTurnKey === turnKey;
  }

  consume(turnKey: string): boolean {
    if (this.hasUsed(turnKey)) return false;
    this.usedTurnKey = turnKey;
    return true;
  }
}

export function parseM5ShakeLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^SHAKE(?:[_ -]EVENT)?$/i.test(text) || /\b(?:shake|roll)\b/i.test(text)) return true;
  try {
    const value = JSON.parse(text) as { type?: unknown; event?: unknown };
    return value.type === 'shake' || value.event === 'shake';
  } catch {
    return false;
  }
}

export function parseM5TelemetryLine(line: string): M5StackTelemetry | null {
  const match = /^IMU,([-+\d.e]+),([-+\d.e]+),([-+\d.e]+),([-+\d.e]+),(\d+),(\d+)$/.exec(line.trim());
  if (!match) return null;
  const [ax, ay, az, delta, pulses, events] = match.slice(1).map(Number);
  if (![ax, ay, az, delta, pulses, events].every(Number.isFinite)) return null;
  return { ax, ay, az, delta, pulses, events };
}

interface SerialReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

interface SerialWriter {
  write(value: Uint8Array): Promise<void>;
  releaseLock(): void;
}

interface SerialPortLike {
  readable: { getReader(): SerialReader } | null;
  writable?: { getWriter(): SerialWriter } | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface SerialNavigatorLike {
  requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
  addEventListener?: (type: 'disconnect', listener: (event: unknown) => void) => void;
  removeEventListener?: (type: 'disconnect', listener: (event: unknown) => void) => void;
}

export class M5StackShakeClient {
  status: M5StackStatus = 'disconnected';
  private port: SerialPortLike | null = null;
  private reader: SerialReader | null = null;
  private readTask: Promise<void> | null = null;
  private reading = false;
  private lastShakeAt = Number.NEGATIVE_INFINITY;
  private eventCountBaseline: number | null = null;

  constructor(
    private readonly options: {
      onShake: () => void;
      onStatus?: (status: M5StackStatus, message: string) => void;
      onTelemetry?: (telemetry: M5StackTelemetry) => void;
      onShakeBlocked?: (reason: string) => void;
      canShake?: () => { ok: boolean; reason?: string };
      cooldownMs?: number;
    },
  ) {
    if (!M5StackShakeClient.isSupported()) this.status = 'unsupported';
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async connect(): Promise<void> {
    if (!M5StackShakeClient.isSupported()) {
      this.status = 'unsupported';
      this.options.onStatus?.(this.status, '此瀏覽器不支援 Web Serial；請使用支援 USB Web Serial 的桌面瀏覽器。');
      throw new Error('此瀏覽器不支援 Web Serial');
    }
    this.setStatus('connecting', '請在瀏覽器視窗選擇 M5Stack 序列埠。');
    const serial = (navigator as unknown as { serial: SerialNavigatorLike }).serial;
    let port: SerialPortLike | null = null;
    let opened = false;
    try {
      port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      opened = true;
      if (port.writable) {
        const writer = port.writable.getWriter();
        try {
          await writer.write(new TextEncoder().encode('RESET\n'));
        } finally {
          writer.releaseLock();
        }
      }
      if (!port.readable) throw new Error('M5Stack 序列埠沒有可讀取的資料流');
      const reader = port.readable.getReader();
      this.port = port;
      this.reader = reader;
      this.lastShakeAt = Number.NEGATIVE_INFINITY;
      this.eventCountBaseline = null;
      this.setStatus('connected', 'M5Stack 已連線');
      this.reading = true;
      this.readTask = this.readLoop();
    } catch (error) {
      let cleanupFailure = '';
      if (opened && port) {
        try {
          await port.close();
        } catch (closeError) {
          cleanupFailure = `；釋放序列埠失敗：${closeError instanceof Error ? closeError.message : String(closeError)}`;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus('disconnected', `M5Stack 連線失敗：${message}${cleanupFailure}`);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.reading = false;
    const reader = this.reader;
    const port = this.port;
    if (reader) await reader.cancel();
    await this.readTask;
    if (port) await port.close();
    this.reader = null;
    this.port = null;
    this.readTask = null;
    this.setStatus('disconnected', 'M5Stack 已斷線，螢幕按鈕仍可使用');
  }

  private setStatus(status: M5StackStatus, message: string): void {
    this.status = status;
    this.options.onStatus?.(status, message);
  }

  private async readLoop(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (this.reading) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) this.handleLine(line);
      }
    } catch (error) {
      if (this.reading) this.setStatus('disconnected', `M5Stack 序列連線中斷：${error instanceof Error ? error.message : '未知錯誤'}`);
    } finally {
      try { reader.releaseLock(); } catch {}
      if (this.reading) {
        this.reading = false;
        this.reader = null;
        this.port = null;
        this.setStatus('disconnected', 'M5Stack 已斷線，螢幕按鈕仍可使用');
      }
    }
  }

  private handleLine(line: string): void {
    const telemetry = parseM5TelemetryLine(line);
    if (telemetry) {
      if (this.eventCountBaseline === null || telemetry.events < this.eventCountBaseline) {
        this.eventCountBaseline = telemetry.events;
      }
      this.options.onTelemetry?.({
        ...telemetry,
        events: telemetry.events - this.eventCountBaseline,
      });
      return;
    }
    if (!parseM5ShakeLine(line)) return;
    const now = Date.now();
    const cooldown = this.options.cooldownMs ?? 1200;
    if (now - this.lastShakeAt < cooldown) return;
    const permission = this.options.canShake?.();
    if (permission && !permission.ok) {
      this.options.onShakeBlocked?.(permission.reason ?? '目前不能擲骰');
      return;
    }
    this.lastShakeAt = now;
    this.options.onShake();
  }
}
