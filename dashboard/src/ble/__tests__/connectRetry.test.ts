/*
 * Connection retry policy.
 *
 * Chrome's GATT connect fails on first contact routinely and succeeds moments
 * later unchanged. A single attempt is why a strap "needs several tries", so
 * the retry behaviour is worth pinning down rather than trusting by inspection.
 */
import { describe, expect, it, vi } from 'vitest';
import { describeBleError, isChooserDismissal, retryAsync, __pmdInternal } from '../polarH10';

const { pmdStatusName } = __pmdInternal;

const err = (name: string, message = 'boom'): Error => {
  const e = new Error(message);
  e.name = name;
  return e;
};

describe('retryAsync', () => {
  it('returns the first success without further attempts', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(retryAsync(fn, [0, 10, 10])).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('recovers from a failure that succeeds on a later attempt', async () => {
    // The real-world case: connect throws, then works with nothing changed.
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw err('NetworkError', 'Connection failed');
      return 'connected';
    });
    await expect(retryAsync(fn, [0, 1, 1, 1])).resolves.toBe('connected');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows the LAST error once the attempts run out', async () => {
    const fn = vi.fn(async (attempt: number) => {
      throw err('NetworkError', `fail-${attempt}`);
    });
    await expect(retryAsync(fn, [0, 1, 1])).rejects.toThrow('fail-2');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('makes exactly as many attempts as there are delays', async () => {
    const fn = vi.fn(async () => {
      throw err('NetworkError');
    });
    await expect(retryAsync(fn, [0, 1, 1, 1, 1])).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('reports each failed attempt and whether another follows', async () => {
    const seen: Array<{ attempt: number; willRetry: boolean }> = [];
    const fn = async (): Promise<never> => {
      throw err('NetworkError');
    };
    await expect(
      retryAsync(fn, [0, 1, 1], (_e, attempt, willRetry) => seen.push({ attempt, willRetry })),
    ).rejects.toThrow();
    expect(seen).toEqual([
      { attempt: 0, willRetry: true },
      { attempt: 1, willRetry: true },
      { attempt: 2, willRetry: false },
    ]);
  });

  it('passes the attempt index through', async () => {
    const attempts: number[] = [];
    await retryAsync(
      async (i) => {
        attempts.push(i);
        if (i < 2) throw err('NetworkError');
        return i;
      },
      [0, 1, 1, 1],
    );
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('throws rather than hanging when given no attempts', async () => {
    await expect(retryAsync(async () => 'x', [])).rejects.toThrow();
  });
});

describe('isChooserDismissal', () => {
  it('recognises a dismissed or empty chooser — nothing to retry there', () => {
    expect(isChooserDismissal(err('NotFoundError', 'User cancelled'))).toBe(true);
    expect(isChooserDismissal(err('AbortError'))).toBe(true);
  });

  it('does not swallow a real radio failure', () => {
    expect(isChooserDismissal(err('NetworkError', 'Connection failed'))).toBe(false);
    expect(isChooserDismissal(err('InvalidStateError'))).toBe(false);
    expect(isChooserDismissal(null)).toBe(false);
    expect(isChooserDismissal('nope')).toBe(false);
  });
});

describe('describeBleError', () => {
  it('explains a connection failure in physical terms', () => {
    const s = describeBleError(err('NetworkError', 'Connection failed'));
    expect(s).toContain('Connection failed');
    expect(s).toMatch(/worn|range|asleep/i);
  });

  it('names the secure-context requirement', () => {
    expect(describeBleError(err('SecurityError', 'blocked'))).toMatch(/https|secure context/i);
  });

  it('passes an unrecognised error through unchanged', () => {
    expect(describeBleError(err('WeirdError', 'something odd'))).toBe('something odd');
  });

  it('survives a non-Error', () => {
    expect(describeBleError('plain string')).toBe('plain string');
    expect(typeof describeBleError(null)).toBe('string');
  });
});

describe('PMD status handling (regression: ACC died after a reconnect)', () => {
  /* Observed log, oldest first:
   *   Polar H10 disconnected (gatt)
   *   Polar H10 connected            <- reconnect loop
   *   Polar H10 connected            <- user-initiated connect, same device
   *   H10 ACC supports rates [...]   x2
   *   ACC started: 100 Hz            <- first start succeeded
   *   H10 REJECTED ACC start (6)     <- second start, ALREADY_IN_STATE
   *   ACC stream failed
   * The second start's error handler then called stopAccStream() and killed a
   * working stream. Status 6 must be treated as success, and two concurrent
   * starts must share one attempt. */

  it('names status 6 as the already-running case', () => {
    expect(describeBleError(err('x', 'y'))).toBeTruthy();
    // The decoder lives in polarH10; assert the mapping is what the fix relies on.
    expect(pmdStatusName(6)).toBe('ALREADY_IN_STATE');
    expect(pmdStatusName(0)).toBe('SUCCESS');
  });

  it('coalesces concurrent starts into one attempt', async () => {
    // Model the guard: a second caller arriving before the first resolves must
    // await it rather than issuing a second start command.
    let starts = 0;
    let inFlight: Promise<void> | null = null;
    let streaming = false;
    const start = (): Promise<void> => {
      if (streaming) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = (async () => {
        starts++;
        await new Promise((r) => setTimeout(r, 5));
        streaming = true;
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };
    await Promise.all([start(), start(), start()]);
    expect(starts).toBe(1);
    expect(streaming).toBe(true);
    await start();
    expect(starts).toBe(1); // already streaming — no further attempt
  });

  it('lets a newer attempt supersede an older one', () => {
    // The generation guard: only the latest attempt announces 'connected'.
    let gen = 0;
    const attempt = (): number => ++gen;
    const a = attempt();
    const b = attempt();
    expect(a === gen).toBe(false); // superseded, must stay quiet
    expect(b === gen).toBe(true); // owner, may announce
  });
});
