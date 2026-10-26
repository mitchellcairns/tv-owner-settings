'use strict';

// Ports the TV's local API listens on: 7345 on SmartCast 4.0+ firmware, 9000 before that.
const PORTS = [7345, 9000];
const ROOT = 'tv_settings';

// Settings people most often need back after an update. Shown first if the TV has them.
const QUICK = [
  'system/input_at_power_on',
  'system/cec/cec_function',
  'system/cec/one_touch_play',
  'system/cec/device_discovery',
  'system/power_mode',
  'system/timers/auto_power_off_timer',
  'admin_and_privacy/viewing_data',
  'admin_and_privacy/advertising/limit_ad_tracking',
];

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

let tv = store.get('tv') || {};          // { ip, port, token, deviceId, model }
let pairing = null;                       // { reqToken, challenge } while a PIN is on screen
const menuNames = { '': 'All settings' }; // path -> display name, filled as menus load

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

function show(view) {
  for (const id of ['view-connect', 'view-trust', 'view-pair', 'view-settings']) $(id).hidden = id !== view;
  $('btn-forget').hidden = !tv.ip;
  $('tv-label').textContent = tv.ip ? [tv.model, tv.ip].filter(Boolean).join(' · ') : 'Not connected';
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
  node.style.background = isError ? 'var(--danger)' : '';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 3000);
}

// ---- TV API -------------------------------------------------------------------------------

class NeedsPairing extends Error {}

