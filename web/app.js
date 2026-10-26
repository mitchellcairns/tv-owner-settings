'use strict';

// Ports the TV's local API listens on: 7345 on SmartCast 4.0+ firmware, 9000 before that.
const PORTS = [7345, 9000];
const ROOT = 'tv_settings';

// Settings people most often need back after an update. Shown on the home screen if the TV has them.
const QUICK = [
  'picture/picture_mode',
  'system/input_at_power_on',
  'system/cec/cec_function',
  'system/cec/one_touch_play',
  'system/cec/device_discovery',
  'system/power_mode',
  'system/timers/auto_power_off_timer',
  'admin_and_privacy/viewing_data',
  'admin_and_privacy/advertising/limit_ad_tracking',
];

// Remote keys as (codeset, code) pairs for /key_command/.
const KEYS = {
  SEEK_FWD: [2, 0], SEEK_BACK: [2, 1], PAUSE: [2, 2], PLAY: [2, 3],
  DOWN: [3, 0], LEFT: [3, 1], OK: [3, 2], RIGHT: [3, 7], UP: [3, 8],
  BACK: [4, 0], SMARTCAST: [4, 3], GUIDE: [4, 4], INFO: [4, 6], MENU: [4, 8], HOME: [4, 15],
  VOL_DOWN: [5, 0], VOL_UP: [5, 1], MUTE_TOGGLE: [5, 4],
  INPUT_NEXT: [7, 1], CH_DOWN: [8, 0], CH_UP: [8, 1], CH_PREV: [8, 2], EXIT: [9, 0],
  POW_OFF: [11, 0], POW_ON: [11, 1], POW_TOGGLE: [11, 2],
};
// Number keys are codeset 0, codes 0-9 (channel entry). Typed text is also codeset 0, but uses ASCII codes.
for (let n = 0; n <= 9; n++) KEYS['NUM_' + n] = [0, n];
const KEYLIST_CHUNK = 50;

// Actions that reboot, wipe, or reset something get an extra confirmation.
const DANGEROUS = new Set([
  'factory_reset', 'soft_power_cycle', 'forget_saved_network',
  'reset_picture_mode', 'delete_picture_mode', 'reset_color_tuner', 'tvad_id_reset',
]);
// Changing network settings can drop the TV off Wi-Fi, which would also cut this page off.
const NETWORK_ACTIONS_OK = new Set(['network/test_connection/test_connection', 'network/test_connection/retest']);
const SKIP_TYPES = new Set(['T_PASSWORD_V1', 'T_PIN_V1']);

const $ = id => document.getElementById(id);

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('tvos:' + key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem('tvos:' + key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

let tv = store.get('tv') || {};          // { ip, port, token, deviceId, model, name }
let pairing = null;                       // { reqToken, challenge } while a PIN is on screen
let ready = false;                        // connected and paired
const menuNames = store.get('menuNames') || {};
const menuCache = {};                     // path -> items, so going back redraws instantly
const scrollPos = {};                     // route hash -> scrollY

function saveTv() { store.set('tv', tv); }

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const VIEWS = ['view-connect', 'view-trust', 'view-pair', 'view-home', 'view-settings'];
function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  $('btn-forget').hidden = !tv.ip || view === 'view-settings';
  $('tv-label').textContent = tv.ip ? [tv.model, tv.ip].filter(Boolean).join(' · ') : 'Not connected';
  if (view !== 'view-home' && view !== 'view-settings') setHeader('TV Owner Settings', false);
}

function setHeader(title, canGoBack) {
  $('page-title').textContent = title;
  $('btn-back').hidden = !canGoBack;
  $('logo').hidden = canGoBack;
}

function setStatus(id, text, kind) {
  const node = $(id);
  node.textContent = text || '';
  node.className = 'status' + (kind ? ' ' + kind : '');
}

let toastTimer;
function toast(text, isError) {
  const node = $('toast');
  node.textContent = text;
  node.className = 'toast' + (isError ? ' error' : '');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 2500);
}

// ---- TV API -------------------------------------------------------------------------------

class NeedsPairing extends Error {}

// Development only: when served from localhost, tools/dev_proxy.py can stand in for the TV
// (set localStorage 'tvos:devApiBase' to "http://localhost:8138").
function apiBase(ip, port) {
  const dev = location.hostname === 'localhost' && store.get('devApiBase');
  return dev || `https://${ip}:${port}`;
}

