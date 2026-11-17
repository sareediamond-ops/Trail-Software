import { SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET, SHIPMENT_AGE_DAYS } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const S = {
  session: null,
  status: null,
  tab: 'home',
  sub: { desk: 'incoming', admin: 'shipments' },
  pieceSku: null,
  L: null,
};

const STATE_LABEL = {
  registered: 'Not yet received',
  on_hand: 'On hand',
  out: 'Out with a person',
  awaiting_shipment: 'Awaiting shipment confirmation',
  shipped: 'Shipped',
  at_locker: 'At locker',
};
const KIND_LABEL = {
  incoming: 'Received from factory',
  issue: 'Taken out',
  return: 'Returned',
  ship_handover: 'Taken for shipment',
  ship_return: 'Came back unshipped',
  shipped: 'Shipped',
  to_locker: 'Sent to locker',
  locker_arrived: 'Arrived from locker',
  locker_stay: 'Confirmed still at locker',
  correction: 'Correction',
};

// ---------------------------------------------------------------- helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

let toastTimer;
function toast(msg, bad) {
  $toast.textContent = msg;
  $toast.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, bad ? 6000 : 3000);
}

async function call(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  if (data && data.ok === false) throw new Error(data.message || data.error || 'Something went wrong');
  return data;
}

async function all(table, cols, mod) {
  let out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols || '*');
    if (mod) q = mod(q);
    const { data, error } = await q.order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}

// Runs an action from a button: disables it, shows any error, never fails silently.
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}
function daysSince(ts) {
  return (Date.now() - new Date(ts).getTime()) / 864e5;
}
function fmtSince(ts) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 6e4));
  if (mins < 60) return mins + ' min';
  if (mins < 60 * 24) return Math.round(mins / 60) + ' h';
  return Math.floor(mins / (60 * 24)) + ' d';
}

function askText(title, label, opts) {
  return new Promise((resolve) => {
    const input = h(opts && opts.multiline ? 'textarea' : 'input',
      { type: (opts && opts.type) || 'text', rows: 3, autocomplete: 'off' });
    const dlg = h('dialog', {},
      h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); done(input.value.trim()); } },
        h('h2', { style: 'margin-top:0' }, title),
        h('label', {}, label, input),
        h('div', { class: 'actions' },
          h('button', { class: 'primary', type: 'submit' }, (opts && opts.ok) || 'Save'),
          h('button', { type: 'button', onclick: () => done(null) }, 'Cancel'))));
    function done(v) { dlg.close(); dlg.remove(); resolve(v || null); }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

function selectEl(items, placeholder, labelOf) {
  return h('select', {},
    h('option', { value: '' }, placeholder),
    items.map((it) => h('option', { value: it.id }, labelOf ? labelOf(it) : it.name)));
}
function pinInput() {
  return h('input', {
    type: 'password', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6,
    placeholder: 'Their PIN',
  });
}
function field(label, control) {
  return h('label', {}, label, control);
}

// A search box that builds a list of SKUs.
function skuPicker({ options, allowNew, placeholder }) {
  const selected = [];
  const input = h('input', {
    type: 'search', placeholder: placeholder || 'Type a SKU', autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false',
  });
  const sug = h('div', { class: 'suggest' });
  const chips = h('div', { class: 'chips' });
  const count = h('p', { class: 'muted small', style: 'margin-top:8px' });
  sug.hidden = true;

  function matches(t) {
    return options.filter((o) => o.sku.includes(t) && !selected.includes(o.sku));
  }
  function add(sku) {
    if (!selected.includes(sku)) selected.push(sku);
    input.value = '';
    draw();
    input.focus();
  }
  function drawSug() {
    const t = input.value.trim().toUpperCase();
    if (!t) { sug.hidden = true; return; }
    const kids = matches(t).slice(0, 30).map((o) =>
      h('button', { type: 'button', onclick: () => add(o.sku) },
        h('span', { class: 'sku' }, o.sku), h('span', { class: 'muted small' }, o.sub || '')));
    if (allowNew && !options.some((o) => o.sku === t) && !selected.includes(t)) {
      kids.push(h('button', { type: 'button', onclick: () => add(t) }, 'Add new SKU "' + t + '"'));
    }
    sug.replaceChildren(...kids);
    sug.hidden = kids.length === 0;
  }
  function draw() {
    chips.replaceChildren(...selected.map((s) =>
      h('span', { class: 'chip' }, s,
        h('button', {
          type: 'button', 'aria-label': 'Remove ' + s,
          onclick: () => { selected.splice(selected.indexOf(s), 1); draw(); },
        }, '×'))));
    count.textContent = selected.length + ' selected';
    drawSug();
  }
  input.addEventListener('input', drawSug);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = input.value.trim().toUpperCase();
    if (!t) return;
    if (options.some((o) => o.sku === t) && !selected.includes(t)) return add(t);
    const m = matches(t);
    if (m.length === 1) return add(m[0].sku);
    if (allowNew && !selected.includes(t)) add(t);
  });
  draw();
  return {
    el: h('div', {}, input, sug, chips, count),
    get value() { return [...selected]; },
  };
}

