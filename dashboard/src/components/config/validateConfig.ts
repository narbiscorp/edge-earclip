import type { NarbisRuntimeConfig } from '../../ble/parsers';
import { ALL_FIELD_KEYS, FIELD_SCHEMA, type ConfigKey } from './fieldSchema';

export type ValidationErrors = Partial<Record<ConfigKey, string>>;

export function validateConfig(cfg: NarbisRuntimeConfig): ValidationErrors {
  const errors: ValidationErrors = {};

  for (const key of ALL_FIELD_KEYS) {
    const spec = FIELD_SCHEMA[key];
    const raw = cfg[key];

    switch (spec.kind) {
      case 'numeric': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          errors[key] = 'must be a number';
          break;
        }
        if (raw < spec.min || raw > spec.max) {
          errors[key] = `out of range (${spec.min}–${spec.max})`;
          break;
        }
        if (!Number.isInteger(raw)) {
          errors[key] = 'must be an integer';
          break;
        }
        const cross = spec.validate?.(raw, cfg);
        if (cross) errors[key] = cross;
        break;
      }
      case 'enum': {
        if (typeof raw !== 'number' || !spec.options.some((o) => o.value === raw)) {
          errors[key] = 'invalid choice';
        }
        break;
      }
      case 'toggle': {
        if (raw !== 0 && raw !== 1) errors[key] = 'must be 0 or 1';
        break;
      }
      case 'bitmask': {
        if (typeof raw !== 'number' || raw < 0 || raw > 0xff) {
          errors[key] = 'must be 0–255';
          break;
        }
        const allowed = spec.bits.reduce((m, b) => m | (1 << b.bit), 0);
        if ((raw & ~allowed) !== 0) errors[key] = 'unknown bits set';
        break;
      }
      case 'mac': {
        if (!(raw instanceof Uint8Array) || raw.length !== 6) {
          errors[key] = 'MAC must be 6 bytes';
        }
        break;
      }
      case 'readonly':
        break;
    }
  }

  return errors;
}

export function isValid(errors: ValidationErrors): boolean {
  for (const k in errors) if (errors[k as ConfigKey]) return false;
  return true;
}