async function request(method, path, body, { ip = tv.ip, port = tv.port, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (tv.token) headers.AUTH = tv.token;
    const res = await fetch(`${apiBase(ip, port)}${path}`, {
      method, headers, cache: 'no-store', signal: ctrl.signal,
      targetAddressSpace: 'local', // Chrome's Local Network Access: ask for permission instead of failing silently
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { STATUS: { RESULT: 'BAD_RESPONSE', DETAIL: text.slice(0, 200) } }; }
  } finally {
    clearTimeout(timer);
  }
}

const result = r => (r && r.STATUS && r.STATUS.RESULT) || 'UNKNOWN';
const detail = r => (r && r.STATUS && (r.STATUS.DETAIL || r.STATUS.RESULT)) || 'no response';

const UNREACHABLE = "Couldn't reach the TV. It may be off or asleep, or this browser may need to trust it again.";

async function getItem(path) {
  const r = await request('GET', `/menu_native/dynamic/${ROOT}/${path}`);
  if (result(r) === 'REQUIRES_PAIRING') throw new NeedsPairing();
  return r.ITEMS && r.ITEMS[0];
}

// ---- Connect and trust ----------------------------------------------------------------------

async function connect(ip) {
  tv.ip = ip;
  saveTv();
  show('view-connect');
  setStatus('connect-status', 'Looking for your TV…');
  for (const port of PORTS) {
    let info;
    try {
      info = await request('GET', '/state/device/deviceinfo', null, { ip, port, timeout: 5000 });
    } catch {
      continue; // refused, timed out, or certificate not trusted yet; the browser can't tell us which
    }
    tv.port = port;
    const value = info.ITEMS && info.ITEMS[0] && info.ITEMS[0].VALUE;
    if (value && value.MODEL_NAME) tv.model = value.MODEL_NAME;
    if (value && value.CAST_NAME) tv.name = value.CAST_NAME;
    // Chipset and firmware pick the right app launch IDs, e.g. "mtk5691-1.6.1670.1" -> "MT5691".
    const os = value && value.BINARIES && value.BINARIES.ViziOS;
    if (os) tv.chipset = os.split('-')[0].toUpperCase().replace(/^MTK/, 'MT');
    if (value && value.SYSTEM_INFO && value.SYSTEM_INFO.VERSION) tv.firmware = value.SYSTEM_INFO.VERSION;
    saveTv();
    setStatus('connect-status', '');
    return afterConnect();
  }
  tv.port = tv.port || PORTS[0];
  saveTv();
  showTrust();
}

// Chrome 141+ gates requests from websites to 192.168.x.x behind a "local network access" permission.
// Returns 'granted' | 'prompt' | 'denied', or null where the browser has no such permission.
async function localNetworkState() {
  if (!navigator.permissions) return null;
  for (const name of ['local-network-access', 'local-network']) {
    try {
      const status = await navigator.permissions.query({ name });
      status.onchange = () => { if (status.state === 'granted' && !ready) connect(tv.ip); };
      return status.state;
    } catch { /* not this name, or not supported */ }
  }
  return null;
}

const trustUrl = () => `https://${tv.ip}:${tv.port || PORTS[0]}/state/device/power_mode`;

async function showTrust(message) {
  ready = false;
  $('trust-link').href = trustUrl();
  setStatus('trust-status', message || '', message ? 'error' : '');
  const lna = await localNetworkState();
  $('lna-denied').hidden = lna !== 'denied';
  $('lna-prompt').hidden = lna !== 'prompt';
  show('view-trust');
}

// Any request to the TV, made from a tap, makes Chrome show its local network prompt.
async function requestLocalNetwork() {
  setStatus('trust-status', 'Waiting for your browser…');
  try {
    await request('GET', '/state/device/power_mode', null, { timeout: 60000 });
    return connect(tv.ip); // allowed, and the certificate is already trusted
  } catch { /* allowed but the certificate isn't trusted yet, or the user said no */ }
  showTrust();
}

async function copyTrustLink() {
  try {
    await navigator.clipboard.writeText(trustUrl());
    toast('Link copied. Paste it into the address bar of a new tab.');
  } catch {
    prompt('Copy this link and paste it into the address bar of a new tab:', trustUrl());
  }
}

function needPairing() {
  ready = false;
  tv.token = null;
  saveTv();
  setStatus('pair-status', 'The TV no longer recognizes this browser. Pair again.', 'error');
  show('view-pair');
}

async function afterConnect() {
  if (!tv.token) return show('view-pair');
  try {
    const r = await request('GET', `/menu_native/dynamic/${ROOT}`);
    if (result(r) === 'REQUIRES_PAIRING') return needPairing();
  } catch {
    return showTrust(UNREACHABLE);
  }
  ready = true;
  render();
}

// ---- Pairing ----------------------------------------------------------------------------------

async function pairStart() {
  setStatus('pair-status', 'Asking the TV for a PIN…');
  try {
    const r = await request('PUT', '/pairing/start', { DEVICE_ID: tv.deviceId, DEVICE_NAME: 'TV Owner Settings (web)' });
    const item = r.ITEM || {};
    if (result(r) !== 'SUCCESS' || item.PAIRING_REQ_TOKEN == null) {
      const busy = result(r) === 'BLOCKED' ? ' Another pairing may already be open; tap Cancel and try again.' : '';
      return setStatus('pair-status', `The TV said: ${detail(r)}.${busy}`, 'error');
    }
    pairing = { reqToken: item.PAIRING_REQ_TOKEN, challenge: item.CHALLENGE_TYPE || 1 };
    $('pin-box').hidden = false;
    $('pin').value = '';
    $('pin').focus();
    setStatus('pair-status', 'Enter the PIN shown on your TV.');
  } catch {
    showTrust(UNREACHABLE);
  }
}

async function pairFinish() {
  const pin = $('pin').value.trim();
  if (!/^\d{4}$/.test(pin)) return setStatus('pair-status', 'The PIN is 4 digits.', 'error');
  if (!pairing) return setStatus('pair-status', 'Tap Show PIN on TV first.', 'error');
  setStatus('pair-status', 'Pairing…');
  try {
    const r = await request('PUT', '/pairing/pair', {
      DEVICE_ID: tv.deviceId, CHALLENGE_TYPE: pairing.challenge,
      RESPONSE_VALUE: pin, PAIRING_REQ_TOKEN: pairing.reqToken,
    });
    const token = r.ITEM && r.ITEM.AUTH_TOKEN;
    if (result(r) !== 'SUCCESS' || !token) {
      return setStatus('pair-status', `Pairing failed: ${detail(r)}. Check the PIN, or tap Show PIN on TV for a new one.`, 'error');
    }
    tv.token = token;
    pairing = null;
    saveTv();
    $('pin-box').hidden = true;
    setStatus('pair-status', '');
    toast('Paired with your TV');
    afterConnect();
  } catch {
    showTrust(UNREACHABLE);
  }
}

async function pairCancel() {
  try {
    await request('PUT', '/pairing/cancel', {
      DEVICE_ID: tv.deviceId, CHALLENGE_TYPE: (pairing && pairing.challenge) || 1,
      RESPONSE_VALUE: '1111', PAIRING_REQ_TOKEN: (pairing && pairing.reqToken) || 0,
    });
  } catch { /* the TV drops the PIN screen on its own after a while anyway */ }
  pairing = null;
  $('pin-box').hidden = true;
  setStatus('pair-status', 'Pairing cancelled.');
}

// ---- Remote -------------------------------------------------------------------------------------

let lastKeyError = 0;
async function sendKey(name) {
  const [codeset, code] = KEYS[name];
  if (navigator.vibrate) navigator.vibrate(8);
  try {
    const r = await request('PUT', '/key_command/', { KEYLIST: [{ CODESET: codeset, CODE: code, ACTION: 'KEYPRESS' }] }, { timeout: 4000 });
    if (result(r) === 'REQUIRES_PAIRING') return needPairing();
    if (result(r) !== 'SUCCESS') toast(`The TV ignored that key: ${detail(r)}`, true);
  } catch {
    if (Date.now() - lastKeyError < 4000) return;
    lastKeyError = Date.now();
    toast(name.startsWith('POW')
      ? "Couldn't reach the TV. If it's off in Eco Mode it can't be woken over Wi-Fi; set Power Mode to Quick Start."
      : UNREACHABLE, true);
  }
  if (name.startsWith('VOL') || name === 'MUTE_TOGGLE') scheduleVolumeRefresh();
  if (name === 'INPUT_NEXT' || name.startsWith('POW') || name === 'SMARTCAST') setTimeout(renderInputs, 1500);
}

// ---- Volume (exact level) -----------------------------------------------------------------------
// Newer firmware has /audio/volume/level, which reads level + mute together and sets an exact level.

let volTimer, volSendTimer, volMax = null, volSupported = true, volBusy = false;

function showVolume(level, muted) {
  $('vol-level').textContent = muted ? 'muted' : level;
  $('vol-num').textContent = muted ? 'muted' : level;
  if (!volBusy) $('vol-slider').value = level;
}

async function refreshVolume() {
  try {
    if (volSupported) {
      const r = await request('GET', '/audio/volume/level');
      const v = r.ITEM && r.ITEM.VALUE;
      if (result(r) === 'SUCCESS' && v && Number.isFinite(v.LEVEL)) {
        if (volMax == null) {
          const s = await request('GET', `/menu_native/static/${ROOT}/audio/volume`).catch(() => null);
          const max = s && s.ITEMS && s.ITEMS[0] && s.ITEMS[0].MAXIMUM;
          volMax = Number.isFinite(max) ? max : 100;
          $('vol-slider').max = volMax;
        }
        $('volume-row').hidden = false;
        return showVolume(v.LEVEL, v.MUTE);
      }
      volSupported = false; // older firmware: fall back to the settings tree, no slider
      $('volume-row').hidden = true;
    }
    const [vol, mute] = await Promise.all([getItem('audio/volume'), getItem('audio/mute')]);
    $('vol-level').textContent = mute && mute.VALUE === 'On' ? 'muted' : (vol ? vol.VALUE : '');
  } catch { /* keep the old number */ }
}

function scheduleVolumeRefresh() {
  clearTimeout(volTimer);
  volTimer = setTimeout(refreshVolume, 350);
}

function setVolume(level) {
  level = Math.max(0, Math.min(volMax || 100, Math.round(level)));
  volBusy = true;
  $('vol-slider').value = level;
  $('vol-num').textContent = level;
  clearTimeout(volSendTimer);
  volSendTimer = setTimeout(async () => {
    try {
      const r = await request('PUT', '/audio/volume/level', { LEVEL: level });
      if (result(r) !== 'SUCCESS') toast(`Couldn't set volume: ${detail(r)}`, true);
    } catch {
      toast(UNREACHABLE, true);
    }
    volBusy = false;
    scheduleVolumeRefresh();
  }, 250);
}

// ---- Screen off, typing, apps --------------------------------------------------------------------

async function blankScreen() {
  try {
    const item = await getItem('system/timers/blank_screen');
    const r = await request('PUT', `/menu_native/dynamic/${ROOT}/system/timers/blank_screen`, { REQUEST: 'ACTION', HASHVAL: item.HASHVAL });
    if (result(r) === 'SUCCESS') toast('Screen off. Sound keeps playing; press any arrow to turn it back on.');
    else toast(`Couldn't turn the screen off: ${detail(r)}`, true);
  } catch (e) {
    if (e instanceof NeedsPairing) return needPairing();
    toast(UNREACHABLE, true);
  }
}

// Each character is a codeset-0 key whose code is its ASCII value, sent in order.
async function typeText(text) {
  const codes = [...text].map(ch => ch.charCodeAt(0));
  if (codes.some(c => c > 127)) return toast('Only plain letters, numbers and symbols (ASCII) can be typed.', true);
  try {
    for (let i = 0; i < codes.length; i += KEYLIST_CHUNK) {
      const keys = codes.slice(i, i + KEYLIST_CHUNK).map(code => ({ CODESET: 0, CODE: code, ACTION: 'KEYPRESS' }));
      const r = await request('PUT', '/key_command/', { KEYLIST: keys });
      if (result(r) !== 'SUCCESS') return toast(`The TV didn't accept the text: ${detail(r)}`, true);
    }
    toast('Sent');
    return true;
  } catch {
    toast(UNREACHABLE, true);
  }
}

let appList = null;

function versionAtLeast(version, min) {
  if (!min) return true;
  const a = String(version || '').split(/[.-]/).map(Number), b = String(min).split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

// Pick the launch payload for this TV: its own chipset's entry first, then the generic "*" one.
function launchPayload(app) {
  for (const chip of [tv.chipset, '*']) {
    for (const e of (chip && app.chipsets[chip]) || []) {
      const fw = tv.firmware || '';
      if (versionAtLeast(fw, e.min) && (!e.max || versionAtLeast(e.max, fw))) return e.payload;
    }
  }
  return null;
}

async function renderApps() {
  if (!appList) {
    try { appList = await (await fetch('apps.json')).json(); } catch { return; }
  }
  let current = null;
  try {
    const r = await request('GET', '/app/current');
    current = r.ITEM && r.ITEM.VALUE;
  } catch { /* highlight is optional */ }
  const apps = appList.map(app => ({ name: app.name, payload: launchPayload(app) })).filter(a => a.payload);
  $('apps').replaceChildren(...apps.map(app => {
    const isCurrent = current && current.NAME_SPACE === app.payload.NAME_SPACE && String(current.APP_ID) === String(app.payload.APP_ID);
    const chip = el('button', 'chip' + (isCurrent ? ' selected' : ''), app.name);
    chip.onclick = () => launchApp(app, chip);
    return chip;
  }));
  $('apps-card').hidden = !apps.length;
}

async function launchApp(app, chip) {
  for (const c of $('apps').children) c.classList.toggle('selected', c === chip);
  try {
    const { NAME_SPACE, APP_ID, MESSAGE } = app.payload;
    const r = await request('PUT', '/app/launch', { VALUE: { NAME_SPACE, APP_ID, MESSAGE } }, { timeout: 10000 });
    if (result(r) === 'SUCCESS') toast(`Opening ${app.name}`);
    else toast(`Couldn't open ${app.name}: ${detail(r)}`, true);
  } catch {
    toast(UNREACHABLE, true);
  }
  setTimeout(() => { renderApps(); renderInputs(); }, 2500);
}

// Keys marked data-repeat keep firing while held, like a real remote.
function wireRemote() {
  for (const button of document.querySelectorAll('.key[data-key]')) {
    const name = button.dataset.key;
    if (!('repeat' in button.dataset)) {
      button.addEventListener('click', () => sendKey(name));
      continue;
    }
    let delay, interval, fromPointer = false;
    const stop = () => {
      clearTimeout(delay);
      clearInterval(interval);
      button.classList.remove('pressed');
    };
    button.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      fromPointer = true;
      button.classList.add('pressed');
      sendKey(name);
      delay = setTimeout(() => { interval = setInterval(() => sendKey(name), 160); }, 450);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
    button.addEventListener('click', () => {
      if (fromPointer) { fromPointer = false; return; }
      sendKey(name); // keyboard activation
    });
    button.addEventListener('contextmenu', e => e.preventDefault());
  }
}

async function renderInputs() {
  let inputs;
  try {
    const item = await getItem('devices/current_inputs');
    inputs = (item && item.VALUE) || [];
  } catch (e) {
    if (e instanceof NeedsPairing) needPairing();
    return;
  }
  const box = $('inputs');
  box.replaceChildren(...inputs.filter(i => i.VISIBLE && i.ENABLED).map(input => {
    const chip = el('button', 'chip' + (input.SELECTED ? ' selected' : ''), input.CUSTOM_NAME || input.NAME);
    chip.setAttribute('aria-pressed', input.SELECTED ? 'true' : 'false');
    chip.onclick = () => switchInput(input, chip);
    return chip;
  }));
}

async function switchInput(input, chip) {
  for (const c of $('inputs').children) c.classList.toggle('selected', c === chip);
  try {
    const current = await getItem('devices/current_input');
    const r = await request('PUT', `/menu_native/dynamic/${ROOT}/devices/current_input`,
      { REQUEST: 'MODIFY', VALUE: input.CNAME, HASHVAL: current.HASHVAL });
    if (result(r) !== 'SUCCESS') toast(`Couldn't switch to ${input.CUSTOM_NAME}: ${detail(r)}`, true);
  } catch {
    toast(UNREACHABLE, true);
  }
  setTimeout(renderInputs, 1500);
}

// ---- Settings -----------------------------------------------------------------------------------

async function loadMenu(path) {
  const full = path ? `${ROOT}/${path}` : ROOT;
  const [dyn, stat] = await Promise.all([
    request('GET', `/menu_native/dynamic/${full}`),
    request('GET', `/menu_native/static/${full}`).catch(() => null),
  ]);
  if (result(dyn) === 'REQUIRES_PAIRING') throw new NeedsPairing();
  // Static data carries the allowed values (ELEMENTS) and ranges (MINIMUM/MAXIMUM/INCREMENT).
  const meta = {};
  for (const s of (stat && stat.ITEMS) || []) meta[s.CNAME] = s;
  const items = (dyn.ITEMS || []).map(it => {
    const m = meta[it.CNAME] || {};
    return { ...m, ...it, ELEMENTS: it.ELEMENTS || m.ELEMENTS, parent: path, path: path ? `${path}/${it.CNAME}` : it.CNAME };
  });
  for (const it of items) if ((it.TYPE || '').startsWith('T_MENU')) menuNames[it.path] = it.NAME || it.CNAME;
  store.set('menuNames', menuNames);
  menuCache[path] = items;
  return items;
}

const truthy = v => v === true || v === 'TRUE';
const visible = item => !truthy(item.HIDDEN) && !SKIP_TYPES.has(item.TYPE);
const menuLabel = path => menuNames[path] || path.split('/').pop().replace(/_/g, ' ');

function isLocked(item) {
  if (truthy(item.READONLY) || item.ENABLED === false || item.ENABLED === 'FALSE') return true;
  return item.path.startsWith('network/') && !NETWORK_ACTIONS_OK.has(item.path);
}

function formatValue(value) {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) {
    const names = value.map(v => v && (v.NAME || v['DEVICE NAME'] || v.CUSTOM_NAME)).filter(Boolean);
    return names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') : `${value.length} items`;
  }
  if (typeof value === 'object') return value.NAME || JSON.stringify(value).slice(0, 80);
  return String(value);
}

// Writes one value, queueing so fast taps collapse into the latest value and each write uses a fresh HASHVAL.
async function writeValue(item, value) {
  item.want = value;
  if (item.busy) return;
  item.busy = true;
  while (item.want !== undefined) {
    const v = item.want;
    item.want = undefined;
    try {
      const r = await request('PUT', `/menu_native/dynamic/${ROOT}/${item.path}`, { REQUEST: 'MODIFY', HASHVAL: item.HASHVAL, VALUE: v });
      if (result(r) === 'REQUIRES_PAIRING') { item.busy = false; return needPairing(); }
      if (result(r) !== 'SUCCESS') toast(`Couldn't change ${item.NAME}: ${detail(r)}`, true);
      const fresh = await getItem(item.path);
      if (fresh) Object.assign(item, { VALUE: fresh.VALUE, HASHVAL: fresh.HASHVAL, ELEMENTS: fresh.ELEMENTS || item.ELEMENTS });
    } catch {
      toast(UNREACHABLE, true);
      break;
    }
  }
  item.busy = false;
  if (item.want === undefined && item.sync) item.sync();
}

function renderItem(item, showParent) {
  const type = item.TYPE || '';
  const locked = isLocked(item);
  const name = el('div', 'name', item.NAME || item.CNAME);
  if (showParent && item.parent) name.append(el('span', 'path', item.parent.split('/').map((_, i, parts) => menuLabel(parts.slice(0, i + 1).join('/'))).join(' › ')));

  if (type.startsWith('T_MENU')) {
    const row = el('a', 'item menu');
    row.href = '#/settings/' + item.path;
    row.append(name, el('span', 'chev', '›'));
    return row;
  }

  const row = el('div', 'item');
  const control = el('div', 'control');
  row.append(name, control);

  if ((type === 'T_LIST_V1' || type === 'T_LIST_X_V1') && Array.isArray(item.ELEMENTS) && item.ELEMENTS.length) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', item.NAME || item.CNAME);
    select.disabled = locked;
    item.sync = () => {
      const options = item.ELEMENTS.includes(item.VALUE) ? item.ELEMENTS : [item.VALUE, ...item.ELEMENTS];
      select.replaceChildren(...options.map(opt => new Option(opt, opt, false, opt === item.VALUE)));
    };
    item.sync();
    select.onchange = () => writeValue(item, select.value).then(() => toast(`${item.NAME}: ${item.VALUE}`));
    control.append(select);
  } else if (type.startsWith('T_VALUE') && Number.isFinite(item.MINIMUM) && Number.isFinite(item.MAXIMUM)) {
    row.classList.add('number');
    const step = item.INCREMENT || 1;
    const num = el('output', 'num');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = item.MINIMUM;
    range.max = item.MAXIMUM;
    range.step = step;
    range.disabled = locked;
    range.setAttribute('aria-label', item.NAME || item.CNAME);
    const minus = el('button', '', '−');
    const plus = el('button', '', '+');
    minus.setAttribute('aria-label', `Decrease ${item.NAME}`);
    plus.setAttribute('aria-label', `Increase ${item.NAME}`);
    minus.disabled = plus.disabled = locked;
    item.sync = () => { range.value = item.VALUE; num.textContent = item.VALUE; };
    item.sync();

    let commitTimer;
    const setLocal = (n, commitNow) => {
      n = clampToRange(item, n);
      range.value = n;
      num.textContent = n;
      clearTimeout(commitTimer);
      if (commitNow) writeValue(item, n);
      else commitTimer = setTimeout(() => writeValue(item, n), 300);
    };
    range.oninput = () => { num.textContent = range.value; };
    range.onchange = () => setLocal(Number(range.value), true);
    minus.onclick = () => setLocal(Number(range.value) - step, false);
    plus.onclick = () => setLocal(Number(range.value) + step, false);

    control.append(num);
    const stepper = el('div', 'stepper');
    stepper.append(minus, range, plus);
    row.append(stepper);
  } else if (type === 'T_ACTION_V1') {
    const button = el('button', DANGEROUS.has(item.CNAME) ? 'danger' : '', 'Run');
    button.disabled = locked;
    button.onclick = () => runAction(item, button);
    control.append(button);
  } else {
    control.append(el('span', 'value', formatValue(item.VALUE)));
  }
  return row;
}