async function signedUrls(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(list, 3600);
  if (error) return {};
  const map = {};
  for (const d of data) if (d.signedUrl) map[d.path] = d.signedUrl;
  return map;
}

// Shrinks a photo in the browser before upload, so storage stays small.
async function compressPhoto(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo'))), 'image/jpeg', 0.75));
}
async function uploadPhoto(sku, file) {
  const blob = await compressPhoto(file);
  const path = sku.replace(/[^A-Z0-9_-]/gi, '_') + '-' + Date.now() + '.jpg';
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error('Photo upload failed: ' + error.message);
  return path;
}

async function loadLists() {
  const [people, factories, purposes, profiles] = await Promise.all([
    all('people'), all('factories'), all('purposes'), all('profiles'),
  ]);
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
  S.L = {
    people, factories, purposes, profiles,
    person: byId(people), factory: byId(factories), purpose: byId(purposes), profile: byId(profiles),
    activePeople: people.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name)),
    activeFactories: factories.filter((f) => f.active),
    activePurposes: purposes.filter((p) => p.active),
  };
}
const personName = (id) => (S.L.person[id] ? S.L.person[id].name : 'nobody recorded');
const purposeName = (id) => (S.L.purpose[id] ? S.L.purpose[id].name : '');
const accountName = (id) => (S.L.profile[id] ? S.L.profile[id].full_name : 'unknown account');
const isAdmin = () => S.status && S.status.profile && S.status.profile.role === 'admin';

// ---------------------------------------------------------------- shell

async function boot() {
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((_event, session) => {
    const before = S.session && S.session.user.id;
    const after = session && session.user.id;
    S.session = session;
    if (before !== after) setTimeout(start, 0);
  });
  await start();
}

async function start() {
  if (!S.session) return renderLogin();
  try {
    S.status = await call('app_status');
  } catch (e) {
    return $app.replaceChildren(h('main', {}, h('div', { class: 'card narrow' },
      h('h1', {}, 'Cannot reach the database'), h('p', {}, e.message),
      h('p', { class: 'muted' }, 'If this is a new setup, run supabase/schema.sql in the Supabase SQL editor first.'),
      h('button', { onclick: () => sb.auth.signOut() }, 'Sign out'))));
  }
  const p = S.status.profile;
  if (!p && !S.status.any_profiles) return renderBootstrap();
  if (!p || !p.active) {
    return $app.replaceChildren(h('main', {}, h('div', { class: 'card narrow' },
      h('h1', {}, p ? 'Account deactivated' : 'No access yet'),
      h('p', {}, p ? 'An admin has deactivated this account.' : 'Ask an admin to create your account in Trail.'),
      h('button', { onclick: () => sb.auth.signOut() }, 'Sign out'))));
  }
  await render();
}

function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  $app.replaceChildren(h('main', {}, h('form', {
    class: 'card narrow',
    onsubmit: (e) => {
      e.preventDefault();
      act(btn, async () => {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if (error) throw new Error(error.message);
      });
    },
  }, h('h1', {}, 'Trail'), h('p', { class: 'muted' }, 'Jewelry custody tracker'),
  field('Email', email), field('Password', pass), h('div', { class: 'actions' }, btn))));
}

function renderBootstrap() {
  const name = h('input', { type: 'text', required: true, autocomplete: 'name' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Become the first admin');
  $app.replaceChildren(h('main', {}, h('form', {
    class: 'card narrow',
    onsubmit: (e) => {
      e.preventDefault();
      act(btn, async () => { await call('bootstrap_first_admin', { p_name: name.value }); await start(); });
    },
  }, h('h1', {}, 'First-time setup'),
  h('p', {}, 'No accounts exist yet. This login will become the first admin. This works only once.'),
  field('Your full name', name), h('div', { class: 'actions' }, btn))));
}

const TABS = [
  { id: 'home', label: 'Dashboard' },
  { id: 'desk', label: 'Desk' },
  { id: 'pieces', label: 'Pieces' },
  { id: 'admin', label: 'Admin', admin: true },
];

async function render() {
  const p = S.status.profile;
  const main = h('main', {}, h('p', { class: 'muted' }, 'Loading…'));
  $app.replaceChildren(
    h('header', { class: 'top' },
      h('span', { class: 'brand' }, 'TRAIL'),
      h('span', { class: 'who' }, p.full_name, h('br'), p.role),
      h('button', { class: 'sm', onclick: () => sb.auth.signOut() }, 'Sign out')),
    h('nav', { class: 'tabs' }, TABS.filter((t) => !t.admin || isAdmin()).map((t) =>
      h('button', { class: S.tab === t.id ? 'on' : '', onclick: () => { S.tab = t.id; S.pieceSku = null; render(); } }, t.label))),
    main);
  try {
    await loadLists();
    const view = { home: viewHome, desk: viewDesk, pieces: viewPieces, admin: viewAdmin }[S.tab];
    const kids = [await view()].flat(Infinity).filter((k) => k != null && k !== false);
    main.replaceChildren(...kids);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'notice bad' }, e.message || String(e)),
      h('button', { onclick: render }, 'Try again'));
  }
}

