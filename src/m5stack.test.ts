import { describe, expect, it, vi } from 'vitest';
import { M5StackShakeClient, parseM5ShakeLine, parseM5TelemetryLine, ShakeTurnGate } from './m5stack';

describe('M5Stack shake protocol', () => {
  it('allows one shake roll per turn and resets for the next turn', () => {
    const gate = new ShakeTurnGate();

    expect(gate.consume('game:turn-1:player-1')).toBe(true);
    expect(gate.consume('game:turn-1:player-1')).toBe(false);
    expect(gate.hasUsed('game:turn-1:player-1')).toBe(true);
    expect(gate.consume('game:turn-2:player-1')).toBe(true);
  });

  it('accepts the documented text and JSON shake events', () => {
    expect(parseM5ShakeLine('SHAKE')).toBe(true);
    expect(parseM5ShakeLine('SHAKE_EVENT')).toBe(true);
    expect(parseM5ShakeLine('{"type":"shake"}')).toBe(true);
    expect(parseM5ShakeLine('{"event":"shake"}')).toBe(true);
    expect(parseM5ShakeLine('accel=12,13,14')).toBe(false);
  });

  it('parses sensor telemetry without mistaking it for a shake event', () => {
    const telemetry = parseM5TelemetryLine('IMU,0.12,-0.23,0.98,0.46,2,1');
    expect(telemetry).toEqual({ ax: 0.12, ay: -0.23, az: 0.98, delta: 0.46, pulses: 2, events: 1 });
    expect(parseM5ShakeLine('IMU,0.12,-0.23,0.98,0.46,2,1')).toBe(false);
    expect(parseM5TelemetryLine('IMU,broken')).toBeNull();
  });

  it('resets the displayed event count when a new page connection starts from a nonzero device counter', () => {
    const telemetry = vi.fn();
    const client = new M5StackShakeClient({ onShake: vi.fn(), onTelemetry: telemetry });
    const handle = (client as unknown as { handleLine: (line: string) => void }).handleLine.bind(client);

    handle('IMU,0,0,1,0,0,7');
    handle('IMU,0,0,1,0,0,8');

    expect(telemetry.mock.calls.map(([value]) => value.events)).toEqual([0, 1]);
  });

  it('opens the Web Serial readable stream and releases it on disconnect', async () => {
    let finishRead!: (result: { done: boolean }) => void;
    const reader = {
      read: vi.fn(() => new Promise<{ done: boolean }>(resolve => { finishRead = resolve; })),
      cancel: vi.fn(async () => { finishRead({ done: true }); }),
      releaseLock: vi.fn(),
    };
    const writer = {
      write: vi.fn(async (_value: Uint8Array) => {}),
      releaseLock: vi.fn(),
    };
    const port = {
      readable: { getReader: vi.fn(() => reader) },
      writable: { getWriter: () => writer },
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    vi.stubGlobal('navigator', { serial: { requestPort: vi.fn(async () => port) } });

    try {
      const client = new M5StackShakeClient({ onShake: vi.fn() });
      await client.connect();
      expect(port.readable.getReader).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(writer.write.mock.calls[0][0])).toBe('RESET\n');

      await client.disconnect();

      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
      expect(port.close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires shake permission and debounces repeated events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let allowed = true;
    let shakes = 0;
    const blocked = vi.fn();
    const client = new M5StackShakeClient({
      onShake: () => { shakes += 1; },
      onShakeBlocked: blocked,
      canShake: () => allowed ? { ok: true } : { ok: false, reason: '不是你的回合' },
      cooldownMs: 1200,
    });

    // Trigger lines through the private protocol handler for a deterministic unit test.
    const handle = (client as unknown as { handleLine: (line: string) => void }).handleLine.bind(client);
    handle('SHAKE');
    handle('SHAKE');
    expect(shakes).toBe(1);

    allowed = false;
    vi.setSystemTime(2400);
    handle('SHAKE');
    expect(shakes).toBe(1);
    expect(blocked).toHaveBeenCalledWith('不是你的回合');

    allowed = true;
    vi.setSystemTime(3600);
    handle('SHAKE');
    expect(shakes).toBe(2);
    vi.useRealTimers();
  });
});