function clampToRange(item, n) {
  const step = item.INCREMENT || 1;
  const snapped = item.MINIMUM + Math.round((n - item.MINIMUM) / step) * step;
  return Math.min(item.MAXIMUM, Math.max(item.MINIMUM, snapped));
}

async function runAction(item, button) {
  if (item.CNAME === 'factory_reset') {
    const typed = prompt('This erases every setting on the TV and restarts setup. Type RESET to continue.');
    if (typed !== 'RESET') return;
  } else if (DANGEROUS.has(item.CNAME)) {
    if (!confirm(`"${item.NAME}" can restart or reset part of your TV. Run it anyway?`)) return;
  } else if (!confirm(`Run "${item.NAME}" on the TV?`)) {
    return;
  }
  button.disabled = true;
  try {
    const r = await request('PUT', `/menu_native/dynamic/${ROOT}/${item.path}`, { REQUEST: 'ACTION', HASHVAL: item.HASHVAL });
    if (result(r) === 'SUCCESS') toast(`${item.NAME}: done`);
    else toast(`${item.NAME} failed: ${detail(r)}`, true);
  } catch {
    toast(UNREACHABLE, true);
  }
  button.disabled = false;
  setTimeout(() => render({ keepScroll: true }), 1500); // e.g. CEC discovery fills in its results after a moment
}