function subtabs(key, items) {
  return h('nav', { class: 'subtabs' }, items.map((it) =>
    h('button', { class: S.sub[key] === it.id ? 'on' : '', onclick: () => { S.sub[key] = it.id; render(); } }, it.label)));
}

// ---------------------------------------------------------------- dashboard

function cardText(c) {
  const d = c.details || {};
  if (c.kind === 'tally_mismatch') {
    const missing = (d.missing || []).map((m) => m.sku + ' (last with ' + personName(m.last_person) + ')');
    return {
      title: 'Tally does not match',
      body: [
        'Counted ' + d.counted + ', software expected ' + d.expected + '.',
        missing.length ? 'Missing: ' + missing.join(', ') + '.' : '',
        (d.extra || []).length ? 'Entered but not on hand: ' + d.extra.join(', ') + '.' : '',
      ],
    };
  }
  if (c.kind === 'locker_unaccounted') {
    return {
      title: d.sku + ' is unaccounted for',
      body: ['It did not arrive from the locker and nobody confirmed it stayed.',
        'Carried to the locker by ' + personName(d.carried_by) + '.'],
    };
  }
  if (c.kind === 'locker_overdue') {
    return {
      title: d.sku + ' has been at the locker over 3 days',
      body: ['At the locker for ' + Math.floor(daysSince(d.since)) + ' days.',
        d.last_source ? 'Last confirmed by ' + personName(d.last_source) + '.'
          : 'Carried there by ' + personName(d.carried_by) + '.'],
    };
  }
  return {
    title: d.sku + ' is still out',
    body: ['With ' + personName(d.person_id) + ' for ' + (purposeName(d.purpose_id) || 'no purpose') +
      ', since ' + fmtDate(d.since) + '.', 'No piece may stay out overnight.'],
  };
}

async function viewHome() {
  await call('refresh_cards');
  const [cards, pieces] = await Promise.all([
    all('red_cards', '*', (q) => q.is('resolved_at', null)),
    all('pieces', '*', (q) => q.neq('state', 'shipped')),
  ]);
  const by = (st) => pieces.filter((p) => p.state === st);
  const out = by('out'), waiting = by('awaiting_shipment'), locker = by('at_locker');

  const cardEls = cards.map((c) => {
    const t = cardText(c);
    return h('div', { class: 'redcard', role: 'alert' },
      h('h3', {}, t.title), t.body.filter(Boolean).map((b) => h('p', {}, b)),
      h('p', { class: 'small muted' }, 'Raised ' + fmtDate(c.raised_at)),
      isAdmin() && h('button', {
        class: 'sm',
        onclick: (e) => act(e.target, async () => {
          const reason = await askText('Resolve this card', 'Reason', { multiline: true, ok: 'Resolve' });
          if (!reason) return;
          await call('resolve_card', { p_id: c.id, p_reason: reason });
          toast('Card resolved');
          render();
        }),
      }, 'Resolve'));
  });

  const section = (title, rows, line) => h('div', { class: 'card' },
    h('h2', { style: 'margin-top:0' }, title + ' (' + rows.length + ')'),
    rows.length ? h('ul', { class: 'list' }, rows.map(line)) : h('p', { class: 'muted' }, 'None.'));

  return [
    cardEls,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, by('on_hand').length), h('span', {}, 'On hand')),
      h('div', { class: 'stat' }, h('b', {}, out.length), h('span', {}, 'Out with people')),
      h('div', { class: 'stat' }, h('b', {}, waiting.length), h('span', {}, 'Awaiting shipment')),
      h('div', { class: 'stat' }, h('b', {}, locker.length), h('span', {}, 'At locker'))),
    section('Open items', out, (p) => h('li', {},
      h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
        h('div', { class: 'sub' }, personName(p.holder_id) + ' · ' + purposeName(p.purpose_id))),
      h('span', { class: 'pill' }, fmtSince(p.state_since)))),
    section('Awaiting shipment confirmation', waiting, (p) => {
      const late = daysSince(p.state_since) >= SHIPMENT_AGE_DAYS;
      return h('li', {},
        h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
          h('div', { class: 'sub' }, 'Taken by ' + personName(p.holder_id))),
        h('span', { class: 'pill' + (late ? ' amber' : '') }, fmtSince(p.state_since)));
    }),
    section('At locker', locker, (p) => h('li', {},
      h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
        h('div', { class: 'sub' }, 'Carried by ' + personName(p.holder_id))),
      h('span', { class: 'pill' + (daysSince(p.state_since) > 3 ? ' red' : '') }, fmtSince(p.state_since)))),
  ];
}

// ---------------------------------------------------------------- desk

async function viewDesk() {
  const tabs = subtabs('desk', [
    { id: 'morning', label: 'Morning' },
    { id: 'incoming', label: 'Incoming' },
    { id: 'outgoing', label: 'Outgoing' },
    { id: 'return', label: 'Return' },
    { id: 'eod', label: 'End of day' },
  ]);
  const pieces = await all('pieces', '*', (q) => q.neq('state', 'shipped'));
  const view = { morning: deskMorning, incoming: deskIncoming, outgoing: deskOutgoing, return: deskReturn, eod: deskEod }[S.sub.desk];
  return [tabs, await view(pieces)];
}