async function request(method, path, body, { ip = tv.ip, port = tv.port, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (tv.token) headers.AUTH = tv.token;
    const res = await fetch(`https://${ip}:${port}${path}`, {
      method, headers, cache: 'no-store', signal: ctrl.signal,
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
    saveTv();
    setStatus('connect-status', '');
    return afterConnect();
  }
  tv.port = tv.port || PORTS[0];
  saveTv();
  showTrust();
}

function showTrust(message) {
  $('trust-link').href = `https://${tv.ip}:${tv.port || PORTS[0]}/state/device/power_mode`;
  setStatus('trust-status', message || '', message ? 'error' : '');
  show('view-trust');
}

async function afterConnect() {
  if (!tv.token) return show('view-pair');
  try {
    const r = await request('GET', `/menu_native/dynamic/${ROOT}`);
    if (result(r) === 'REQUIRES_PAIRING') {
      tv.token = null;
      saveTv();
      setStatus('pair-status', 'The TV no longer recognizes this browser. Pair again.', 'error');
      return show('view-pair');
    }
  } catch {
    return showTrust(UNREACHABLE);
  }
  show('view-settings');
  route();
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
  return (dyn.ITEMS || []).map(it => {
    const m = meta[it.CNAME] || {};
    return { ...m, ...it, ELEMENTS: it.ELEMENTS || m.ELEMENTS, parent: path, path: path ? `${path}/${it.CNAME}` : it.CNAME };
  });
}

const truthy = v => v === true || v === 'TRUE';

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

function renderItem(item, showParent) {
  const row = el('div', 'item');
  const name = el('div', 'name', item.NAME || item.CNAME);
  if (showParent && item.parent) name.append(el('span', 'path', item.parent.split('/').map(p => menuNames[p] || p.replace(/_/g, ' ')).join(' › ')));
  const control = el('div', 'control');
  row.append(name, control);

  const type = item.TYPE || '';
  const locked = isLocked(item);

  if (type.startsWith('T_MENU')) {
    menuNames[item.path] = item.NAME || item.CNAME;
    row.classList.add('menu');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    control.append(el('span', 'chev', '›'));
    row.onclick = () => { location.hash = '#/' + item.path; };
    row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } };
  } else if ((type === 'T_LIST_V1' || type === 'T_LIST_X_V1') && Array.isArray(item.ELEMENTS) && item.ELEMENTS.length) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', item.NAME || item.CNAME);
    const options = item.ELEMENTS.includes(item.VALUE) ? item.ELEMENTS : [item.VALUE, ...item.ELEMENTS];
    for (const opt of options) select.add(new Option(opt, opt, false, opt === item.VALUE));
    select.disabled = locked;
    select.onchange = () => modify(item, select.value, select);
    control.append(select);
  } else if (type.startsWith('T_VALUE') && Number.isFinite(item.MINIMUM) && Number.isFinite(item.MAXIMUM)) {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = item.MINIMUM;
    range.max = item.MAXIMUM;
    range.step = item.INCREMENT || 1;
    range.value = item.VALUE;
    range.setAttribute('aria-label', item.NAME || item.CNAME);
    range.disabled = locked;
    const out = el('output', '', String(item.VALUE));
    range.oninput = () => { out.textContent = range.value; };
    range.onchange = () => modify(item, clampToRange(item, Number(range.value)), range);
    control.append(range, out);
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

const visible = item => !truthy(item.HIDDEN) && !SKIP_TYPES.has(item.TYPE);

async function modify(item, value, control) {
  control.disabled = true;
  try {
    const r = await request('PUT', `/menu_native/dynamic/${ROOT}/${item.path}`, { REQUEST: 'MODIFY', HASHVAL: item.HASHVAL, VALUE: value });
    if (result(r) === 'SUCCESS') toast(`${item.NAME}: ${value}`);
    else toast(`Couldn't change ${item.NAME}: ${detail(r)}`, true);
  } catch {
    toast(UNREACHABLE, true);
  }
  route(); // reload so values and HASHVALs match what the TV now has
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
  setTimeout(route, 1500); // e.g. CEC discovery fills in its results after a moment
}

async function renderQuick() {
  const parents = [...new Set(QUICK.map(p => p.slice(0, p.lastIndexOf('/'))))];
  const menus = await Promise.all(parents.map(p => loadMenu(p).catch(e => { if (e instanceof NeedsPairing) throw e; return []; })));
  const byPath = {};
  for (const item of menus.flat()) byPath[item.path] = item;
  const list = $('quick-list');
  list.replaceChildren(...QUICK.filter(p => byPath[p] && visible(byPath[p])).map(p => renderItem(byPath[p], true)));
  $('quick').hidden = !list.children.length;
}

function renderCrumbs(path) {
  const nav = $('crumbs');
  const parts = path ? path.split('/') : [];
  const links = [['', menuNames['']]];
  parts.forEach((_, i) => {
    const p = parts.slice(0, i + 1).join('/');
    links.push([p, menuNames[p] || parts[i].replace(/_/g, ' ')]);
  });
  nav.replaceChildren();
  links.forEach(([p, label], i) => {
    if (i) nav.append(el('span', '', '›'));
    if (i === links.length - 1) nav.append(el('strong', '', label));
    else {
      const b = el('button', '', label);
      b.onclick = () => { location.hash = p ? '#/' + p : '#/'; };
      nav.append(b);
    }
  });
}

let routeSeq = 0;
async function route() {
  if (!tv.token || $('view-settings').hidden) return;
  const seq = ++routeSeq;
  const path = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  renderCrumbs(path);
  const warn = $('menu-warn');
  warn.hidden = !path.startsWith('network');
  warn.textContent = 'Network settings are read-only here. Changing them could drop the TV off Wi-Fi and cut this page off.';
  $('quick').hidden = !!path;
  try {
    const [items] = await Promise.all([loadMenu(path), path ? null : renderQuick()]);
    if (seq !== routeSeq) return;
    $('menu-list').replaceChildren(...items.filter(visible).map(item => renderItem(item, false)));
    renderCrumbs(path);
  } catch (e) {
    if (e instanceof NeedsPairing) {
      tv.token = null;
      saveTv();
      setStatus('pair-status', 'The TV no longer recognizes this browser. Pair again.', 'error');
      return show('view-pair');
    }
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
$('btn-change-ip').onclick = () => { $('ip').value = tv.ip || ''; show('view-connect'); };
$('btn-pair-start').onclick = pairStart;
$('btn-pair-finish').onclick = pairFinish;
$('pin').onkeydown = e => { if (e.key === 'Enter') pairFinish(); };
$('btn-pair-cancel').onclick = pairCancel;
$('btn-forget').onclick = () => {
  if (!confirm('Forget this TV on this device? You will need to pair again.')) return;
  tv = { deviceId: tv.deviceId };
  saveTv();
  location.hash = '';
  $('ip').value = '';
  show('view-connect');
};
window.addEventListener('hashchange', route);

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