async function renderQuick() {
  const parents = [...new Set(QUICK.map(p => p.slice(0, p.lastIndexOf('/'))))];
  // Some useful items (e.g. Picture Mode) are hidden in their menu, so the quick list fetches them directly.
  const extras = {};
  const draw = menus => {
    const byPath = { ...extras };
    for (const item of menus.flat()) if (visible(item)) byPath[item.path] = item;
    const list = $('quick-list');
    list.replaceChildren(...QUICK.filter(p => byPath[p]).map(p => renderItem(byPath[p], true)));
    $('quick').hidden = !list.children.length;
    return QUICK.filter(p => !byPath[p]);
  };
  if (parents.every(p => menuCache[p])) draw(parents.map(p => menuCache[p]));
  // The top-level menu is loaded too, only for its names ("System" rather than "system") in the labels.
  const menus = (await Promise.all(['', ...parents].map(p => loadMenu(p).catch(e => { if (e instanceof NeedsPairing) throw e; return []; })))).slice(1);
  const missing = draw(menus);
  await Promise.all(missing.map(async path => {
    const item = await getItem(path).catch(() => null);
    if (item && item.CNAME && !SKIP_TYPES.has(item.TYPE)) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      extras[path] = { ...item, parent, path };
    }
  }));
  if (Object.keys(extras).length) draw(menus);
}