function deskIncoming(pieces) {
  const factory = selectEl(S.L.activeFactories, 'Pick a factory');
  const person = selectEl(S.L.activePeople, 'Who brought them?');
  const picker = skuPicker({
    options: pieces.filter((p) => p.state === 'registered').map((p) => ({ sku: p.sku, sub: 'not yet received' })),
    allowNew: true, placeholder: 'Type each SKU and press Enter',
  });
  const pin = pinInput();
  const btn = h('button', { class: 'primary' }, 'Receive pieces');
  btn.onclick = () => act(btn, async () => {
    const r = await call('receive_from_factory', {
      p_factory: Number(factory.value) || null, p_person: Number(person.value) || null,
      p_pin: pin.value, p_skus: picker.value,
    });
    toast(r.count + ' pieces received');
    render();
  });
  return h('div', { class: 'card' },
    h('h1', {}, 'Incoming: new from factory'),
    S.L.activeFactories.length ? null : h('div', { class: 'notice bad' }, 'No factories yet. An admin must add them under Admin → Lists.'),
    h('div', { class: 'row' }, field('Factory', factory), field('Brought by', person)),
    field('SKUs received', picker.el),
    field('Confirm with PIN', pin),
    h('div', { class: 'actions' }, btn));
}

function deskOutgoing(pieces) {
  const person = selectEl(S.L.activePeople, 'Who is taking them?');
  const purpose = selectEl(S.L.activePurposes, 'Pick a purpose');
  const picker = skuPicker({
    options: pieces.filter((p) => p.state === 'on_hand').map((p) => ({ sku: p.sku })),
    placeholder: 'Search pieces on hand',
  });
  const pin = pinInput();
  const btn = h('button', { class: 'primary' }, 'Hand over');
  btn.onclick = () => act(btn, async () => {
    const r = await call('issue_pieces', {
      p_person: Number(person.value) || null, p_pin: pin.value,
      p_purpose: Number(purpose.value) || null, p_skus: picker.value,
    });
    toast(r.count + ' pieces handed over');
    render();
  });
  return h('div', { class: 'card' },
    h('h1', {}, 'Outgoing'),
    h('p', { class: 'muted' }, 'Choosing the Shipment purpose removes the pieces from stock until an admin enters the tracking ID.'),
    h('div', { class: 'row' }, field('Taken by', person), field('Purpose', purpose)),
    field('Pieces', picker.el),
    field('Confirm with PIN', pin),
    h('div', { class: 'actions' }, btn));
}

function deskReturn(pieces) {
  const held = pieces.filter((p) => p.state === 'out' || p.state === 'awaiting_shipment');
  const holders = S.L.people.filter((pp) => held.some((p) => p.holder_id === pp.id));
  const person = selectEl(holders, holders.length ? 'Who is returning?' : 'Nobody is holding pieces');
  const listBox = h('div', {});
  const pin = pinInput();
  const btn = h('button', { class: 'primary' }, 'Take back');
  let boxes = [];
  person.onchange = async () => {
    const mine = held.filter((p) => p.holder_id === Number(person.value));
    const urls = await signedUrls(mine.map((p) => p.photo_path));
    boxes = mine.map((p) => ({ sku: p.sku, box: h('input', { type: 'checkbox', class: 'check' }) }));
    listBox.replaceChildren(mine.length ? h('ul', { class: 'list' }, mine.map((p, i) => h('li', {},
      boxes[i].box,
      urls[p.photo_path] ? h('img', { class: 'thumb', src: urls[p.photo_path], alt: 'Photo of ' + p.sku }) : h('div', { class: 'thumb' }),
      h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
        h('div', { class: 'sub' }, (p.state === 'awaiting_shipment' ? 'For shipment' : purposeName(p.purpose_id)) +
          ' · out ' + fmtSince(p.state_since)))))) : '');
  };
  btn.onclick = () => act(btn, async () => {
    const skus = boxes.filter((b) => b.box.checked).map((b) => b.sku);
    if (!skus.length) throw new Error('Tick the pieces being returned');
    const r = await call('return_pieces', { p_person: Number(person.value) || null, p_pin: pin.value, p_skus: skus });
    toast(r.count + ' pieces returned');
    render();
  });
  return h('div', { class: 'card' },
    h('h1', {}, 'Return'),
    h('p', { class: 'muted' }, 'Compare each piece with its photo before ticking it.'),
    field('Returned by', person), listBox,
    field('Confirm with PIN', pin),
    h('div', { class: 'actions' }, btn));
}

