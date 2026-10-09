/*
 * bus.ts — the guided session's event bus, in its own module so the
 * recorder can listen without importing the session (which imports the
 * recorder to start and stop recordings — a cycle otherwise).
 */
import type { GuidedEvent } from './runner';

/** A runner event as recorded: the schedule mapped onto the wall clock,
 * when the device marker went out, and (session_start only) the full
 * protocol + settings so the recording describes itself. */
export interface GuidedEventDetail extends GuidedEvent {
  protocolId: string;
  /** Wall-clock ms the event was scheduled for (= when its tone played). */
  hostMs: number;
  /** Wall-clock ms the device marker was sent; null when none was sent. */
  markerSentMs: number | null;
  payload?: unknown;
}

export const guidedBus = new EventTarget();

export const GUIDED_EVENT = 'guidedEvent';