async function renderMenu(path) {
  const warn = $('menu-warn');
  warn.hidden = !path.startsWith('network');
  warn.textContent = 'Network settings are read-only here. Changing them could drop the TV off Wi-Fi and cut this app off.';
  const list = $('menu-list');
  const draw = items => list.replaceChildren(...items.filter(visible).map(item => renderItem(item, false)));
  if (menuCache[path]) draw(menuCache[path]);
  else list.replaceChildren(el('p', 'hint', 'Loading…'));
  draw(await loadMenu(path));
}

// ---- Routing --------------------------------------------------------------------------------------
// #/ is the remote, #/settings is the settings root, #/settings/<path> is a submenu.

function currentRoute() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (hash === 'settings' || hash.startsWith('settings/')) return { page: 'settings', path: hash.slice('settings/'.length) };
  return { page: 'home', path: '' };
}

function routeKey() { return location.hash || '#/'; }

function parentHash(route) {
  if (route.page === 'home') return '#/';
  if (!route.path) return '#/';
  const parts = route.path.split('/');
  parts.pop();
  return parts.length ? '#/settings/' + parts.join('/') : '#/settings';
}

function rememberScroll() {
  if (activeKey) scrollPos[activeKey] = window.scrollY;
}

function navigate(hash) {
  rememberScroll();
  history.pushState({ depth: ((history.state && history.state.depth) || 0) + 1 }, '', hash);
  render();
}