function deskMorning(pieces) {
  const locker = pieces.filter((p) => p.state === 'at_locker');
  if (!locker.length) {
    return h('div', { class: 'card' }, h('h1', {}, 'Morning: returning from locker'),
      h('p', { class: 'muted' }, 'Nothing is at the locker.'));
  }
  const carrier = selectEl(S.L.activePeople, 'Who carried them back?');
  const source = selectEl(S.L.activePeople, 'Who said they stayed?');
  const pin = pinInput();
  const btn = h('button', { class: 'primary' }, 'Save morning check');
  const rows = locker.map((p) => {
    const name = 'mark-' + p.id;
    const opt = (v, label) => h('label', {}, h('input', { type: 'radio', name, value: v }), label);
    return {
      sku: p.sku,
      el: h('li', {},
        h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
          h('div', { class: 'sub' }, 'At locker ' + fmtSince(p.state_since) + ' · carried by ' + personName(p.holder_id))),
        h('div', { class: 'choices' }, opt('arrived', 'Arrived'), opt('stay', 'Still at locker'), opt('missing', 'Missing'))),
    };
  });
  btn.onclick = () => act(btn, async () => {
    const marks = { arrived: [], stay: [], missing: [] };
    for (const r of rows) {
      const picked = r.el.querySelector('input:checked');
      if (!picked) throw new Error('Mark every piece. ' + r.sku + ' has no mark.');
      marks[picked.value].push(r.sku);
    }
    const res = await call('morning_locker', {
      p_arrived: marks.arrived, p_stay: marks.stay, p_missing: marks.missing,
      p_carrier: Number(carrier.value) || null, p_pin: pin.value, p_source: Number(source.value) || null,
    });
    toast(res.arrived + ' arrived, ' + res.stay + ' still at locker, ' + res.missing + ' missing', res.missing > 0);
    render();
  });
  return h('div', { class: 'card' },
    h('h1', {}, 'Morning: returning from locker'),
    h('p', { class: 'muted' }, 'Mark every piece. A piece marked Missing raises a red card.'),
    h('ul', { class: 'list' }, rows.map((r) => r.el)),
    h('div', { class: 'row' },
      field('Carried back by (needed if any arrived)', carrier),
      field('Confirm with their PIN', pin)),
    field('Who said the rest stayed (needed if any still at locker)', source),
    h('div', { class: 'actions' }, btn));
}

function deskEod(pieces) {
  const count = h('input', { type: 'number', min: 0, inputmode: 'numeric', placeholder: 'How many pieces are in your hand?' });
  const picker = skuPicker({
    options: pieces.filter((p) => p.state !== 'registered').map((p) => ({ sku: p.sku })),
    placeholder: 'Type each SKU in your hand',
  });
  const result = h('div', {});
  const btn = h('button', { class: 'primary' }, 'Compare with software');
  btn.onclick = () => act(btn, async () => {
    if (count.value === '') throw new Error('Enter your physical count first');
    const r = await call('desk_tally', { p_kind: 'eod', p_count: Number(count.value), p_skus: picker.value });
    if (!r.matched) {
      result.replaceChildren(h('div', { class: 'notice bad' },
        h('b', {}, 'Does not match. A red card has been raised.'),
        h('p', {}, 'Software expected ' + r.expected + ' pieces.'),
        r.missing.length ? h('p', {}, 'On hand in software but not entered: ' + r.missing.join(', ')) : null,
        r.extra.length ? h('p', {}, 'Entered but not on hand in software: ' + r.extra.join(', ')) : null,
        h('p', {}, 'Recount and compare again.')));
      return;
    }
    if (r.expected === 0) {
      result.replaceChildren(h('div', { class: 'notice ok' }, 'Tally matches. Nothing is on hand, so nothing goes to the locker.'));
      return;
    }
    const carrier = selectEl(S.L.activePeople, 'Who is carrying them to the locker?');
    const pin = pinInput();
    const send = h('button', { class: 'primary' }, 'Send ' + r.expected + ' pieces to locker');
    send.onclick = () => act(send, async () => {
      const res = await call('send_to_locker', { p_person: Number(carrier.value) || null, p_pin: pin.value });
      toast(res.count + ' pieces sent to locker');
      render();
    });
    result.replaceChildren(
      h('div', { class: 'notice ok' }, 'Tally matches: ' + r.expected + ' pieces.'),
      h('div', { class: 'row' }, field('Carried by', carrier), field('Confirm with PIN', pin)),
      h('div', { class: 'actions' }, send));
  });
  return h('div', { class: 'card' },
    h('h1', {}, 'End of day: tally and locker'),
    h('p', { class: 'muted' }, 'Count the pieces physically first. The software shows its own list only after you compare.'),
    field('Physical count', count),
    field('SKUs in hand', picker.el),
    h('div', { class: 'actions' }, btn),
    result);
}

// ---------------------------------------------------------------- pieces

