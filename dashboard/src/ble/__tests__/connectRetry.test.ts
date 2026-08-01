/*
 * Connection retry policy.
 *
 * Chrome's GATT connect fails on first contact routinely and succeeds moments
 * later unchanged. A single attempt is why a strap "needs several tries", so
 * the retry behaviour is worth pinning down rather than trusting by inspection.
 */
import { describe, expect, it, vi } from 'vitest';
import { describeBleError, isChooserDismissal, retryAsync } from '../polarH10';

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
