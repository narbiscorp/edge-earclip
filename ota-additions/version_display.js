/*
 * version_display.js — read on-device firmware revision over BLE DIS,
 * compare against the version embedded in the uploaded .bin, and warn
 * (do not block) on downgrades.
 *
 * The earclip exposes the standard Bluetooth SIG Device Information
 * Service (0x180A) with a Firmware Revision String characteristic
 * (0x2A26). Edge does too. Both populate it from
 * esp_app_get_description()->version, i.e. the same string the
 * validator extracts from the uploaded .bin's app descriptor — making
 * an apples-to-apples compare straightforward.
 */

const DIS_SERVICE_UUID            = 0x180a;
const FIRMWARE_REVISION_CHAR_UUID = 0x2a26;

/**
 * Read firmware revision from a connected GATT server.
 * Returns null if the device has no DIS or the read fails — older
 * pre-DIS firmware should not break the OTA flow.
 *
 * @param {BluetoothRemoteGATTServer} server
 * @returns {Promise<string|null>}
 */
export async function readDeviceVersion(server) {
  try {
    const svc = await server.getPrimaryService(DIS_SERVICE_UUID);
    const chr = await svc.getCharacteristic(FIRMWARE_REVISION_CHAR_UUID);
    const dv = await chr.readValue();
    return new TextDecoder("utf-8").decode(dv).replace(/\0+$/, "").trim();
  } catch {
    return null;
  }
}

/* Tiny semver compare: returns -1, 0, +1 for a vs b.
 * Only major.minor.patch is compared; any pre-release or build suffix
 * is ignored. Returns null if either string is unparseable. */
export function compareSemver(a, b) {
  const parse = (s) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? "").trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Render a "current vs new" version row into an existing container.
 * The downgrade case is a warning only — per the integration guide,
 * the user can still proceed (e.g. to roll back a bad release).
 *
 * @param {HTMLElement} container
 * @param {{current: string|null, incoming: string|null}} versions
 */
export function renderVersionRow(container, { current, incoming }) {
  while (container.firstChild) container.removeChild(container.firstChild);

  const row = document.createElement("div");
  row.className = "narbis-version-row";

  const cur = document.createElement("span");
  cur.className = "narbis-version-current";
  cur.textContent = `Current: ${current ?? "unknown"}`;

  const arrow = document.createElement("span");
  arrow.className = "narbis-version-arrow";
  arrow.textContent = " → ";

  const inc = document.createElement("span");
  inc.className = "narbis-version-incoming";
  inc.textContent = `New: ${incoming ?? "unknown"}`;

  row.appendChild(cur);
  row.appendChild(arrow);
  row.appendChild(inc);
  container.appendChild(row);

  const cmp = compareSemver(current, incoming);
  if (cmp === 1) {
    const warn = document.createElement("div");
    warn.className = "narbis-version-warning";
    warn.setAttribute("role", "alert");
    warn.textContent =
      `Warning: ${incoming} is older than the version currently on the ` +
      `device (${current}). This is a downgrade. Proceed only if you mean to.`;
    container.appendChild(warn);
  }
}