async function viewPieces() {
  if (S.pieceSku) return viewPiece(S.pieceSku);
  const pieces = await all('pieces');
  const search = h('input', { type: 'search', placeholder: 'Search SKU', autocapitalize: 'characters' });
  const filter = h('select', {}, h('option', { value: '' }, 'All states'),
    Object.entries(STATE_LABEL).map(([k, v]) => h('option', { value: k }, v)));
  const listBox = h('div', {});
  function draw() {
    const t = search.value.trim().toUpperCase();
    const rows = pieces.filter((p) => (!t || p.sku.includes(t)) && (!filter.value || p.state === filter.value));
    listBox.replaceChildren(
      h('p', { class: 'muted small' }, rows.length + ' pieces' + (rows.length > 200 ? ', showing the first 200' : '')),
      h('ul', { class: 'list' }, rows.slice(0, 200).map((p) => h('li', {},
        h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
          h('div', { class: 'sub' }, STATE_LABEL[p.state] + (p.holder_id && p.state !== 'on_hand' ? ' · ' + personName(p.holder_id) : ''))),
        p.photo_path ? null : h('span', { class: 'pill amber' }, 'No photo'),
        h('button', { class: 'sm', onclick: () => { S.pieceSku = p.sku; render(); } }, 'Open')))));
  }
  search.oninput = draw;
  filter.onchange = draw;
  draw();

  const sku = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off' });
  const photo = h('input', { type: 'file', accept: 'image/*' });
  const add = h('button', { class: 'primary' }, 'Add SKU');
  add.onclick = () => act(add, async () => {
    const s = sku.value.trim().toUpperCase();
    if (!s) throw new Error('Enter a SKU');
    if (pieces.some((p) => p.sku === s)) throw new Error('SKU ' + s + ' already exists');
    const path = photo.files[0] ? await uploadPhoto(s, photo.files[0]) : null;
    await call('add_piece', { p_sku: s, p_photo_path: path });
    toast('SKU ' + s + ' added');
    render();
  });
  return [
    h('div', { class: 'card' }, h('h1', {}, 'Add a new SKU'),
      h('div', { class: 'row' }, field('SKU', sku), field('Photo', photo)),
      h('div', { class: 'actions' }, add)),
    h('div', { class: 'card' }, h('h1', {}, 'All pieces'),
      h('div', { class: 'row' }, search, filter), listBox),
  ];
}

async function viewPiece(sku) {
  const { data: piece, error } = await sb.from('pieces').select('*').eq('sku', sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!piece) throw new Error('SKU not found');
  const moves = await all('movements', '*', (q) => q.eq('piece_id', piece.id));
  const urls = await signedUrls([piece.photo_path]);
  const file = h('input', { type: 'file', accept: 'image/*' });
  const save = h('button', {}, piece.photo_path ? 'Replace photo' : 'Add photo');
  save.onclick = () => act(save, async () => {
    if (!file.files[0]) throw new Error('Choose a photo first');
    const path = await uploadPhoto(piece.sku, file.files[0]);
    await call('set_piece_photo', { p_sku: piece.sku, p_photo_path: path });
    toast('Photo saved');
    render();
  });
  return [
    h('button', { class: 'sm', onclick: () => { S.pieceSku = null; render(); } }, '← All pieces'),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('h1', {}, piece.sku),
      h('p', {}, h('span', { class: 'pill green' }, STATE_LABEL[piece.state]),
        piece.holder_id && piece.state !== 'on_hand' ? ' ' + personName(piece.holder_id) : '',
        ' · since ' + fmtDate(piece.state_since)),
      urls[piece.photo_path] ? h('img', { class: 'photo', src: urls[piece.photo_path], alt: 'Photo of ' + piece.sku })
        : h('p', { class: 'muted' }, 'No photo yet.'),
      h('div', { class: 'row', style: 'margin-top:12px' }, file, save)),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'History'),
      moves.length ? h('ul', { class: 'list' }, moves.slice().reverse().map((m) => h('li', {},
        h('div', { class: 'grow' + (m.voided ? ' strike' : '') },
          h('div', {}, h('b', {}, KIND_LABEL[m.kind] || m.kind),
            m.person_id ? ' · ' + personName(m.person_id) : '',
            m.purpose_id ? ' · ' + purposeName(m.purpose_id) : '',
            m.factory_id && S.L.factory[m.factory_id] ? ' · ' + S.L.factory[m.factory_id].name : ''),
          h('div', { class: 'sub' }, fmtDate(m.created_at) + ' · entered by ' + accountName(m.account_id) +
            (m.note ? ' · ' + m.note : ''))),
        m.edited ? h('span', { class: 'pill amber' }, 'Edited') : null,
        m.voided ? h('span', { class: 'pill red' }, 'Deleted') : null)))
        : h('p', { class: 'muted' }, 'No movements yet.')),
  ];
}

// ---------------------------------------------------------------- admin

async function viewAdmin() {
  if (!isAdmin()) throw new Error('Only an admin can open this');
  const tabs = subtabs('admin', [
    { id: 'shipments', label: 'Tracking IDs' },
    { id: 'people', label: 'People & PINs' },
    { id: 'lists', label: 'Lists' },
    { id: 'accounts', label: 'Accounts' },
    { id: 'log', label: 'Log' },
    { id: 'export', label: 'Export' },
  ]);
  const view = {
    shipments: adminShipments, people: adminPeople, lists: adminLists,
    accounts: adminAccounts, log: adminLog, export: adminExport,
  }[S.sub.admin];
  return [tabs, await view()];
}