function goBack() {
  rememberScroll();
  if (history.state && history.state.depth > 0) return history.back();
  history.replaceState({ depth: 0 }, '', parentHash(currentRoute()));
  render();
}

// Scroll position is recorded against activeKey, which is paused while a page is being swapped in,
// so the outgoing page's scroll offset never gets saved under the incoming page.
let activeKey = null;
let renderSeq = 0;
async function render({ keepScroll = false } = {}) {
  if (!ready) return;
  const seq = ++renderSeq;
  const route = currentRoute();
  const key = routeKey();
  if (!keepScroll) activeKey = null;
  const restore = () => {
    if (seq !== renderSeq) return;
    if (!keepScroll) window.scrollTo(0, scrollPos[key] || 0);
    activeKey = key;
  };
  try {
    if (route.page === 'home') {
      setHeader(tv.name || 'TV Owner Settings', false);
      show('view-home');
      restore();
      scheduleVolumeRefresh();
      await Promise.all([renderInputs(), renderApps(), renderQuick()]);
    } else {
      setHeader(route.path ? menuLabel(route.path) : 'All settings', true);
      show('view-settings');
      const pending = renderMenu(route.path);
      restore(); // cached content (if any) is already drawn, so the old position exists
      await pending;
    }
    restore();
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e instanceof NeedsPairing) return needPairing();
    showTrust(UNREACHABLE);
  }
}