async function adminShipments() {
  const waiting = await all('pieces', '*', (q) => q.eq('state', 'awaiting_shipment'));
  const { data: recent, error } = await sb.from('shipments')
    .select('tracking_id, entered_at, entered_by, pieces(sku)').order('entered_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  const boxes = waiting.map((p) => ({ sku: p.sku, box: h('input', { type: 'checkbox', class: 'check' }) }));
  const tracking = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Tracking ID' });
  const btn = h('button', { class: 'primary' }, 'Mark as shipped');
  btn.onclick = () => act(btn, async () => {
    const skus = boxes.filter((b) => b.box.checked).map((b) => b.sku);
    const r = await call('mark_shipped', { p_skus: skus, p_tracking: tracking.value });
    toast(r.count + ' pieces marked shipped');
    render();
  });
  return [
    h('div', { class: 'card' }, h('h1', {}, 'Awaiting shipment confirmation'),
      waiting.length ? [
        h('p', { class: 'muted' }, 'Tick the pieces in one parcel. Several pieces can share one tracking ID.'),
        h('ul', { class: 'list' }, waiting.map((p, i) => {
          const late = daysSince(p.state_since) >= SHIPMENT_AGE_DAYS;
          return h('li', {}, boxes[i].box,
            h('div', { class: 'grow' }, h('div', { class: 'sku' }, p.sku),
              h('div', { class: 'sub' }, 'Taken by ' + personName(p.holder_id))),
            h('span', { class: 'pill' + (late ? ' amber' : '') }, fmtSince(p.state_since)));
        })),
        field('Tracking ID', tracking), h('div', { class: 'actions' }, btn),
      ] : h('p', { class: 'muted' }, 'Nothing is waiting.')),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Last 50 shipped'),
      recent.length ? h('ul', { class: 'list' }, recent.map((s) => h('li', {},
        h('div', { class: 'grow' }, h('div', { class: 'sku' }, s.pieces ? s.pieces.sku : ''),
          h('div', { class: 'sub' }, s.tracking_id + ' · ' + fmtDate(s.entered_at) + ' · ' + accountName(s.entered_by))))))
        : h('p', { class: 'muted' }, 'None yet.')),
  ];
}

async function adminPeople() {
  const name = h('input', { type: 'text', autocomplete: 'off' });
  const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'new-password', placeholder: '4 to 6 digits' });
  const add = h('button', { class: 'primary' }, 'Add person');
  add.onclick = () => act(add, async () => {
    await call('add_person', { p_name: name.value, p_pin: pin.value });
    toast('Person added');
    render();
  });
  return [
    h('div', { class: 'card' }, h('h1', {}, 'Add a person'),
      h('p', { class: 'muted' }, 'Let the person type their own PIN. Nobody can read it afterwards, not even an admin.'),
      h('div', { class: 'row' }, field('Name', name), field('PIN', pin)),
      h('div', { class: 'actions' }, add)),
    h('div', { class: 'card' }, h('h1', {}, 'People'),
      S.L.people.length ? h('ul', { class: 'list' }, S.L.people.map((p) => h('li', {},
        h('div', { class: 'grow' }, h('b', {}, p.name), ' ',
          p.active ? null : h('span', { class: 'pill' }, 'Inactive'),
          p.pin_locked ? h('span', { class: 'pill red' }, 'PIN locked') : null),
        h('button', {
          class: 'sm',
          onclick: (e) => act(e.target, async () => {
            const v = await askText('New PIN for ' + p.name, 'PIN (4 to 6 digits), typed by ' + p.name, { type: 'password' });
            if (!v) return;
            await call('set_person_pin', { p_id: p.id, p_pin: v });
            toast('PIN reset');
            render();
          }),
        }, 'Reset PIN'),
        h('button', {
          class: 'sm' + (p.active ? ' danger' : ''),
          onclick: (e) => act(e.target, async () => {
            await call('set_person_active', { p_id: p.id, p_active: !p.active });
            render();
          }),
        }, p.active ? 'Remove' : 'Restore'))))
        : h('p', { class: 'muted' }, 'No people yet.')),
  ];
}

async function adminLists() {
  const block = (title, rows, addFn, toggleFn, extra) => {
    const name = h('input', { type: 'text', autocomplete: 'off', placeholder: 'New name' });
    const flag = extra ? h('input', { type: 'checkbox', class: 'check' }) : null;
    const add = h('button', { class: 'primary' }, 'Add');
    add.onclick = () => act(add, async () => { await addFn(name.value, flag && flag.checked); render(); });
    return h('div', { class: 'card' }, h('h1', {}, title),
      h('ul', { class: 'list' }, rows.map((r) => h('li', {},
        h('div', { class: 'grow' }, h('b', {}, r.name), ' ',
          r.is_shipment ? h('span', { class: 'pill green' }, 'Shipment') : null,
          r.active ? null : h('span', { class: 'pill' }, 'Removed')),
        h('button', {
          class: 'sm' + (r.active ? ' danger' : ''),
          onclick: (e) => act(e.target, async () => { await toggleFn(r.id, !r.active); render(); }),
        }, r.active ? 'Remove' : 'Restore')))),
      h('div', { class: 'row', style: 'margin-top:10px' }, name,
        extra ? h('label', { style: 'margin:0;display:flex;align-items:center;gap:8px' }, flag, extra) : null),
      h('div', { class: 'actions' }, add));
  };
  return [
    block('Factories', S.L.factories,
      (n) => call('add_factory', { p_name: n }),
      (id, a) => call('set_factory_active', { p_id: id, p_active: a })),
    block('Purposes', S.L.purposes,
      (n, ship) => call('add_purpose', { p_name: n, p_is_shipment: !!ship }),
      (id, a) => call('set_purpose_active', { p_id: id, p_active: a }),
      'This purpose is a shipment'),
    h('p', { class: 'muted small' }, 'Removed values disappear from the dropdowns but stay in the history.'),
  ];
}

async function serverCall(body) {
  const res = await fetch('/.netlify/functions/admin-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.session.access_token },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error(data.error || 'The server function failed (' + res.status + ')');
  return data;
}

async function adminAccounts() {
  const name = h('input', { type: 'text', autocomplete: 'off' });
  const email = h('input', { type: 'email', autocomplete: 'off' });
  const pass = h('input', { type: 'text', autocomplete: 'off', placeholder: 'At least 8 characters' });
  const role = h('select', {}, h('option', { value: 'staff' }, 'Staff'), h('option', { value: 'admin' }, 'Admin'));
  const add = h('button', { class: 'primary' }, 'Create account');
  add.onclick = () => act(add, async () => {
    await serverCall({ action: 'create', full_name: name.value, email: email.value, password: pass.value, role: role.value });
    toast('Account created');
    render();
  });
  const me = S.session.user.id;
  return [
    h('div', { class: 'card' }, h('h1', {}, 'Create an account'),
      h('div', { class: 'row' }, field('Full name', name), field('Email', email)),
      h('div', { class: 'row' }, field('Starting password', pass), field('Role', role)),
      h('div', { class: 'actions' }, add)),
    h('div', { class: 'card' }, h('h1', {}, 'Accounts'),
      h('ul', { class: 'list' }, S.L.profiles.map((p) => h('li', {},
        h('div', { class: 'grow' }, h('b', {}, p.full_name), ' ',
          h('span', { class: 'pill' + (p.role === 'admin' ? ' green' : '') }, p.role),
          p.active ? null : h('span', { class: 'pill red' }, 'Deactivated'),
          h('div', { class: 'sub' }, p.email + (p.id === me ? ' · you' : ''))),
        h('button', {
          class: 'sm',
          onclick: (e) => act(e.target, async () => {
            const to = p.role === 'admin' ? 'staff' : 'admin';
            const reason = await askText('Make ' + p.full_name + ' ' + to, 'Reason');
            if (!reason) return;
            await call('admin_set_account', { p_id: p.id, p_role: to, p_active: p.active, p_reason: reason });
            render();
          }),
        }, p.role === 'admin' ? 'Make staff' : 'Make admin'),
        h('button', {
          class: 'sm',
          onclick: (e) => act(e.target, async () => {
            const v = await askText('New password for ' + p.full_name, 'Password (at least 8 characters)');
            if (!v) return;
            await serverCall({ action: 'reset_password', user_id: p.id, password: v });
            toast('Password changed');
          }),
        }, 'Reset password'),
        h('button', {
          class: 'sm' + (p.active ? ' danger' : ''),
          onclick: (e) => act(e.target, async () => {
            const reason = await askText((p.active ? 'Deactivate ' : 'Reactivate ') + p.full_name, 'Reason');
            if (!reason) return;
            await call('admin_set_account', { p_id: p.id, p_role: p.role, p_active: !p.active, p_reason: reason });
            render();
          }),
        }, p.active ? 'Deactivate' : 'Reactivate'))))),
  ];
}

async function adminLog() {
  const { data, error } = await sb.from('audit_log').select('*').order('id', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  const brief = (v) => (v == null ? '' : JSON.stringify(v));
  return h('div', { class: 'card' }, h('h1', {}, 'Log'),
    h('p', { class: 'muted' }, 'The last 200 entries. Nobody can edit or delete this log.'),
    h('div', { class: 'scroll' }, h('table', { class: 'log' },
      h('thead', {}, h('tr', {}, ['When', 'Account', 'Action', 'On', 'Reason', 'Before', 'After'].map((t) => h('th', {}, t)))),
      h('tbody', {}, data.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.at)), h('td', {}, r.account_id ? accountName(r.account_id) : 'server'),
        h('td', {}, r.action), h('td', {}, r.entity + ' ' + (r.entity_id || '')),
        h('td', {}, r.reason || ''), h('td', {}, brief(r.old_value)), h('td', {}, brief(r.new_value))))))));
}

async function adminExport() {
  const btn = h('button', { class: 'primary' }, 'Download everything');
  btn.onclick = () => act(btn, async () => {
    const tables = ['profiles', 'people', 'factories', 'purposes', 'pieces', 'movements', 'tallies', 'red_cards', 'shipments', 'audit_log'];
    const dump = { exported_at: new Date().toISOString() };
    for (const t of tables) {
      dump[t] = t === 'shipments' ? await allShipments() : await all(t);
    }
    const blob = new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'trail-export-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Export downloaded');
  });
  return h('div', { class: 'card' }, h('h1', {}, 'Export'),
    h('p', {}, 'Downloads the full trail as one file. On the free Supabase plan this is your only backup, so do it once a week and keep the file somewhere safe.'),
    h('p', { class: 'muted' }, 'The file contains tracking IDs. Treat it as confidential.'),
    h('div', { class: 'actions' }, btn));
}

async function allShipments() {
  let out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('shipments').select('*').order('piece_id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}

boot().catch((e) => {
  $app.replaceChildren(h('main', {}, h('div', { class: 'notice bad' }, e.message || String(e))));
});