// ---- Wiring ------------------------------------------------------------------------------------

$('btn-connect').onclick = () => {
  const ip = $('ip').value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return setStatus('connect-status', 'Enter an address like 192.168.1.50.', 'error');
  connect(ip);
};
$('ip').onkeydown = e => { if (e.key === 'Enter') $('btn-connect').click(); };
$('btn-retry').onclick = () => connect(tv.ip);
$('btn-lna').onclick = requestLocalNetwork;
$('btn-copy-link').onclick = copyTrustLink;
$('btn-change-ip').onclick = () => { $('ip').value = tv.ip || ''; show('view-connect'); };
$('btn-pair-start').onclick = pairStart;
$('btn-pair-finish').onclick = pairFinish;
$('pin').onkeydown = e => { if (e.key === 'Enter') pairFinish(); };
$('btn-pair-cancel').onclick = pairCancel;
$('btn-back').onclick = goBack;
$('vol-slider').oninput = () => { volBusy = true; $('vol-num').textContent = $('vol-slider').value; };
$('vol-slider').onchange = () => setVolume(Number($('vol-slider').value));
$('vol-minus').onclick = () => setVolume(Number($('vol-slider').value) - 1);
$('vol-plus').onclick = () => setVolume(Number($('vol-slider').value) + 1);
$('btn-blank').onclick = blankScreen;
$('btn-numpad').onclick = () => {
  const open = $('numpad').hidden;
  $('numpad').hidden = !open;
  $('btn-numpad').setAttribute('aria-expanded', String(open));
};
$('type-form').onsubmit = async e => {
  e.preventDefault();
  const text = $('type-text').value;
  if (text && await typeText(text)) $('type-text').value = '';
};
$('btn-forget').onclick = () => {
  if (!confirm('Forget this TV on this device? You will need to pair again.')) return;
  tv = { deviceId: tv.deviceId };
  ready = false;
  saveTv();
  history.replaceState({ depth: 0 }, '', '#/');
  $('ip').value = '';
  show('view-connect');
};

// In-app links push history so the browser and Android back buttons step back through menus.
document.addEventListener('click', e => {
  const link = e.target.closest('a[href^="#/"]');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', () => render());
window.addEventListener('scroll', rememberScroll, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ready && currentRoute().page === 'home') { renderInputs(); renderApps(); scheduleVolumeRefresh(); }
});
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
history.replaceState({ depth: 0 }, '', location.hash || '#/');
wireRemote();

if (!tv.deviceId) {
  tv.deviceId = 'owner-web-' + randomHex(6);
  saveTv();
}
if (tv.ip) {
  $('ip').value = tv.ip;
  connect(tv.ip);
} else {
  show('view-connect');
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
