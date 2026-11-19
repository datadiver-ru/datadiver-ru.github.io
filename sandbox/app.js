'use strict';
/*
 * Клиент «Одем». Без фреймворков и сторонних скриптов.
 * Безопасность интерфейса: DOM строится только через createElement/textContent (никакого innerHTML),
 * CSP + Trusted Types на сервере запрещают внедрение скриптов, при бездействии — автоблокировка
 * с очисткой всех данных со страницы.
 */
(() => {
  // ======================= Язык интерфейса =======================
  // Исходный язык — русский. Английский словарь — /i18n-en.js (window.ODEM_EN): ключ — русская строка,
  // в шаблонах подстановки {0}, {1}… Выбор хранится в этом браузере; смена языка — перезагрузкой страницы.
  const LANG = (() => {
    let v = null;
    try { v = localStorage.getItem('odem.lang'); } catch { /* хранилище браузера недоступно */ }
    if (v === 'ru' || v === 'en') return v;
    return /^(ru|be|kk|uk)\b/i.test(navigator.language || 'ru') ? 'ru' : 'en';
  })();
  const DICT = LANG === 'en' && window.ODEM_EN ? new Map(Object.entries(window.ODEM_EN)) : null;
  const LOCALE = LANG === 'en' ? (/^en\b/i.test(navigator.language || '') ? navigator.language : 'en-US') : 'ru-RU';
  const DEC = LANG === 'en' ? '.' : ',';
  const NO = LANG === 'en' ? '#' : '№';
  const CYR = /[А-Яа-яЁё]/;
  const T = (s) => (DICT && DICT.has(s) ? DICT.get(s) : s);
  const fillArgs = (s, args) => s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));
  const TF = (key, ...args) => fillArgs(T(key), args);
  document.documentElement.lang = LANG;
  document.title = T('Одем — закрытая бухгалтерия');
  try {
    document.cookie = 'odem_lang=' + LANG + '; path=/; SameSite=Strict' + (location.protocol === 'https:' ? '; Secure' : '');
  } catch { /* без cookie выгрузки будут на русском */ }

  function setLang(lang) {
    try { localStorage.setItem('odem.lang', lang); } catch { /* язык не запомнится */ }
    location.reload();
  }

  // Сообщения и подписи, пришедшие с сервера: точное совпадение или шаблон с {n} (аргументы переводятся тоже).
  let PATTERNS = null;
  function buildPatterns() {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = [];
    for (const [ru, en] of DICT) {
      if (!/\{\d+\}/.test(ru)) continue;
      const parts = ru.split(/\{(\d+)\}/);
      const lits = parts.filter((_, i) => i % 2 === 0);
      if (!CYR.test(lits.join(''))) continue;
      const order = parts.filter((_, i) => i % 2 === 1).map(Number);
      const re = new RegExp('^' + lits.map(esc).join('([\\s\\S]*?)') + '$');
      const anchor = lits.reduce((a, b) => (b.length > a.length ? b : a), '');
      out.push({ re, order, en, anchor, weight: lits.join('').length });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }
  function trServer(s, depth = 0) {
    if (!DICT || typeof s !== 'string' || !CYR.test(s)) return s;
    if (DICT.has(s)) return DICT.get(s);
    if (depth > 2 || s.length > 600) return s;
    if (!PATTERNS) PATTERNS = buildPatterns();
    for (const p of PATTERNS) {
      if (!s.includes(p.anchor)) continue;
      const m = p.re.exec(s);
      if (!m) continue;
      const args = [];
      p.order.forEach((n, i) => { args[n] = trServer(m[i + 1], depth + 1); });
      return fillArgs(p.en, args);
    }
    return s;
  }
  function trData(v) {
    if (typeof v === 'string') return trServer(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = trData(v[i]);
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = trData(v[k]);
    }
    return v;
  }

  const PERMS = {
    any: ['admin', 'accountant', 'auditor', 'viewer'],
    read: ['admin', 'accountant', 'auditor', 'viewer'],
    write: ['admin', 'accountant'],
    audit: ['admin', 'auditor'],
    admin: ['admin'],
  };

  const S = {
    csrf: null,
    user: null,
    org: null,
    settings: null,
    roles: {},
    types: {},
    accounts: [],
    counterparties: [],
    lastActivity: Date.now(),
    lastPing: Date.now(),
    timer: null,
  };

  const app = document.getElementById('app');
  const toasts = document.getElementById('toasts');

  // ======================= Утилиты DOM =======================

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'value') value = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    if (value !== undefined) el.value = value;
    return el;
  }

  /** replaceChildren без вставки строк "null"/"false" для пустых веток. */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', null, label, hint ? h('span', { class: 'hint' }, ' — ' + hint) : null), input);
  }

  function toast(msg, kind = '') {
    const t = h('div', { class: 'toast ' + kind }, msg);
    toasts.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
  }

  function errorBox() {
    const box = h('div', { class: 'alert error hidden', role: 'alert' });
    box.show = (msg) => {
      box.textContent = msg;
      box.classList.remove('hidden');
    };
    box.clear = () => box.classList.add('hidden');
    return box;
  }

  // ---- Windows Hello (WebAuthn) ----
  const b64uToBuf = (s) => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const bufToB64u = (buf) => {
    const a = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const passkeySupported = () => !!(window.PublicKeyCredential && navigator.credentials) && location.hostname !== '127.0.0.1' && location.hostname !== '[::1]';
  const localhostUrl = () => location.protocol + '//localhost' + (location.port ? ':' + location.port : '') + '/';
  function passkeyError(e) {
    if (e && e.name === 'NotAllowedError') return new Error(T('Подтверждение отменено или время истекло. Попробуйте ещё раз.'));
    if (e && e.name === 'InvalidStateError') return new Error(T('Этот ключ уже привязан к вашему пользователю.'));
    if (e && e.name === 'SecurityError') return new Error(T('Браузер не разрешил Windows Hello на этом адресе. Откройте ') + localhostUrl());
    return e instanceof Error ? e : new Error(String(e));
  }
  async function passkeyCreate(o) {
    const publicKey = {
      ...o,
      challenge: b64uToBuf(o.challenge),
      user: { ...o.user, id: b64uToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
    let cred;
    try { cred = await navigator.credentials.create({ publicKey }); } catch (e) { throw passkeyError(e); }
    return { id: cred.id, clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) };
  }
  async function passkeyGet(o) {
    const publicKey = { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
    let cred;
    try { cred = await navigator.credentials.get({ publicKey }); } catch (e) { throw passkeyError(e); }
    return {
      id: cred.id,
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      authenticatorData: bufToB64u(cred.response.authenticatorData),
      signature: bufToB64u(cred.response.signature),
    };
  }

  /** Блокирует кнопку на время запроса и показывает ошибку. */
  async function busy(btn, errBox, fn) {
    if (btn) btn.disabled = true;
    if (errBox) errBox.clear();
    try {
      return await fn();
    } catch (e) {
      if (errBox) errBox.show(e.message);
      else toast(e.message, 'error');
      return undefined;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function dialog(title, body, footer) {
    const dlg = h('dialog', null,
      h('div', { class: 'dlg-head' }, h('h2', null, title), h('button', { class: 'btn ghost small', type: 'button', 'aria-label': T('Закрыть'), onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'dlg-body' }, body),
      footer ? h('div', { class: 'dlg-foot' }, footer) : null
    );
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  function confirmDialog(title, text, okLabel = T('Подтвердить'), danger = false) {
    return new Promise((resolve) => {
      let ok = false;
      const dlg = dialog(title, h('p', null, text), [
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, T('Отмена')),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => { ok = true; dlg.close(); } }, okLabel),
      ]);
      dlg.addEventListener('close', () => resolve(ok));
    });
  }

  // ======================= Форматирование =======================

  const NBSP = '\u00a0';
  function money(k) {
    if (!k) return '0' + DEC + '00';
    const neg = k < 0;
    const a = Math.abs(k);
    const whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, LANG === 'en' ? ',' : NBSP);
    return (neg ? '−' : '') + whole + DEC + String(a % 100).padStart(2, '0');
  }
  const moneyOrBlank = (k) => (k ? money(k) : '');

  /** Знаков после запятой у валюты счёта: 2, у криптовалют — свои (BTC — 8). */
  const decimalsOf = (cur) => (S.catalog && S.catalog.crypto && S.catalog.crypto[cur]) || 2;
  const isCrypto = (cur) => !!(S.catalog && S.catalog.crypto && S.catalog.crypto[cur]);

  /** «0,015» → 1 500 000 при 8 знаках; null — если не число. */
  function parseUnits(s, dec) {
    if (dec === 2) return parseMoney(s);
    let v = String(s || '').replace(/[\s\u00a0]/g, '');
    v = LANG === 'en' && v.includes('.') ? v.replace(/,/g, '') : v.replace(',', '.');
    if (v === '') return 0;
    const m = new RegExp('^(\\d{1,12})(?:\\.(\\d{0,' + dec + '}))?$').exec(v);
    if (!m) return null;
    const n = BigInt(m[1]) * 10n ** BigInt(dec) + BigInt((m[2] || '').padEnd(dec, '0') || '0');
    return Number(n);
  }

  /** Минимальные единицы → текст: лишние нули после запятой убираются, но не меньше двух знаков. */
  function fmtUnits(minor, dec) {
    if (dec === 2) return money(minor);
    const neg = minor < 0;
    const a = BigInt(Math.abs(minor));
    const pw = 10n ** BigInt(dec);
    let frac = (a % pw).toString().padStart(dec, '0').replace(/0+$/, '');
    if (frac.length < 2) frac = frac.padEnd(2, '0');
    const whole = (a / pw).toString().replace(/\B(?=(\d{3})+(?!\d))/g, LANG === 'en' ? ',' : NBSP);
    return (neg ? '−' : '') + whole + DEC + frac;
  }

  function parseMoney(s) {
    s = String(s || '').replace(/[\s\u00a0]/g, '');
    // В английском запятая — разделитель тысяч (1,234.50); «12,5» без точки всё равно читается как дробь.
    if (LANG === 'en' && (s.includes('.') || !/,\d{1,2}$/.test(s))) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
    if (s === '') return 0;
    const m = /^(\d{1,13})(?:\.(\d{0,2}))?$/.exec(s);
    if (!m) return null;
    return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  }

  const DATE_FMT = LANG === 'en' ? new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }) : null;
  const ruDate = (s) => (!s ? '' : DATE_FMT ? DATE_FMT.format(new Date(s.slice(0, 10) + 'T00:00:00Z')) : `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`);
  const ruDateTime = (iso) => new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' });
  function isoLocal(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const today = () => isoLocal();
  const monthStart = () => isoLocal(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const yearStart = () => `${new Date().getFullYear()}-01-01`;
  const accById = (id) => S.accounts.find((a) => a.id === id);
  const accLabel = (a) => (a ? `${a.code} ${a.name}` : '—');
  const cur = () => (S.org ? S.org.currency : '');

  function genPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_';
    const out = [];
    const buf = new Uint32Array(20);
    crypto.getRandomValues(buf);
    for (const v of buf) out.push(alphabet[v % alphabet.length]);
    return out.join('');
  }

  // ======================= API =======================

  /**
   * Повтор пароля для опасных действий (пользователи, настройки, копии, компании).
   * Окно появляется само, когда сервер просит подтверждение; после него запрос повторяется.
   */
  let elevating = null;
  function askElevation() {
    if (elevating) return elevating;
    elevating = new Promise((resolve, reject) => {
      const err = errorBox();
      const pw = h('input', { type: 'password', autocomplete: 'current-password' });
      const ok = h('button', { class: 'btn primary', type: 'submit' }, T('Подтвердить'));
      let done = false;
      const form = h('form', { onsubmit: (e) => {
        e.preventDefault();
        busy(ok, err, async () => {
          const r = await api('POST', '/api/me/elevate', { password: pw.value });
          S.elevatedUntil = Date.now() + r.ttl - 5000;
          done = true;
          dlg.close();
          resolve();
        });
      } },
      h('p', { class: 'muted' }, T('Это действие меняет доступ, настройки или выгружает данные. Подтвердите, что за компьютером вы: следующие 5 минут повторять не придётся.')),
      err, field(T('Ваш пароль'), pw),
      h('div', { class: 'actions' }, ok));
      const dlg = dialog(T('Подтвердите паролем'), form);
      dlg.addEventListener('close', () => {
        elevating = null;
        if (!done) reject(new Error(T('Действие отменено')));
      });
      pw.focus();
    });
    return elevating;
  }

  async function ensureElevated() {
    if (S.elevatedUntil && S.elevatedUntil > Date.now()) return;
    await askElevation();
  }

  async function api(method, url, body, retried = false) {
    const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (S.company) opts.headers['X-Company'] = S.company;
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      if (S.csrf) opts.headers['X-CSRF-Token'] = S.csrf;
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new Error(T('Сервер недоступен. Проверьте, что он запущен.'));
    }
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
    if (res.status === 401 && S.user) {
      wipe(T('Сессия завершена. Войдите снова.'));
      throw new Error(T('Сессия завершена'));
    }
    if (res.status === 403 && data && data.elevate && !retried) {
      S.elevatedUntil = 0;
      await askElevation();
      return api(method, url, body, true);
    }
    if (!res.ok) {
      const err = new Error((data && trServer(data.error)) || TF("Ошибка {0}", res.status));
      err.restart = !!(data && data.restart);
      throw err;
    }
    // Подписи сервера (режимы, планы счетов, примечания) — на язык интерфейса. Документы не трогаем:
    // у каждого свой язык, и правка не должна переписать «шт.» на «pcs».
    if (DICT && data && !url.startsWith('/api/documents')) trData(data);
    return data;
  }

  function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  async function loadRefs() {
    const [accounts, counterparties] = await Promise.all([api('GET', '/api/accounts'), api('GET', '/api/counterparties')]);
    S.accounts = accounts;
    S.counterparties = counterparties;
  }

  const can = (perm) => !!S.user && PERMS[perm].includes(perm === 'admin' || perm === 'audit' ? S.user.role : S.role || S.user.role);
  /** Возможность, которую администратор запретил этому пользователю (поверх роли). */
  const denied = (cap) => !!S.user && S.user.role !== 'admin' && (S.user.deny || []).includes(cap);
  const canRoute = (r) => can(r.perm) && !(r.cap && denied(r.cap));

  // ======================= Автоблокировка =======================

  for (const ev of ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart']) {
    document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  function canExport() {
    const pol = (S.settings && S.settings.exportPolicy) || 'all';
    const role = S.role || (S.user && S.user.role);
    return !denied('export') && (pol === 'all' || (pol === 'staff' && role !== 'viewer') || (pol === 'admins' && role === 'admin'));
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href*="/api/export/"]');
    if (!a) return;
    if (!canExport()) {
      e.preventDefault();
      toast(T('Выгрузка данных в файлы для вашей роли отключена администратором'), 'error');
      return;
    }
    setTimeout(() => toast(T('Файл сохранён без шифрования. Храните его в защищённой папке и удалите, когда он станет не нужен.')), 400);
  }, true);

  function startIdle() {
    stopIdle();
    S.lastActivity = Date.now();
    S.lastPing = Date.now();
    S.lastBeat = Date.now();
    // Пульс раз в 5 секунд. Большой разрыв между ударами значит, что компьютер спал
    // (фоновые вкладки браузер будит не реже раза в минуту) — после сна блокируемся сразу.
    S.timer = setInterval(() => {
      const now = Date.now();
      const gap = now - S.lastBeat;
      S.lastBeat = now;
      if (gap > 150_000 && S.user) {
        lockNow(T('Компьютер уходил в спящий режим — приложение заблокировано.'));
        return;
      }
      tick();
    }, 5000);
    tick();
    startScreenLockWatch();
    preloadStone();
  }

  function stopIdle() {
    if (S.timer) clearInterval(S.timer);
    S.timer = null;
    stopScreenLockWatch();
  }

  // ---- Блокировка вместе с экраном Windows (Win+L, заставка с паролем) ----
  // Браузер сообщает о блокировке экрана через Idle Detection API (Chrome, Edge, Яндекс).
  // Разрешение даётся один раз на этом компьютере; настройка хранится только в этом браузере.
  const SCREEN_PREF = 'odem.screenLock';
  const screenLockSupported = () => 'IdleDetector' in window;
  const screenLockWanted = () => { try { return localStorage.getItem(SCREEN_PREF) !== 'off'; } catch { return true; } };
  let idleCtl = null;

  async function startScreenLockWatch() {
    stopScreenLockWatch();
    if (!screenLockSupported() || !screenLockWanted()) return;
    try {
      if ((await navigator.permissions.query({ name: 'idle-detection' })).state !== 'granted') return;
      idleCtl = new AbortController();
      const det = new window.IdleDetector();
      det.addEventListener('change', () => {
        if (det.screenState === 'locked' && S.user) lockNow(T('Экран компьютера был заблокирован — приложение тоже заблокировано.'));
      });
      await det.start({ threshold: 60_000, signal: idleCtl.signal });
    } catch { /* нет разрешения или API — остаётся обычная автоблокировка */ }
  }

  function stopScreenLockWatch() {
    if (idleCtl) idleCtl.abort();
    idleCtl = null;
  }

  async function screenLockState() {
    if (!screenLockSupported()) return 'unsupported';
    try {
      const st = (await navigator.permissions.query({ name: 'idle-detection' })).state;
      if (st === 'denied') return 'denied';
      if (st !== 'granted') return 'ask';
      return screenLockWanted() ? 'on' : 'off';
    } catch {
      return 'unsupported';
    }
  }

  function screenLockCard() {
    const card = h('div', { class: 'card' });
    const render = async () => {
      const st = await screenLockState();
      const badge = { on: ['ok', T('включена')], off: ['', T('выключена')], ask: ['warn', T('не настроена')], denied: ['danger', T('запрещена в браузере')], unsupported: ['', T('браузер не поддерживает')] }[st];
      const turnOn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.target, null, async () => {
        const res = await window.IdleDetector.requestPermission();
        if (res !== 'granted') throw new Error(T('Браузер не дал разрешение. Его можно включить в настройках сайта (значок замка в адресной строке).'));
        try { localStorage.setItem(SCREEN_PREF, 'on'); } catch { /* ignore */ }
        await startScreenLockWatch();
        toast(T('Приложение будет блокироваться вместе с экраном'));
        render();
      }) }, T('Включить'));
      const turnOff = h('button', { class: 'btn', type: 'button', onclick: () => {
        try { localStorage.setItem(SCREEN_PREF, 'off'); } catch { /* ignore */ }
        stopScreenLockWatch();
        render();
      } }, T('Выключить'));
      fill(card,
        h('h2', null, T('Блокировка вместе с экраном '), h('span', { class: 'badge ' + badge[0] }, badge[1])),
        h('p', { class: 'muted' }, T('Когда вы блокируете компьютер (Win+L) или включается заставка с паролем, приложение блокируется сразу, не дожидаясь таймера. После спящего режима блокировка происходит всегда.')),
        st === 'unsupported' ? h('p', { class: 'muted small' }, T('Работает в Chrome, Edge и Яндекс Браузере.')) : null,
        st === 'denied' ? h('p', { class: 'muted small' }, T('Разрешение «Обнаружение бездействия» запрещено для этого сайта. Разрешите его в настройках сайта (значок слева от адреса) и обновите страницу.')) : null,
        st === 'ask' || st === 'off' ? h('div', { class: 'actions' }, turnOn) : st === 'on' ? h('div', { class: 'actions' }, turnOff) : null
      );
    };
    render();
    return card;
  }

  function tick() {
    if (!S.user || !S.settings) return;
    const limit = S.settings.idleMinutes * 60_000;
    const idle = Date.now() - S.lastActivity;
    if (idle >= limit) {
      lockNow(T('Приложение заблокировано из-за бездействия.'));
      return;
    }
    if (S.lastActivity > S.lastPing && Date.now() - S.lastPing > 60_000) {
      S.lastPing = Date.now();
      api('POST', '/api/ping').catch(() => {});
    }
    const ind = document.getElementById('lock-indicator');
    if (ind) {
      const left = Math.ceil((limit - idle) / 60_000);
      ind.textContent = TF("Автоблокировка через {0} мин", left);
      ind.classList.toggle('soon', limit - idle < 60_000);
    }
  }

  /**
   * «Окаменение» при ручной блокировке. Сессия на сервере завершается сразу. От кнопки расходится
   * волна камня (интерфейс под её краем сереет), через 0,75 с данные со страницы стёрты; затем по
   * рубиновым жилам камня от точки нажатия бежит свет, жилы дважды вспыхивают — и проступает окно входа.
   * Камень и слой жил — картинки public/img/stone*.webp. При «уменьшить движение» — мгновенная блокировка.
   */
  async function petrifyLock(btn, msg) {
    const logout = S.csrf ? api('POST', '/api/logout').catch(() => {}) : Promise.resolve();
    if (reducedMotion()) {
      await logout;
      return wipe(msg);
    }
    stopIdle();
    const rect = btn ? btn.getBoundingClientRect() : { left: window.innerWidth - 80, top: 20, width: 0, height: 0 };
    const veil = h('div', { class: 'petrify', 'aria-hidden': 'true' },
      h('div', { class: 'stone' }),
      h('div', { class: 'veins-glow' }),
      h('div', { class: 'veins-core' }),
      h('div', { class: 'heart' }));
    veil.style.setProperty('--px', rect.left + rect.width / 2 + 'px');
    veil.style.setProperty('--py', rect.top + rect.height / 2 + 'px');
    document.body.append(veil);
    veil.getBoundingClientRect();
    veil.classList.add('run');
    await sleep(750);

    // Камень сомкнулся — данных на странице больше нет. По жилам бежит свет.
    clearState();
    veil.classList.add('solid', 'lit');
    await sleep(2700);

    await logout;
    renderLogin(msg);
    veil.classList.add('out');
    await sleep(800);
    veil.remove();
  }

  /** Картинки камня — заранее, чтобы анимация не ждала загрузки. */
  function preloadStone() {
    for (const src of ['img/stone.webp', 'img/stone-veins.webp']) {
      const i = new Image();
      i.decoding = 'async';
      i.src = src;
      // Раскодировать заранее: иначе первый кадр волны ждёт декодирования двух полноэкранных картинок.
      i.decode().catch(() => {});
      (preloadStone.keep = preloadStone.keep || []).push(i);
    }
  }

  async function lockNow(msg) {
    const wasCsrf = S.csrf;
    if (wasCsrf) await api('POST', '/api/logout').catch(() => {});
    wipe(msg);
  }

  /** Полная очистка состояния и страницы. */
  function wipe(msg) {
    clearState();
    renderLogin(msg);
  }

  /** Стирает данные сессии из памяти страницы и со страницы (без показа окна входа). */
  function clearState() {
    stopIdle();
    S.csrf = null;
    S.user = null;
    S.settings = null;
    S.org = null;
    S.accounts = [];
    S.counterparties = [];
    S.companies = [];
    S.company = null;
    S.role = null;
    for (const d of document.querySelectorAll('dialog')) d.remove();
    app.replaceChildren();
    toasts.replaceChildren();
    if (location.hash) history.replaceState(null, '', location.pathname);
    document.title = T('Одем — закрытая бухгалтерия');
  }

  // ======================= Экраны без входа =======================

  let setupCatalog = null;
  let setupPrefill = null;
  {
    const m = /^#setup=([A-Za-z0-9_-]{8,64})$/.exec(location.hash);
    if (m) {
      setupPrefill = m[1];
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  // ======================= Знак и движение =======================

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** «Гравировка»: номер новой проводки вырезается рубиновым резцом и гаснет. */
  function engrave(host, number, text) {
    if (reducedMotion() || !host) return;
    host.classList.add('engrave-host');
    host.querySelectorAll('.engrave').forEach((x) => x.remove());
    const el = h('div', { class: 'engrave', 'aria-hidden': 'true' },
      h('div', { class: 'engrave-plate' },
        h('span', { class: 'engrave-no' }, NO + ' ' + number),
        h('span', { class: 'engrave-txt' }, String(text || '').trim().slice(0, 48) || T('вписано в книгу'))
      )
    );
    host.append(el);
    setTimeout(() => el.remove(), 2800);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Знак «Одем»: огранённый рубин. */
  function rubyMark(size) {
    return h('img', { class: 'gem ruby-mark', src: 'img/ruby.webp', alt: '', width: size, height: size, decoding: 'async', draggable: 'false' });
  }

  /** Нагрудник первосвященника: двенадцать камней в четыре ряда, первый — рубин («одем»), Исход 28:17. */
  function breastplate() {
    return h('div', { class: 'breastplate', 'aria-hidden': 'true' },
      Array.from({ length: 12 }, (_, i) => h('span', { class: 'stone' + (i === 0 ? ' ruby' : '') })));
  }

  /** Фон «святилища»: витражная роза, лучи и пылинки. Создаётся один раз, лежит за интерфейсом. */
  function buildSanctum() {
    if (document.querySelector('.sanctum')) return;
    const s = h('div', { class: 'sanctum', 'aria-hidden': 'true' },
      h('div', { class: 'halo' }),
      h('div', { class: 'rose' }),
      [1, 2, 3, 4, 5].map((i) => h('div', { class: 'ray r' + i })));
    if (!reducedMotion()) {
      for (let i = 0; i < 18; i++) {
        const m = h('span', { class: 'mote' });
        m.style.left = 35 + Math.random() * 65 + 'vw';
        m.style.top = Math.random() * 70 + 'vh';
        m.style.animationDuration = 16 + Math.random() * 16 + 's';
        m.style.animationDelay = -Math.random() * 30 + 's';
        s.append(m);
      }
    }
    document.body.prepend(s);
  }

  function tgIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M21.5 4.2 2.9 11.4c-1 .4-1 1.5 0 1.8l4.7 1.5 1.8 5.6c.2.7 1.1.9 1.6.4l2.6-2.4 4.9 3.6c.6.4 1.4.1 1.6-.6l3.2-15.1c.2-1-.7-1.8-1.8-1.4zM9.6 14.3l-.4 4.1-1.4-4.4 9.6-6.1-7.8 6.4z');
    p.setAttribute('fill', 'currentColor');
    svg.append(p);
    return svg;
  }

  function lockIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v7h-9z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  /** Главная сцена: грани печати разлетаются, экран входа растворяется, открывается рабочее место. */
  async function playUnlock() {
    S.justUnlocked = true;
    const wrap = app.querySelector('.auth-wrap');
    if (!wrap || reducedMotion()) return;
    wrap.classList.remove('assemble');
    wrap.classList.add('unlocking');
    await sleep(620);
  }

  function langSwitch() {
    const opt = (code, label) => h('button', {
      type: 'button', class: 'lang-opt' + (LANG === code ? ' on' : ''), lang: code,
      'aria-pressed': LANG === code ? 'true' : 'false',
      onclick: () => { if (LANG !== code) setLang(code); },
    }, label);
    return h('div', { class: 'lang-switch', role: 'group', 'aria-label': T('Язык интерфейса') }, opt('ru', 'Русский'), opt('en', 'English'));
  }

  function authCard(wide, ...content) {
    return h('div', { class: 'auth-wrap assemble' + (wide ? ' wide' : '') },
      h('div', { class: 'auth-art' },
        h('h1', null, T('Запись, которую нельзя стереть')),
        h('p', null, T('Данные зашифрованы на этом компьютере и остаются только у вас. Проводки неизменны: ошибку исправляют сторно, а не правкой.'))
      ),
      h('div', { class: 'auth-card' + (wide ? ' wide' : '') },
        h('div', { class: 'brand' },
          rubyMark(46),
          h('div', null, h('div', { class: 'brand-name' }, T('Одем')), h('div', { class: 'brand-sub' }, T('Закрытая бухгалтерия')))
        ),
        ...content,
        langSwitch()
      )
    );
  }

  function renderLogin(message) {
    const err = errorBox();
    const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' });
    const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, T('Войти'));
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        busy(btn, err, async () => {
          btn.textContent = T('Проверка ключа…');
          try {
            const s = await api('POST', '/api/login', { username: user.value, password: pass.value });
            pass.value = '';
            if (s.twoFactorRequired) return renderSecondFactor(s);
            await playUnlock();
            await onLoggedIn(s);
          } finally {
            btn.textContent = T('Войти');
          }
        });
      },
    },
      message ? h('div', { class: 'alert info' }, message) : null,
      err,
      field(T('Логин'), user),
      field(T('Пароль'), pass),
      btn,
      h('div', { class: 'actions' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderRecover(); } }, T('Забыли пароль? Восстановить по ключу')))
    );
    fill(app, authCard(false, form));
    user.focus();
  }

  function codeInput() {
    const el = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, pattern: '[0-9 ]*', class: 'mono otp', placeholder: '000000', spellcheck: 'false' });
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, 6);
      if (el.value.length === 6 && el.form) el.form.requestSubmit();
    });
    return el;
  }

  /** Второй шаг входа: код из приложения-аутентификатора. */
  function renderSecondFactor(step) {
    const challenge = step.challenge;
    const methods = step.methods || ['totp'];
    const err = errorBox();
    const code = codeInput();
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, T('Подтвердить'));
    const hasTotp = methods.includes('totp');
    let helloBtn = null;
    const hello = async () => {
      await busy(helloBtn, err, async () => {
        try {
          const passkey = await passkeyGet(step.passkey);
          const s = await api('POST', '/api/login/2fa', { challenge, passkey });
          await playUnlock();
          await onLoggedIn(s);
        } catch (er) {
          if (er.restart) return renderLogin(er.message);
          throw er;
        }
      });
    };
    if (methods.includes('passkey')) {
      helloBtn = h('button', { class: 'btn primary block hello-btn', type: 'button', onclick: hello }, h('span', { class: 'hello-ico', 'aria-hidden': 'true' }), T('Войти через Windows Hello'));
    }
    const wrongHost = !methods.includes('passkey') && step.passkeyHost
      ? h('div', { class: 'alert info' }, T('Ваш ключ Windows Hello привязан к адресу '), h('a', { href: localhostUrl() }, localhostUrl()), T(' — откройте приложение по нему.') + (hasTotp ? T(' Или введите код из приложения.') : ''))
      : null;
    if (!hasTotp) {
      fill(app, authCard(false, h('div', null,
        h('h2', null, T('Подтверждение входа')),
        helloBtn ? h('p', { class: 'muted' }, T('Подтвердите вход отпечатком, лицом или PIN-кодом Windows.')) : null,
        err, wrongHost, helloBtn,
        h('div', { class: 'actions' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderLogin(); } }, T('Отмена')))
      )));
      if (helloBtn) hello();
      return;
    }
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        busy(btn, err, async () => {
          try {
            const s = await api('POST', '/api/login/2fa', { challenge, code: code.value });
            await playUnlock();
            await onLoggedIn(s);
          } catch (er) {
            code.value = '';
            code.focus();
            if (er.restart) return renderLogin(er.message);
            throw er;
          }
        });
      },
    },
      h('h2', null, T('Подтверждение входа')),
      wrongHost,
      helloBtn ? [helloBtn, h('div', { class: 'or' }, T('или код из приложения'))] : h('p', { class: 'muted' }, T('Введите 6-значный код из приложения-аутентификатора на телефоне.')),
      err,
      field(T('Код'), code),
      btn,
      h('div', { class: 'actions' },
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderLogin(); } }, T('Отмена')),
        h('span', { class: 'muted small' }, T('Нет доступа к телефону? Администратор может сбросить 2FA, а для себя — восстановление по ключу.'))
      )
    );
    fill(app, authCard(false, form));
    if (helloBtn) hello();
    else code.focus();
  }

  /**
   * Подключение 2FA: подтверждение паролем → QR-код и секрет → проверка первого кода.
   * Секрет сохраняется на сервере только после того, как пользователь ввёл верный код.
   */
  function twoFactorSetup(container, onDone) {
    const err = errorBox();
    const pw = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('button', { class: 'btn primary', type: 'submit' }, T('Продолжить'));
    fill(container, h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        busy(next, err, async () => {
          const r = await api('POST', '/api/me/2fa/begin', { password: pw.value });
          pw.value = '';
          showStep2(r);
        });
      },
    },
      h('p', { class: 'muted' }, T('Понадобится приложение-аутентификатор: Google Authenticator, Яндекс Ключ, Microsoft Authenticator, Aegis, 1Password и т.п.')),
      err,
      h('div', { class: 'row' }, field(T('Ваш пароль'), pw), next)
    ));

    function showStep2(r) {
      const err2 = errorBox();
      const code = codeInput();
      const ok = h('button', { class: 'btn primary', type: 'submit' }, T('Включить 2FA'));
      let qr;
      try {
        qr = window.BuhQR.svg(r.uri, { px: 220 });
      } catch {
        qr = h('div', { class: 'alert warn' }, T('Не удалось построить QR-код — введите ключ вручную.'));
      }
      fill(container, h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          if (ok.disabled) return;
          busy(ok, err2, async () => {
            try {
              await api('POST', '/api/me/2fa/confirm', { code: code.value });
            } catch (er) {
              code.value = '';
              code.focus();
              throw er;
            }
            S.user.twoFactor = true;
            S.user.mustEnroll2fa = false;
            toast(T('Двухфакторная аутентификация включена. Другие ваши сессии завершены.'));
            if (onDone) await onDone();
          });
        },
      },
        h('div', { class: 'twofa' },
          h('div', { class: 'qr-box' }, qr),
          h('div', null,
            h('ol', { class: 'steps' },
              h('li', null, T('Откройте приложение-аутентификатор и отсканируйте QR-код.')),
              h('li', null, T('Если сканировать неудобно — добавьте ключ вручную (тип: по времени):'), h('div', { class: 'recovery-key small-key' }, r.secret.match(/.{1,4}/g).join(' ')), h('div', { class: 'muted small' }, TF("Аккаунт: {0}:{1}", r.issuer, r.account))),
              h('li', null, T('Введите 6-значный код, который покажет приложение.'))
            ),
            err2,
            h('div', { class: 'row' }, field(T('Код из приложения'), code), ok)
          )
        )
      ));
      code.focus();
    }
  }

  function renderRecover() {
    const err = errorBox();
    const key = h('textarea', { rows: 3, class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-…' });
    const parts = h('textarea', { rows: 5, class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'OS-XXXX-23-1-…\nOS-XXXX-23-2-…' });
    const useParts = h('input', { type: 'checkbox' });
    const keyField = field(T('Ключ восстановления'), key);
    const partsField = field(T('Части ключа'), parts, T('каждая часть с новой строки'));
    partsField.hidden = true;
    useParts.addEventListener('change', () => {
      keyField.hidden = useParts.checked;
      partsField.hidden = !useParts.checked;
    });
    const user = h('input', { type: 'text', autocomplete: 'username' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Восстановить доступ'));
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (p1.value !== p2.value) return err.show(T('Пароли не совпадают'));
        busy(btn, err, async () => {
          const proof = useParts.checked ? { shares: parts.value.split(/\n+/).map((s) => s.trim()).filter(Boolean) } : { recoveryKey: key.value };
          const r = await api('POST', '/api/recover', { ...proof, username: user.value, newPassword: p1.value });
          showRecoveryResult(r, T('Доступ восстановлен. Старый ключ восстановления больше не действует — сохраните новый.'), () => renderLogin(T('Войдите с новым паролем.')));
        });
      },
    },
      h('h2', null, T('Восстановление доступа')),
      h('p', { class: 'muted' }, T('Нужен ключ восстановления, выданный при первичной настройке.')),
      err,
      h('label', { class: 'check' }, useParts, h('span', null, T('У меня части ключа (ключ был разделён)'))),
      keyField,
      partsField,
      field(T('Логин пользователя'), user),
      field(T('Новый пароль'), p1, T('не короче 12 символов')),
      field(T('Повторите пароль'), p2),
      h('div', { class: 'actions' }, btn, h('button', { class: 'btn ghost', type: 'button', onclick: () => renderLogin() }, T('Назад')))
    );
    fill(app, authCard(true, form));
  }

  /** Части ключа восстановления: каждую — отдельному человеку или в отдельное место. */
  function sharesBlock(r) {
    return h('div', { class: 'shares' },
      h('p', null, TF('Ключ разделён на {0} частей. Для восстановления нужны любые {1}; меньшее число частей не раскрывает о ключе ничего.', r.n, r.k)),
      r.shares.map((s, i) => h('div', { class: 'share' },
        h('div', { class: 'share-head' }, h('b', null, TF('Часть {0} из {1}', i + 1, r.n)),
          h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            try { await navigator.clipboard.writeText(s); toast(T('Часть скопирована')); } catch { toast(T('Не удалось скопировать — перепишите вручную'), 'error'); }
          } }, T('Скопировать'))),
        h('div', { class: 'recovery-key small-key' }, s))));
  }

  /** Ответ сервера с новым ключом: целиком или частями. */
  function showRecoveryResult(r, intro, onDone) {
    if (r.shares) return showRecoveryShares(r, intro, onDone);
    return showRecoveryKey(r.recoveryKey, intro, onDone);
  }

  function showRecoveryShares(r, intro, onDone) {
    const ack = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: onDone }, T('Продолжить'));
    ack.addEventListener('change', () => { btn.disabled = !ack.checked; });
    fill(app, authCard(true,
      h('h2', null, T('Части ключа восстановления')),
      h('p', null, intro),
      sharesBlock(r),
      h('div', { class: 'alert warn' }, T('Части показываются один раз. Раздайте их разным людям или храните в разных местах, офлайн.')),
      h('label', { class: 'check' }, ack, h('span', null, T('Я сохранил(а) все части в надёжных местах'))),
      h('div', { class: 'actions' }, btn)));
  }

  function showRecoveryKey(keyText, intro, onDone) {
    const ack = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: onDone }, T('Продолжить'));
    ack.addEventListener('change', () => { btn.disabled = !ack.checked; });
    const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(keyText); toast(T('Скопировано. Не храните ключ в буфере обмена — вставьте его в надёжное место.')); } catch { toast(T('Не удалось скопировать — перепишите вручную'), 'error'); }
    } }, T('Скопировать'));
    fill(app, authCard(true,
      h('h2', null, T('Ключ восстановления')),
      h('p', null, intro),
      h('div', { class: 'recovery-key' }, keyText),
      h('div', { class: 'alert warn' }, T('Ключ показывается один раз. Без него и без паролей данные восстановить невозможно — даже разработчику. Храните его офлайн (на бумаге, в сейфе или менеджере паролей), отдельно от компьютера.')),
      h('label', { class: 'check' }, ack, h('span', null, T('Я сохранил(а) ключ восстановления в надёжном месте'))),
      h('div', { class: 'actions' }, btn, copy)
    ));
  }

  function renderSetup() {
    const err = errorBox();
    const token = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', class: 'mono', value: setupPrefill || '' });
    const org = h('input', { type: 'text', maxlength: 200 });
    const currency = h('select', null, ['RUB', 'USD', 'EUR', 'KZT', 'BYN', 'UAH', 'GBP', 'CNY'].map((c) => h('option', { value: c }, c)));
    const tpl = h('select', null,
      h('option', { value: 'rsbu' }, T('План счетов РФ (РСБУ, упрощённый)')),
      h('option', { value: 'us' }, 'US small business chart of accounts'),
      h('option', { value: 'empty' }, T('Пустой — создам счета сам(а)'))
    );
    const cat = setupCatalog || {};
    if (cat.templates) fill(tpl, cat.templates.map((x) => h('option', { value: x.id }, x.title)));
    if (cat.currencies) fill(currency, cat.currencies.map((x) => h('option', { value: x }, x)));
    const country = h('select', null, (cat.countries || []).map((x) => h('option', { value: x.id }, x.title)));
    const entity = h('select');
    const tmode = h('select');
    const fillModes = () => fill(tmode, h('option', { value: '' }, T('— выберу позже —')), (cat.taxModes || []).filter((m) => m.country === country.value && (!m.entities || m.entities.includes(entity.value))).map((m) => h('option', { value: m.id }, m.title)));
    const onCountry = () => {
      const c = (cat.countries || []).find((x) => x.id === country.value) || {};
      fill(entity, (c.entities || []).map((x) => h('option', { value: x.id }, x.title)));
      if (c.currency) currency.value = c.currency;
      if (c.template) tpl.value = c.template;
      fillModes();
    };
    country.addEventListener('change', onCountry);
    entity.addEventListener('change', fillModes);
    onCountry();
    const name = h('input', { type: 'text', maxlength: 100 });
    const tg = h('input', { type: 'text', maxlength: 100, value: '', spellcheck: 'false', autocomplete: 'off', placeholder: '@username' });
    const user = h('input', { type: 'text', autocomplete: 'username', value: 'admin', spellcheck: 'false' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Создать зашифрованное хранилище'));
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (p1.value !== p2.value) return err.show(T('Пароли не совпадают'));
        busy(btn, err, async () => {
          btn.textContent = T('Создание ключей…');
          try {
            const r = await api('POST', '/api/setup', {
              setupToken: token.value, orgName: org.value, currency: currency.value, template: tpl.value, country: country.value, entityType: entity.value, taxMode: tmode.value || null,
              username: user.value, displayName: name.value, password: p1.value, telegram: tg.value,
            });
            p1.value = p2.value = '';
            setupPrefill = null;
            const done = r.network && r.network.ready
              ? T('Настройка завершена. Войдите под администратором и подключите 2FA — для входа по сети она обязательна. Доступ из сети включается на главной.')
              : T('Настройка завершена. Войдите под администратором.');
            showRecoveryKey(r.recoveryKey, T('Хранилище создано. Это ключ восстановления: он позволит сбросить пароль администратора, если тот будет забыт.'), () => renderLogin(done));
          } finally {
            btn.textContent = T('Создать зашифрованное хранилище');
          }
        });
      },
    },
      h('h2', null, T('Первичная настройка')),
      setupPrefill
        ? h('p', { class: 'muted' }, T('Код первичной настройки подставлен автоматически: никто другой не сможет настроить приложение раньше вас.'))
        : h('p', { class: 'muted' }, T('Код настройки выведен в окне, где запущен сервер. Он защищает от того, чтобы кто-то другой настроил приложение раньше вас.')),
      err,
      setupPrefill ? null : field(T('Код первичной настройки'), token),
      h('h3', null, T('Учёт')),
      h('div', { class: 'row' }, field(T('Название'), org, T('необязательно, видно только вам')), field(T('Рабочий Telegram'), tg, T('ссылка в верхней панели'))),
      h('div', { class: 'row' }, field(T('Страна'), country), field(T('Форма'), entity), field(T('Налоговый режим'), tmode)),
      h('div', { class: 'row' }, field(T('План счетов'), tpl), h('label', { class: 'field narrow' }, h('span', null, T('Валюта')), currency)),
      h('h3', null, T('Администратор')),
      h('div', { class: 'row' }, field(T('Логин'), user), field(T('Имя'), name)),
      field(T('Пароль'), p1, T('не короче 12 символов; лучше — фраза из нескольких слов')),
      field(T('Повторите пароль'), p2),
      h('div', { class: 'actions' }, btn)
    );
    const joinLink = h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderJoin(token.value); } }, T('У меня уже есть учёт в папке синхронизации')));
    fill(app, authCard(true, form, joinLink));
    (setupPrefill ? org : token).focus();
  }

  /** Новый компьютер: забрать учёт из общей папки (нужен тот же код первичной настройки). */
  function renderJoin(tokenValue) {
    const err = errorBox();
    const token = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', class: 'mono', value: tokenValue || '' });
    const dir = h('input', { type: 'text', spellcheck: 'false', placeholder: 'C:\\Users\\…\\OneDrive\\Odem' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Подключить'));
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      busy(btn, err, async () => {
        await api('POST', '/api/setup/join', { setupToken: token.value, dir: dir.value.trim() });
        setupPrefill = null;
        renderLogin(T('Учёт получен из папки синхронизации. Войдите своим логином и паролем.'));
      });
    } },
    h('h2', null, T('Учёт из папки синхронизации')),
    h('p', { class: 'muted' }, T('Укажите ту же папку, что выбрана на первом компьютере (OneDrive, Яндекс Диск или сетевая). Будет скопирован зашифрованный учёт; войти можно будет теми же логином и паролем.')),
    err,
    tokenValue ? null : field(T('Код первичной настройки'), token),
    field(T('Папка синхронизации'), dir),
    h('div', { class: 'actions' }, btn, h('button', { class: 'btn ghost', type: 'button', onclick: () => renderSetup() }, T('Назад'))));
    fill(app, authCard(true, form));
    dir.focus();
  }

  // ======================= После входа =======================

  function applySession(s) {
    if (s.csrf) S.csrf = s.csrf;
    S.user = s.user;
    S.org = s.org;
    S.settings = s.settings;
    S.roles = s.roles;
    S.types = s.accountTypes;
    S.catalog = s.catalog || S.catalog || {};
    S.companies = s.companies || [];
    S.company = s.company;
    S.role = s.role;
    S.alerts = s.alerts || 0;
    S.requests = s.requests || 0;
    S.approvals = s.approvals || 0;
    S.recurringDue = s.recurringDue || 0;
    S.networkPending = !!s.networkPending;
    S.caps = s.caps || {};
    S.license = s.license || null;
  }

  /** Понятное имя браузера и системы из User-Agent. */
  function uaLabel(ua) {
    if (!ua) return T('неизвестный браузер');
    const b = /YaBrowser/.test(ua) ? T('Яндекс Браузер') : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /node|undici/i.test(ua) ? T('программа (не браузер)') : T('браузер');
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? b + ', ' + os : b;
  }

  /** После входа: когда и откуда был прошлый вход, сколько неудачных попыток было с тех пор. */
  function showLoginNotice(n) {
    if (!n) return;
    const prev = n.previous ? TF("Прошлый вход: {0}, {1}, {2}.", ruDateTime(n.previous.at), n.previous.ip, uaLabel(n.previous.ua)) : T('Это первый вход под этим именем.');
    if (n.failedSince > 0) {
      const body = h('div', null,
        h('div', { class: 'alert error' }, TF("С прошлого входа было неудачных попыток войти под вашим именем: {0}.", n.failedSince)),
        h('p', null, prev),
        h('p', { class: 'muted' }, T('Если это были не вы — смените пароль в «Мой профиль» и сообщите администратору. Подробности — в журнале аудита.')));
      const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close() }, T('Понятно'));
      const dlg = dialog(T('Внимание: попытки входа'), body, ok);
    } else if (n.previous) {
      toast(prev);
    }
  }

  async function onLoggedIn(s) {
    applySession(s);
    setTimeout(() => showLoginNotice(s.notice), 900);
    let saved = null;
    try { saved = localStorage.getItem('odem.company'); } catch { /* нет хранилища */ }
    if (saved && saved !== S.company && S.companies.some((c) => c.id === saved)) {
      S.company = saved;
      applySession(await api('GET', '/api/session'));
    }
    startIdle();
    await afterGates();
  }

  async function switchCompany(id) {
    S.company = id;
    try { localStorage.setItem('odem.company', id); } catch { /* нет хранилища */ }
    applySession(await api('GET', '/api/session'));
    await loadRefs();
    route();
    toast(TF("Компания: {0}", S.org.name));
  }

  function companySwitcher() {
    if (!S.companies.length) return null;
    const isAdmin = S.user.role === 'admin';
    if (S.companies.length === 1 && !isAdmin) return h('div', { class: 'company-name' }, S.org.name);
    const sel = h('select', { class: 'company-select', 'aria-label': T('Компания'), title: T('Компания'), value: S.company },
      S.companies.map((c) => h('option', { value: c.id }, `${c.name} (${c.currency})`)),
      isAdmin ? h('option', { value: '__manage' }, T('Управление компаниями…')) : null);
    sel.addEventListener('change', () => {
      if (sel.value === '__manage') {
        sel.value = S.company;
        go('companies');
      } else switchCompany(sel.value).catch((e) => toast(e.message, 'error'));
    });
    return sel;
  }

  /** Обязательные шаги после входа: смена временного пароля, затем подключение 2FA (если требуется). */
  async function afterGates() {
    if (S.user.mustChangePassword) return renderForcedPassword();
    if (!S.companies.length) {
      return fill(app, authCard(false, h('h2', null, T('Нет доступа к компаниям')),
        h('p', { class: 'muted' }, T('Администратор ещё не открыл вам доступ ни к одной компании. Обратитесь к нему и войдите снова.')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => lockNow() }, T('Выйти')))));
    }
    if (S.user.mustEnroll2fa) return renderForcedEnroll();
    await loadRefs();
    route();
  }

  function renderForcedEnroll() {
    const body = h('div');
    fill(app, authCard(true,
      h('h2', null, T('Подключите двухфакторную аутентификацию')),
      h('div', { class: 'alert info' }, T('Администратор требует 2FA для всех пользователей. Без неё работа в приложении недоступна.')),
      passkeySupported() ? h('div', { class: 'card inset' }, h('h3', null, 'Windows Hello'), h('p', { class: 'muted' }, T('Вход по отпечатку, лицу или PIN-коду этого компьютера.')), passkeyAddForm(afterGates)) : null,
      passkeySupported() ? h('h3', null, T('Или код из приложения на телефоне')) : null,
      body,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => lockNow() }, T('Выйти')))
    ));
    twoFactorSetup(body, afterGates);
  }

  function renderForcedPassword() {
    const body = h('div');
    fill(app, authCard(true, h('h2', null, T('Смена временного пароля')), h('p', { class: 'muted' }, T('Администратор выдал вам временный пароль. Задайте свой — его не будет знать никто, кроме вас.')), body));
    passwordForm(body, async () => {
      S.user.mustChangePassword = false;
      await afterGates();
    });
  }

  function passwordForm(container, onDone) {
    const err = errorBox();
    const cur0 = h('input', { type: 'password', autocomplete: 'current-password' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Сменить пароль'));
    fill(container, h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (p1.value !== p2.value) return err.show(T('Пароли не совпадают'));
        busy(btn, err, async () => {
          await api('POST', '/api/me/password', { current: cur0.value, next: p1.value });
          cur0.value = p1.value = p2.value = '';
          toast(T('Пароль изменён. Другие ваши сессии завершены.'));
          if (onDone) await onDone();
        });
      },
    }, err, field(T('Текущий пароль'), cur0), field(T('Новый пароль'), p1, T('не короче 12 символов')), field(T('Повторите новый пароль'), p2), h('div', { class: 'actions' }, btn)));
  }

  // ======================= Маршрутизация и каркас =======================

  const ROUTES = {
    home: { title: T('Главная'), emblem: 'img/ruby.webp', sub: T('Деньги, доходы и расходы, ближайшие налоги — по выбранной компании.'), perm: 'read', group: T('Учёт'), render: viewHome },
    journal: { title: T('Журнал проводок'), emblem: 'img/ledger.webp', sub: T('Все проводки по датам. Нажмите на строку, чтобы открыть документы и сторно.'), perm: 'read', group: T('Учёт'), render: viewJournal },
    'entry-new': { title: T('Новая проводка'), emblem: 'img/em/pen.webp', sub: T('Дебет и кредит должны сходиться. Шаблоны ускоряют типовые операции.'), perm: 'write', group: T('Учёт'), render: viewEntryNew },
    import: { title: T('Импорт выписки'), emblem: 'img/em/statement.webp', sub: T('Выписка из интернет-банка превращается в проводки за пару минут.'), perm: 'write', cap: 'import', group: T('Учёт'), render: viewImport },
    tables: { title: T('Загрузка из Excel'), emblem: 'img/em/statement.webp', sub: T('Контрагенты, план счетов и начальные остатки из Excel или CSV — чтобы начать работу без ручного ввода.'), perm: 'write', cap: 'import', group: T('Учёт'), render: viewTables },
    recurring: { title: T('Регулярные операции'), emblem: 'img/em/pen.webp', sub: T('Аренда, связь, зарплата: проводки по расписанию — автоматически или с напоминанием.'), perm: 'read', group: T('Учёт'), render: viewRecurring },
    cashflow: { title: T('Движение денег'), emblem: 'img/em/chart.webp', sub: T('Откуда пришли и куда ушли деньги за период: по корреспондирующим счетам.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewCashFlow },
    payouts: { title: T('Выплаты сотрудникам'), emblem: 'img/em/chart.webp', sub: T('Сколько и кому выплачено по каналам: касса, банк, переводы, криптокошельки.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewPayouts },
    consolidated: { title: T('Сводный отчёт'), emblem: 'img/em/cards.webp', sub: T('Все ваши компании в одной валюте: деньги, доходы, расходы и долги.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewConsolidated },
    calendar: { title: T('Платёжный календарь'), emblem: 'img/em/chart.webp', sub: T('Поступления и платежи на ближайшие недели и ожидаемый остаток денег.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewCalendar },
    documents: { title: T('Счета и акты'), emblem: 'img/em/stamp.webp', sub: T('Счета на оплату и акты для покупателей: печать и PDF прямо из браузера.'), perm: 'read', group: T('Учёт'), render: viewDocuments },
    rates: { title: T('Курсы валют'), emblem: 'img/em/statement.webp', sub: T('Курсы для валютных счетов и переоценка остатков.'), perm: 'read', group: T('Учёт'), render: viewRates },
    templates: { title: T('Шаблоны проводок'), emblem: 'img/em/stamp.webp', sub: T('Типовые операции с долями сумм: НДС, НДФЛ и взносы считаются сами.'), perm: 'write', group: T('Учёт'), render: viewTemplates },
    accounts: { title: T('План счетов'), emblem: 'img/em/cards.webp', sub: T('Счета учёта. Закрытые счета не предлагаются при вводе проводок.'), perm: 'read', group: T('Учёт'), render: viewAccounts },
    counterparties: { title: T('Контрагенты'), emblem: 'img/em/partners.webp', sub: T('Покупатели, поставщики и все, с кем идут расчёты.'), perm: 'read', group: T('Учёт'), render: viewCounterparties },
    taxes: { title: T('Налоги'), emblem: 'img/em/seal.webp', sub: T('Налог и авансы по периодам, сроки уплаты, НДС и книга доходов и расходов.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewTaxes },
    recon: { title: T('Акт сверки'), emblem: 'img/em/partners.webp', sub: T('Взаиморасчёты с контрагентом за период: сальдо, обороты и печатная форма для подписи.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewRecon },
    trial: { title: T('Оборотно-сальдовая ведомость'), emblem: 'img/em/chart.webp', sub: T('Остатки и обороты по каждому счёту за период.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewTrial },
    card: { title: T('Карточка счёта'), emblem: 'img/em/chart.webp', sub: T('Все движения по счёту с нарастающим сальдо.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewCard },
    balance: { title: T('Баланс'), emblem: 'img/em/chart.webp', sub: T('Активы, обязательства и капитал на дату.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewBalance },
    pnl: { title: T('Прибыли и убытки'), emblem: 'img/em/chart.webp', sub: T('Доходы, расходы и финансовый результат за период.'), perm: 'read', cap: 'reports', group: T('Отчёты'), render: viewPnl },
    companies: { title: T('Компании'), emblem: 'img/em/cards.webp', sub: T('Организации, ИП и личный учёт: у каждой свой план счетов, валюта и налоговый режим.'), perm: 'admin', group: T('Администрирование'), render: viewCompanies },
    users: { title: T('Пользователи'), emblem: 'img/em/keys.webp', sub: T('Доступ сотрудников, роли и двухфакторная аутентификация.'), perm: 'admin', group: T('Администрирование'), render: viewUsers },
    network: { title: T('Сеть'), emblem: 'img/em/safe.webp', sub: T('Работа в локальной сети: HTTPS, сертификаты устройств сотрудников и доступ по адресам.'), perm: 'admin', group: T('Администрирование'), render: viewNetwork },
    security: { title: T('Безопасность'), emblem: 'img/em/keys.webp', sub: T('Предупреждения, отпечаток журнала и состояние защиты хранилища.'), perm: 'audit', group: T('Администрирование'), render: viewSecurity },
    audit: { title: T('Журнал аудита'), emblem: 'img/em/seal.webp', sub: T('Неизменяемая цепочка всех действий в приложении.'), perm: 'audit', group: T('Администрирование'), render: viewAudit },
    access: { title: T('Журнал доступа'), emblem: 'img/em/seal.webp', sub: T('Кто, когда и что открывал: отчёты, проводки, документы.'), perm: 'audit', group: T('Администрирование'), render: viewAccess },
    settings: { title: T('Настройки и резервные копии'), emblem: 'img/em/safe.webp', sub: T('Автоблокировка, закрытие периода, резервные копии и ключ восстановления.'), perm: 'admin', group: T('Администрирование'), render: viewSettings },
    profile: { title: T('Мой профиль'), emblem: 'img/twofa.webp', sub: T('Ваш пароль и двухфакторная аутентификация.'), perm: 'any', group: null, render: viewProfile },
    about: { title: T('О программе'), emblem: 'img/ruby.webp', sub: T('Версия, поддержка и что приложение делает с вашими данными.'), perm: 'any', group: null, render: viewAbout },
  };

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [name, q] = raw.split('?');
    return { name: name || 'home', params: new URLSearchParams(q || '') };
  }

  function go(name, params) {
    location.hash = '#/' + name + (params ? qs(params) : '');
  }

  window.addEventListener('hashchange', () => { if (S.user && !S.user.mustChangePassword && !S.user.mustEnroll2fa) route(); });

  function route() {
    if (!S.user) return;
    let { name, params } = parseHash();
    if (!ROUTES[name] || !canRoute(ROUTES[name])) name = 'home';
    const r = ROUTES[name];
    const main = h('main', { class: 'main', id: 'main' });
    const shell = h('div', { class: 'shell' + (S.justUnlocked && !reducedMotion() ? ' enter' : '') }, topbar(), sidebar(name), main);
    S.justUnlocked = false;
    fill(app, shell);
    // Новый раздел открывается сверху; перерисовка того же раздела позицию не сбрасывает.
    if (S.lastRoute !== name) window.scrollTo(0, 0);
    S.lastRoute = name;
    document.title = TF("{0} — Одем", r.title);
    // Отчёты и журнал печатаются (и сохраняются в PDF) средствами браузера, в светлом виде.
    const printable = r.cap === 'reports' || name === 'journal' || name === 'access' || name === 'audit';
    const head = h('div', { class: 'page-head' },
      h('div', { class: 'page-title' },
        r.emblem ? h('div', { class: 'emblem' }, h('img', { src: r.emblem, alt: '', width: 64, height: 64 })) : null,
        h('div', null, h('h1', null, r.title), r.sub ? h('p', { class: 'page-sub' }, r.sub) : null)
      ),
      printable ? h('button', { class: 'btn small print-btn', type: 'button', title: T('В окне печати выберите принтер или «Сохранить как PDF»'), onclick: () => window.print() }, T('Печать / PDF')) : null,
      printable ? h('div', { class: 'print-meta' }, (S.org ? S.org.name + ' · ' : '') + TF('сформировано {0}, {1}', ruDateTime(new Date().toISOString()), S.user.displayName)) : null
    );
    const body = h('div', { class: 'page-enter' });
    // Разделы добавляют блоки условно (cond ? блок : null) — пустые значения не выводим как текст «null».
    const nativeAppend = body.append.bind(body);
    body.append = (...items) => nativeAppend(...items.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false && x !== ''));
    // Скелетон виден, пока раздел загружает данные; исчезает при первом содержимом.
    const skel = h('div', { class: 'skeleton', 'aria-hidden': 'true' }, breastplate(), h('i'), h('i'), h('i'));
    skel.querySelectorAll('.stone').forEach((st, i) => { st.style.animationDelay = i * 0.12 + 's'; });
    main.append(head, body, skel);
    const obs = new MutationObserver(() => {
      if (body.childNodes.length) {
        skel.remove();
        obs.disconnect();
      }
    });
    obs.observe(body, { childList: true });
    Promise.resolve(r.render(body, params, head))
      .catch((e) => fill(body, h('div', { class: 'alert error' }, e.message)))
      .finally(() => {
        skel.remove();
        obs.disconnect();
      });
    tick();
  }

  function topbar() {
    return h('header', { class: 'topbar' },
      h('button', { class: 'btn ghost small menu-toggle', type: 'button', 'aria-label': T('Меню'), onclick: () => document.querySelector('.shell').classList.toggle('menu-open') }, '☰'),
      h('a', { class: 'brand', href: '#/home', style: null }, rubyMark(32), h('div', { class: 'brand-name' }, T('Одем'))),
      companySwitcher(),
      S.settings.telegram
        ? h('a', { class: 'tg-link', href: 'https://t.me/' + encodeURIComponent(S.settings.telegram), target: '_blank', rel: 'noopener noreferrer', title: T('Рабочий Telegram') }, tgIcon(), '@' + S.settings.telegram)
        : null,
      h('div', { class: 'spacer' }),
      S.alerts && can('audit')
        ? h('a', { class: 'alert-pill', href: '#/security', title: T('Есть неподтверждённые предупреждения безопасности') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), S.alerts === 1 ? T('1 предупреждение') : S.alerts + (S.alerts < 5 ? T(' предупреждения') : T(' предупреждений')))
        : null,
      S.recurringDue ? h('a', { class: 'alert-pill calm', href: '#/recurring', title: T('Регулярные операции, срок которых наступил') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), T('Пора провести: ') + S.recurringDue) : null,
      S.approvals ? h('a', { class: 'alert-pill calm', href: '#/journal', title: T('Крупные проводки ждут подтверждения второго сотрудника') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), T('На подтверждении: ') + S.approvals) : null,
      S.requests ? h('a', { class: 'alert-pill calm', href: '#/users', title: T('Запросы других администраторов ждут вашего решения') }, h('span', { class: 'dot', 'aria-hidden': 'true' }), T('Запросы: ') + S.requests) : null,
      h('div', { class: 'lock-indicator', id: 'lock-indicator' }),
      h('a', { class: 'userchip', href: '#/profile' }, h('b', null, S.user.displayName), h('span', null, S.roles[S.role || S.user.role] || '')),
      h('button', { class: 'btn small', type: 'button', title: T('Завершить сессию и стереть данные со страницы'), 'aria-label': T('Заблокировать'), onclick: (e) => petrifyLock(e.currentTarget, T('Приложение заблокировано.')) }, lockIcon(), h('span', { class: 'label' }, T('Заблокировать')))
    );
  }

  function sidebar(active) {
    const groups = new Map();
    for (const [key, r] of Object.entries(ROUTES)) {
      if (!r.group || !canRoute(r)) continue;
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(h('a', { class: 'nav-link' + (key === active ? ' active' : ''), href: '#/' + key }, r.title));
    }
    return h('nav', { class: 'sidebar', 'aria-label': T('Разделы') },
      [...groups].map(([g, links]) => h('div', { class: 'nav-group' }, h('div', null, g), links)),
      h('div', { class: 'sigil', title: T('Нагрудник первосвященника из Книги Исход: двенадцать камней в четыре ряда. Первый камень — рубин, по-древнееврейски «одем». Отсюда название приложения.') },
        h('img', { class: 'hoshen', src: 'img/hoshen.webp', alt: '', width: 84, height: 97, decoding: 'async', draggable: 'false' }),
        h('div', { class: 'word' }, T('Одем')),
        h('div', { class: 'note' }, T('рубин — первый из двенадцати камней')),
        S.license ? h('div', { class: 'lic-note' + (S.license.expired ? ' bad' : '') }, S.license.licensee ? T('Лицензия: ') + S.license.licensee + (S.license.expired ? T(' (истекла)') : '') : T('Демо-версия')) : null,
        h('a', { class: 'about-link', href: '#/about' }, T('О программе и поддержка'))
      )
    );
  }

  function accountSelect(value, { allowEmpty = true, onlyActive = false, placeholder = T('Все счета') } = {}) {
    return h('select', { value: value || '' },
      allowEmpty ? h('option', { value: '' }, placeholder) : null,
      S.accounts.filter((a) => !onlyActive || a.active).map((a) => h('option', { value: a.id }, accLabel(a) + (a.active ? '' : T(' (закрыт)'))))
    );
  }

  function cpSelect(value) {
    return h('select', { value: value || '' }, h('option', { value: '' }, '—'), S.counterparties.filter((c) => c.active).map((c) => h('option', { value: c.id }, c.name)));
  }

  function table(head, rows, opts = {}) {
    return h('div', { class: 'table-wrap' },
      h('table', null,
        opts.groupHead || null,
        h('thead', null, h('tr', null, head.map((c) => (typeof c === 'string' ? h('th', null, c) : h('th', { class: c.cls || '' }, c.t))))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: head.length, class: 'empty' }, opts.empty || T('Нет данных')))),
        opts.foot ? h('tfoot', null, opts.foot) : null
      )
    );
  }

  function downloadLink(label, url) {
    return h('a', { class: 'btn', href: url, download: '' }, label);
  }

  // ======================= Журнал проводок =======================

  function linesSummary(e, side) {
    const codes = e.lines.filter((l) => (side === 'dt' ? l.debit : l.credit) > 0).map((l) => (accById(l.accountId) || {}).code);
    return [...new Set(codes)].join(', ');
  }

  /** Крупные проводки и сторно, ждущие второго сотрудника. */
  async function approvalsCard() {
    const items = await api('GET', '/api/approvals');
    if (!items.length) return null;
    const card = h('div', { class: 'card approvals' });
    const decide = (p, ok) => async (e) => {
      let reason = '';
      if (!ok) {
        const mine = p.createdBy === S.user.id;
        if (!(await confirmDialog(mine ? T('Отозвать проводку?') : T('Отклонить проводку?'), mine ? T('Она не попадёт в учёт.') : T('Она не попадёт в учёт; автор увидит отказ в журнале аудита.'), mine ? T('Отозвать') : T('Отклонить'), true))) return;
      }
      await busy(e.target, null, async () => {
        const r = await api('POST', `/api/approvals/${encodeURIComponent(p.id)}/${ok ? 'approve' : 'reject'}`, { reason });
        const del = String(p.kind).startsWith('delete_');
        toast(ok ? (del ? T('Удаление подтверждено') : TF("Подтверждено: проводка №{0}", r.number)) : del ? T('Удаление отменено') : T('Проводка не принята'));
        S.approvals = Math.max(0, (S.approvals || 0) - (p.createdBy === S.user.id ? 0 : 1));
        route();
      });
    };
    fill(card,
      h('h2', null, T('Ждут подтверждения '), h('span', { class: 'badge warn' }, items.length)),
      h('p', { class: 'muted' }, T('Проводки больше порога компании и удаления (документов, шаблонов, регулярных операций) выполняются только после подтверждения другим сотрудником.')),
      table([T('Дата'), T('Содержание'), { t: T('Сумма'), cls: 'num' }, T('Автор'), ''], items.map((p) => h('tr', null,
        h('td', { class: 'nowrap' }, ruDate(p.date)),
        h('td', null, p.kind === 'reverse' ? h('span', { class: 'badge' }, T('сторно')) : String(p.kind).startsWith('delete_') ? h('span', { class: 'badge danger' }, T('удаление')) : null, ' ', p.description,
          p.lines.length ? h('div', { class: 'muted small' }, p.lines.map((l) => (S.accounts.find((a) => a.id === l.accountId) || {}).code + (l.debit ? T(' Дт ') : T(' Кт ')) + money(l.debit || l.credit)).join(' · ')) : null),
        h('td', { class: 'num' }, p.total ? money(p.total) : '—'),
        h('td', null, p.createdByName, h('div', { class: 'muted small' }, ruDateTime(p.createdAt))),
        h('td', { class: 'nowrap' }, can('write')
          ? (p.createdBy === S.user.id
            ? h('button', { class: 'btn small ghost', type: 'button', onclick: decide(p, false) }, T('Отозвать'))
            : [h('button', { class: 'btn small primary', type: 'button', onclick: decide(p, true) }, T('Подтвердить')), ' ', h('button', { class: 'btn small ghost', type: 'button', onclick: decide(p, false) }, T('Отклонить'))])
          : null)
      ))));
    return card;
  }

  async function viewJournal(body, params, head) {
    if (can('write')) head.append(h('a', { class: 'btn primary', href: '#/entry-new' }, T('+ Новая проводка')));
    const ap = await approvalsCard().catch(() => null);
    if (ap) body.append(ap);
    const f = {
      from: h('input', { type: 'date', value: params.get('from') || '' }),
      to: h('input', { type: 'date', value: params.get('to') || '' }),
      account: accountSelect(params.get('account')),
      q: h('input', { type: 'search', placeholder: T('Текст или номер'), value: params.get('q') || '' }),
    };
    const list = h('div', { class: 'card flush' });
    const info = h('span', { class: 'muted small' });
    const exportBtn = h('a', { class: 'btn', download: '' }, T('Экспорт CSV'));
    const export1c = {
      entries: h('a', { class: 'btn', download: '', title: T('Проводки парами Дт — Кт для загрузки в 1С из табличного документа') }, T('Проводки для 1С')),
      bank: h('a', { class: 'btn', download: '', title: T('Выписка по расчётному счёту в формате «1С: Клиент-банк» (для отбора по счёту выберите денежный счёт)') }, T('Выписка для 1С')),
    };
    let offset = 0;
    let rowsAcc = [];

    const filters = () => ({ from: f.from.value, to: f.to.value, account: f.account.value, q: f.q.value.trim() });

    async function load(reset) {
      if (reset) {
        offset = 0;
        rowsAcc = [];
      }
      const p = filters();
      exportBtn.href = '/api/export/entries.csv' + qs({ ...p, company: S.company });
      export1c.entries.href = '/api/export/1c-entries.csv' + qs({ from: p.from, to: p.to, company: S.company });
      export1c.bank.href = '/api/export/1c-bank.txt' + qs({ from: p.from, to: p.to, account: p.account, company: S.company });
      export1c.bank.hidden = !(S.org && S.org.country === 'RU');
      const res = await api('GET', '/api/entries' + qs({ ...p, offset, limit: 100 }));
      offset += res.items.length;
      rowsAcc.push(...res.items.map((e) =>
        h('tr', { class: 'clickable' + (e.reversedBy || e.reverses ? ' reversed' : ''), tabindex: 0, onclick: () => openEntry(e.id, () => load(true)), onkeydown: (ev) => { if (ev.key === 'Enter') openEntry(e.id, () => load(true)); } },
          h('td', { class: 'num' }, e.number),
          h('td', { class: 'nowrap' }, ruDate(e.date)),
          h('td', { class: 'desc' }, e.description, e.reversedBy ? h('span', null, ' ', h('span', { class: 'badge warn' }, T('сторнирована'))) : null, e.reverses ? h('span', null, ' ', h('span', { class: 'badge' }, T('сторно'))) : null, e.attachments ? h('span', { class: 'doc-count', title: TF("Документов: {0}", e.attachments) }, clipIcon(), String(e.attachments)) : null),
          h('td', { class: 'code' }, linesSummary(e, 'dt')),
          h('td', { class: 'code' }, linesSummary(e, 'ct')),
          h('td', { class: 'num' }, money(e.total)),
          h('td', { class: 'muted small' }, e.createdByName)
        )
      ));
      const more = offset < res.total ? h('div', { class: 'actions', style: null }, h('button', { class: 'btn', type: 'button', onclick: (ev) => busy(ev.target, null, () => load(false)) }, T('Показать ещё'))) : null;
      info.textContent = TF("Показано {0} из {1}", offset, res.total);
      const noFilters = !Object.values(p).some(Boolean);
      if (res.total === 0 && noFilters) {
        info.textContent = '';
        return fill(list, emptyState('img/ledger.webp', T('Журнал пока пуст'),
          T('Здесь появятся все проводки. Каждая сохраняется навсегда: ошибку исправляют сторнированием, а не правкой, поэтому история учёта всегда полная.'),
          can('write') ? h('a', { class: 'btn primary', href: '#/entry-new' }, T('Создать первую проводку')) : null));
      }
      fill(list, table([{ t: NO, cls: 'num' }, T('Дата'), T('Содержание'), T('Дт'), T('Кт'), { t: TF("Сумма, {0}", cur()), cls: 'num' }, T('Автор')], rowsAcc, { empty: T('По этим условиям проводок нет') }), more ? h('div', { class: 'dlg-foot' }, more) : null);
    }

    const apply = (e) => {
      e.preventDefault();
      history.replaceState(null, '', '#/journal' + qs(filters()));
      load(true).catch((er) => toast(er.message, 'error'));
    };
    body.append(
      h('form', { class: 'card filters', onsubmit: apply },
        field(T('С'), f.from), field(T('По'), f.to), h('label', { class: 'field grow' }, h('span', null, T('Счёт')), f.account), h('label', { class: 'field grow' }, h('span', null, T('Поиск')), f.q),
        h('button', { class: 'btn primary', type: 'submit' }, T('Показать')), exportBtn, export1c.entries, export1c.bank
      ),
      h('div', { class: 'actions', style: null }, info),
      list
    );
    await load(true);
  }

  async function openEntry(id, onChange) {
    const e = await api('GET', '/api/entries/' + encodeURIComponent(id)).catch((er) => toast(er.message, 'error'));
    if (!e) return;
    const cp = (cid) => (S.counterparties.find((c) => c.id === cid) || {}).name || '';
    const lines = table([T('Счёт'), { t: T('Дебет'), cls: 'num' }, { t: T('Кредит'), cls: 'num' }, T('Контрагент'), T('Комментарий')],
      e.lines.map((l) => h('tr', null, h('td', null, accLabel(accById(l.accountId))), h('td', { class: 'num' }, moneyOrBlank(l.debit)), h('td', { class: 'num' }, moneyOrBlank(l.credit)), h('td', null, cp(l.counterpartyId)), h('td', null, l.memo))),
      { foot: h('tr', null, h('td', null, T('Итого')), h('td', { class: 'num' }, money(e.total)), h('td', { class: 'num' }, money(e.total)), h('td'), h('td')) }
    );
    const err = errorBox();
    const footer = [];
    let revForm = null;
    const canReverse = can('write') && !e.reversedBy && !e.reverses;
    if (canReverse) {
      const d = h('input', { type: 'date', value: today() });
      const reason = h('input', { type: 'text', maxlength: 300, placeholder: T('Необязательно') });
      revForm = h('div', { class: 'card', style: null }, h('h3', { style: null }, T('Сторнирование')), h('p', { class: 'muted small' }, T('Проводки неизменяемы. Чтобы исправить ошибку, создаётся обратная (сторнирующая) проводка — история сохраняется.')), h('div', { class: 'row' }, field(T('Дата сторно'), d), field(T('Причина'), reason)));
      const btn = h('button', { class: 'btn danger', type: 'button', onclick: () => busy(btn, err, async () => {
        const r = await api('POST', `/api/entries/${encodeURIComponent(e.id)}/reverse`, { date: d.value, reason: reason.value });
        toast(r.pending ? r.message : TF("Создана сторнирующая проводка №{0}", r.number));
        dlg.close();
        if (onChange) onChange();
      }) }, T('Сторнировать'));
      footer.push(btn);
    }
    let docsChanged = false;
    if (can('write')) {
      footer.unshift(h('button', { class: 'btn ghost', type: 'button', onclick: () => {
        dlg.close();
        saveTemplateDialog(e.lines, e.reverses ? '' : e.description);
      } }, T('Сохранить как шаблон')));
      if (!e.reverses && !e.reversedBy) footer.unshift(h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); recurringDialog({ entryId: e.id, name: e.description.slice(0, 120), description: e.description }); } }, T('Сделать регулярной')));
    }
    const dlg = dialog(TF("Проводка №{0}", e.number), [
      h('dl', { class: 'meta' },
        h('dt', null, T('Дата')), h('dd', null, ruDate(e.date)),
        h('dt', null, T('Содержание')), h('dd', null, e.description),
        h('dt', null, T('Создана')), h('dd', null, `${ruDateTime(e.createdAt)}, ${e.createdByName}`),
        e.reverses ? [h('dt', null, T('Статус')), h('dd', null, T('Сторнирующая проводка'))] : null,
        e.reversedBy ? [h('dt', null, T('Статус')), h('dd', null, h('span', { class: 'badge warn' }, T('Сторнирована')))] : null,
        e.approvedByName ? [h('dt', null, T('Подтвердил')), h('dd', null, e.approvedByName, h('span', { class: 'muted small' }, ' · ', ruDateTime(e.approvedAt)))] : null,
        e.source && e.source.type === 'bank' ? [h('dt', null, T('Источник')), h('dd', null, TF("Банковская выписка «{0}»", e.source.file))] : null
      ),
      lines,
      documentsSection(e, () => { docsChanged = true; }),
      revForm,
      err,
    ], footer.length ? footer : null);
    dlg.addEventListener('close', () => { if (docsChanged && onChange) onChange(); });
  }

  // ======================= Документы (вложения) =======================

  const DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.heic,.doc,.docx,.xls,.xlsx,.pptx,.odt,.ods,.txt,.csv';
  const MAX_DOC = 10 * 1024 * 1024;

  function fileSize(n) {
    if (n < 1024) return TF("{0} Б", n);
    if (n < 1048576) return TF("{0} КБ", Math.ceil(n / 1024));
    return TF("{0} МБ", (n / 1048576).toFixed(1).replace('.', DEC));
  }

  function svgIcon(d, size = 14) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
    return svg;
  }
  const clipIcon = () => svgIcon('M13 7.5 8.2 12.3a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8l-5 5a1 1 0 0 1-1.4-1.4L10 4.9');

  /** Загружает файлы по одному; ошибки по отдельным файлам не прерывают остальные. */
  async function uploadDocs(entryId, files, onEach) {
    const res = { ok: 0, errors: [] };
    for (const f of files) {
      try {
        if (f.size > MAX_DOC) throw new Error(T('файл больше 10 МБ'));
        await api('POST', `/api/entries/${encodeURIComponent(entryId)}/attachments`, { fileName: f.name, content: await fileToBase64(f) });
        res.ok++;
      } catch (e) {
        res.errors.push(`${f.name}: ${e.message}`);
      }
      if (onEach) onEach();
    }
    return res;
  }

  function reportUpload(r) {
    if (r.ok) toast(TF("Прикреплено {0} {1}", r.ok, plural(r.ok, T('документ'), T('документа'), T('документов'))));
    for (const e of r.errors) toast(e, 'error');
  }

  function previewDoc(a) {
    const url = `/api/attachments/${encodeURIComponent(a.id)}/content` + qs({ company: S.company, inline: 1 });
    if (a.preview === 'pdf') {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const d = dialog(a.fileName, h('div', { class: 'doc-preview' }, h('img', { src: url, alt: a.fileName })),
      [h('a', { class: 'btn', href: `/api/attachments/${encodeURIComponent(a.id)}/content` + qs({ company: S.company }), download: a.fileName }, T('Скачать'))]);
    d.classList.add('wide');
  }

  function documentsSection(entry, onChange) {
    const canEdit = can('write');
    const list = h('div', { class: 'doc-list' });
    const status = h('div', { class: 'muted small' });
    const input = h('input', { type: 'file', multiple: true, accept: DOC_ACCEPT, class: 'visually-hidden' });
    const drop = canEdit
      ? h('label', { class: 'dropzone' }, input, clipIcon(), h('span', null, h('b', null, T('Прикрепить документы')), h('span', { class: 'muted small' }, T(' — перетащите файлы или нажмите. PDF, сканы и фото, Word, Excel; до 10 МБ'))))
      : null;

    async function refresh() {
      const items = await api('GET', `/api/entries/${encodeURIComponent(entry.id)}/attachments`).catch((e) => {
        toast(e.message, 'error');
        return [];
      });
      fill(list, items.length ? items.map(row) : h('div', { class: 'muted small' }, T('К проводке пока не прикреплено документов.')));
    }

    function row(a) {
      const url = `/api/attachments/${encodeURIComponent(a.id)}/content` + qs({ company: S.company });
      const ext = (a.fileName.split('.').pop() || '').slice(0, 4).toUpperCase();
      return h('div', { class: 'doc' },
        h('span', { class: 'doc-icon' + (a.preview === 'pdf' ? ' pdf' : a.preview === 'image' ? ' img' : '') }, ext),
        h('div', { class: 'doc-main' },
          h('div', { class: 'doc-name' }, a.fileName),
          h('div', { class: 'muted small' }, `${fileSize(a.size)}, ${ruDateTime(a.uploadedAt)}, ${a.uploadedByName}`)
        ),
        h('div', { class: 'doc-actions' },
          a.preview ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => previewDoc(a) }, T('Открыть')) : null,
          h('a', { class: 'btn small ghost', href: url, download: a.fileName }, T('Скачать')),
          canEdit ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => remove(a) }, T('Удалить')) : null
        )
      );
    }

    async function remove(a) {
      if (!(await confirmDialog(TF("Удалить «{0}»?", a.fileName), T('Документ исчезнет из проводки. Его копия останется в резервных копиях, созданных раньше, а удаление будет записано в журнал аудита.'), T('Удалить'), true))) return;
      try {
        const r = await api('DELETE', `/api/attachments/${encodeURIComponent(a.id)}`);
        toast(r && r.pending ? T('Удаление отправлено на подтверждение другому сотруднику') : T('Документ удалён'));
        onChange();
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    async function upload(files) {
      if (!files.length) return;
      let n = 0;
      status.textContent = TF("Загрузка 0 из {0}…", files.length);
      const r = await uploadDocs(entry.id, files, () => {
        n++;
        status.textContent = TF("Загрузка {0} из {1}…", n, files.length);
      });
      status.textContent = '';
      input.value = '';
      reportUpload(r);
      if (r.ok) onChange();
      await refresh();
    }

    if (drop) {
      input.addEventListener('change', () => upload([...input.files]));
      drop.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        drop.classList.add('over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (ev) => {
        ev.preventDefault();
        drop.classList.remove('over');
        upload([...ev.dataTransfer.files]);
      });
    }
    refresh();
    return h('div', { class: 'docs' }, h('h3', null, T('Документы')), list, drop, status);
  }

  // ======================= Шаблоны: общие помощники =======================

  function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
  }

  /** Сумма строки = основная сумма × num / den, округление до копейки (BigInt — без переполнения). */
  function scaleAmount(base, ratio) {
    const n = BigInt(base) * BigInt(ratio.num) * 2n + BigInt(ratio.den);
    return Number(n / (2n * BigInt(ratio.den)));
  }

  /** Суммы строк шаблона; копейка от округления уходит в крупнейшую строку недостающей стороны. */
  function templateAmounts(t, base) {
    const amts = t.lines.map((l) => (l.ratio && base ? scaleAmount(base, l.ratio) : 0));
    if (base && t.lines.every((l) => l.ratio)) {
      let dt = 0;
      let ct = 0;
      t.lines.forEach((l, i) => {
        if (l.side === 'debit') dt += amts[i];
        else ct += amts[i];
      });
      const diff = dt - ct;
      if (diff && Math.abs(diff) <= t.lines.length) {
        // Строки с основной суммой (доля 1/1) не трогаем — копейку округления забирает производная строка.
        const over = diff > 0 ? 'debit' : 'credit';
        const pick = (side) => {
          let idx = -1;
          t.lines.forEach((l, i) => {
            if (l.side === side && l.ratio.num !== l.ratio.den && (idx < 0 || amts[i] > amts[idx])) idx = i;
          });
          return idx;
        };
        let idx = pick(over);
        if (idx >= 0 && amts[idx] > Math.abs(diff)) amts[idx] -= Math.abs(diff);
        else if ((idx = pick(over === 'debit' ? 'credit' : 'debit')) >= 0) amts[idx] += Math.abs(diff);
      }
    }
    return amts;
  }

  const RATIO_MODES = [
    { key: 'base', label: T('= основная сумма'), num: 1, den: 1 },
    { key: 'vat20', label: T('НДС 20% в т.ч.'), num: 1, den: 6 },
    { key: 'net20', label: T('без НДС 20%'), num: 5, den: 6 },
    { key: 'vat10', label: T('НДС 10% в т.ч.'), num: 1, den: 11 },
    { key: 'net10', label: T('без НДС 10%'), num: 10, den: 11 },
    { key: 'pct', label: T('% от основной') },
    { key: 'manual', label: T('вручную') },
  ];

  function ratioMode(r) {
    if (!r) return { key: 'manual' };
    const preset = RATIO_MODES.find((m) => m.num && r.num * m.den === m.num * r.den);
    if (preset) return { key: preset.key };
    return { key: 'pct', pct: String(+((r.num / r.den) * 100).toFixed(4)).replace('.', DEC) };
  }

  function ratioLabel(r) {
    const m = ratioMode(r);
    if (m.key === 'base') return '';
    if (m.key === 'pct') return TF("{0}% от основной", m.pct);
    return RATIO_MODES.find((x) => x.key === m.key).label;
  }

  const amountText = (k) => (k ? money(k).split(NBSP).join(' ') : '');

  /** Курс в «микроединицах» (×1 000 000), как на сервере. */
  function parseRateMicro(s) {
    const m = /^(\d{1,9})(?:[.,](\d{1,6}))?$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 1e6 + Number((m[2] || '').padEnd(6, '0')) : 0;
  }

  /** Сохраняет строки проводки как шаблон: суммы превращаются в доли от наибольшей суммы. */
  function saveTemplateDialog(srcLines, description, onSaved) {
    const valid = srcLines.filter((l) => l.accountId && (l.debit || l.credit));
    if (valid.length < 2) return toast(T('Заполните хотя бы две строки со счетами и суммами'), 'error');
    const max = Math.max(...valid.map((l) => l.debit || l.credit));
    const tlines = valid.map((l) => {
      const a = l.debit || l.credit;
      const g = gcd(a, max);
      return { accountId: l.accountId, side: l.debit ? 'debit' : 'credit', ratio: { num: a / g, den: max / g }, counterpartyId: l.counterpartyId || null, memo: l.memo || '' };
    });
    const err = errorBox();
    const name = h('input', { type: 'text', maxlength: 100 });
    const d = h('input', { type: 'text', maxlength: 500, value: description || '' });
    const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
      const t = await api('POST', '/api/templates', { name: name.value, description: d.value, lines: tlines });
      dlg.close();
      toast(TF("Шаблон «{0}» сохранён", t.name));
      if (onSaved) onSaved(t);
    }) }, T('Сохранить шаблон'));
    const dlg = dialog(T('Сохранить как шаблон'), [
      err,
      field(T('Название шаблона'), name),
      field(T('Содержание операции'), d),
      h('div', { class: 'tpl-lines card' }, tlines.map((l) => templateLineView(l))),
      h('p', { class: 'muted small' }, TF("Суммы сохраняются как доли от основной суммы {0}. При использовании шаблона достаточно ввести новую основную сумму — остальные строки пересчитаются.", money(max))),
    ], [save]);
    name.focus();
  }

  function templateLineView(l, compact = false) {
    const a = accById(l.accountId);
    return h('div', { class: 'tpl-line', title: a ? `${a.code} ${a.name}` : '' },
      h('span', { class: 'side' }, l.side === 'debit' ? T('Дт') : T('Кт')),
      h('span', { class: 'code' }, a ? a.code : '?'),
      compact ? null : h('span', { class: 'name' }, a ? a.name : T('счёт удалён')),
      l.ratio && ratioMode(l.ratio).key === 'base' ? null : h('span', { class: 'badge' }, ratioLabel(l.ratio))
    );
  }

  // ======================= Новая проводка =======================

  async function viewEntryNew(body, params) {
    const err = errorBox();
    const date = h('input', { type: 'date', value: today(), required: true });
    const desc = h('input', { type: 'text', maxlength: 500, placeholder: T('Например: Оплата поставщику по счёту №15'), required: true });
    const tbody = h('tbody');
    const totDt = h('td', { class: 'num' });
    const totCt = h('td', { class: 'num' });
    const diff = h('td', { colspan: 3 });
    const lines = [];
    let templates = await api('GET', '/api/templates').catch(() => []);
    date.addEventListener('change', () => { for (const l of lines) if (l.fxAcc && l.fxAcc()) { l.fxRate.value = ''; l.fxSync(); } });
    let active = null;
    const docsInput = h('input', { type: 'file', multiple: true, accept: DOC_ACCEPT, class: 'file-input' });

    function recalc() {
      let dt = 0;
      let ct = 0;
      let bad = false;
      for (const l of lines) {
        const d = parseMoney(l.dt.value);
        const c = parseMoney(l.ct.value);
        l.dt.setAttribute('aria-invalid', d === null ? 'true' : 'false');
        l.ct.setAttribute('aria-invalid', c === null ? 'true' : 'false');
        if (d === null || c === null) bad = true;
        dt += d || 0;
        ct += c || 0;
      }
      totDt.textContent = money(dt);
      totCt.textContent = money(ct);
      const delta = dt - ct;
      diff.className = delta === 0 && dt > 0 && !bad ? 'diff-ok' : 'diff-bad';
      diff.textContent = bad ? T('Некорректная сумма') : delta === 0 ? (dt > 0 ? T('Дебет = Кредит') : '') : TF("Разница: {0} ({1})", money(Math.abs(delta)), delta > 0 ? T('дебет больше') : T('кредит больше'));
    }

    function addLine(preset = {}) {
      const l = {
        acc: accountSelect(preset.accountId, { onlyActive: true, placeholder: T('— выберите счёт —') }),
        dt: h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: money(0), 'aria-label': T('Дебет') }),
        ct: h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: money(0), 'aria-label': T('Кредит') }),
        cp: cpSelect(preset.counterpartyId),
        memo: h('input', { type: 'text', maxlength: 200, 'aria-label': T('Комментарий'), value: preset.memo || '' }),
        fxAmt: h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: money(0), 'aria-label': T('Сумма в валюте') }),
        fxRate: h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: T('курс'), 'aria-label': T('Курс') }),
        fxSide: h('select', { 'aria-label': T('Сторона') }, h('option', { value: 'debit' }, T('Дт')), h('option', { value: 'credit' }, T('Кт'))),
      };
      l.fxCur = h('span', { class: 'fx-cur' });
      l.fxNote = h('span', { class: 'muted small' });
      l.fxBox = h('div', { class: 'fx-box', hidden: true }, l.fxSide, l.fxAmt, l.fxCur, h('span', { class: 'muted' }, '×'), l.fxRate, l.fxNote);
      l.fxAcc = () => { const a = accById(l.acc.value); return a && a.currency && a.currency !== S.org.currency ? a : null; };
      l.fxCalc = () => {
        if (!l.fxAcc()) return;
        const dec = decimalsOf(l.fxAcc().currency);
        const amt = parseUnits(l.fxAmt.value, dec);
        const rate = parseRateMicro(l.fxRate.value);
        const dv = 1000000n * 10n ** BigInt(dec - 2);
        const baseAmt = amt && rate ? Number((BigInt(amt) * BigInt(rate) * 2n + dv) / (2n * dv)) : 0;
        (l.fxSide.value === 'debit' ? l.dt : l.ct).value = baseAmt ? amountText(baseAmt) : '';
        (l.fxSide.value === 'debit' ? l.ct : l.dt).value = '';
        recalc();
      };
      l.fxSync = async () => {
        const a = l.fxAcc();
        l.fxBox.hidden = !a;
        l.dt.readOnly = l.ct.readOnly = !!a;
        if (!a) return;
        l.fxCur.textContent = a.currency;
        l.fxAmt.placeholder = decimalsOf(a.currency) === 2 ? money(0) : '0' + DEC + '0'.repeat(decimalsOf(a.currency));
        try {
          const r = await api('GET', '/api/rates/lookup' + qs({ currency: a.currency, date: date.value }));
          if (r && !l.fxRate.value) l.fxRate.value = r.rateText.replace('.', DEC);
          l.fxNote.textContent = r ? TF("курс на {0}, {1}", ruDate(r.date), r.source) : T('курса нет — введите вручную');
        } catch { /* курс введут вручную */ }
        l.fxCalc();
      };
      for (const el of [l.fxAmt, l.fxRate]) el.addEventListener('input', l.fxCalc);
      l.fxSide.addEventListener('change', l.fxCalc);
      l.acc.addEventListener('change', () => l.fxSync());
      if (preset.accountId) setTimeout(() => l.fxSync(), 0);
      l.dt.addEventListener('input', () => { if (l.dt.value) l.ct.value = ''; recalc(); });
      l.ct.addEventListener('input', () => { if (l.ct.value) l.dt.value = ''; recalc(); });
      const rm = h('button', { class: 'btn ghost small', type: 'button', 'aria-label': T('Удалить строку'), onclick: () => {
        if (lines.length <= 2) return toast(T('В проводке должно быть минимум 2 строки'), 'error');
        lines.splice(lines.indexOf(l), 1);
        l.row.remove();
        recalc();
      } }, '✕');
      l.row = h('tr', null, h('td', { class: 'col-acc' }, l.acc, l.fxBox), h('td', { class: 'col-amt' }, l.dt), h('td', { class: 'col-amt' }, l.ct), h('td', { class: 'col-cp' }, l.cp), h('td', null, l.memo), h('td', null, rm));
      lines.push(l);
      tbody.append(l.row);
      return l;
    }

    function resetLines() {
      for (const l of lines.splice(0)) l.row.remove();
      addLine();
      addLine();
      recalc();
    }

    /** Подставляет остаток разницы в последнюю пустую строку. */
    function balanceLast() {
      let dt = 0;
      let ct = 0;
      for (const l of lines) { dt += parseMoney(l.dt.value) || 0; ct += parseMoney(l.ct.value) || 0; }
      const delta = dt - ct;
      if (!delta) return;
      const target = lines.find((l) => !l.dt.value && !l.ct.value) || addLine();
      (delta > 0 ? target.ct : target.dt).value = amountText(Math.abs(delta));
      recalc();
    }

    if (!S.accounts.some((a) => a.active)) {
      body.append(h('div', { class: 'alert warn' }, T('Нет открытых счетов. Сначала создайте счета в плане счетов.')));
      return;
    }

    // ---- шаблоны ----
    const tplSel = h('select');
    const baseInput = h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: money(0) });
    const baseField = h('label', { class: 'field narrow' }, h('span', null, T('Основная сумма')), baseInput);
    const tplHint = h('div', { class: 'muted small' });
    const chips = h('div', { class: 'chips' });

    function renderTemplateControls() {
      fill(tplSel, h('option', { value: '' }, T('— без шаблона —')), templates.map((t) => h('option', { value: t.id }, t.name)));
      tplSel.value = active ? active.id : '';
      fill(chips, templates.slice(0, 6).map((t) => h('button', { type: 'button', class: 'chip' + (active && active.id === t.id ? ' active' : ''), onclick: () => pickTemplate(t.id) }, t.name)));
      const needsBase = !!(active && active.lines.some((l) => l.ratio));
      baseField.hidden = !needsBase;
      tplHint.textContent = active
        ? needsBase
          ? T('Введите основную сумму — суммы строк рассчитаются по шаблону. Их можно поправить вручную.')
          : T('Счета подставлены, суммы введите вручную.')
        : '';
    }

    function pickTemplate(id) {
      active = templates.find((t) => t.id === id) || null;
      renderTemplateControls();
      if (!active) return resetLines();
      applyTemplate(false);
      if (!baseField.hidden) {
        baseInput.focus();
        baseInput.select();
      }
    }

    function applyTemplate(amountsOnly) {
      const t = active;
      if (!t) return;
      const base = parseMoney(baseInput.value);
      baseInput.setAttribute('aria-invalid', base === null ? 'true' : 'false');
      if (base === null) return;
      const amts = templateAmounts(t, base);
      if (!amountsOnly || lines.length !== t.lines.length) {
        for (const l of lines.splice(0)) l.row.remove();
        for (const tl of t.lines) addLine(tl);
        if (t.description) desc.value = t.description;
      }
      t.lines.forEach((tl, i) => {
        const l = lines[i];
        if (!tl.ratio && amountsOnly) return; // ручные суммы не трогаем
        const v = tl.ratio ? amountText(amts[i]) : '';
        if (tl.side === 'debit') {
          l.dt.value = v;
          l.ct.value = '';
        } else {
          l.ct.value = v;
          l.dt.value = '';
        }
      });
      recalc();
    }

    tplSel.addEventListener('change', () => pickTemplate(tplSel.value));
    baseInput.addEventListener('input', () => applyTemplate(true));
    baseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        desc.focus();
      }
    });

    resetLines();
    renderTemplateControls();

    function currentLines() {
      return lines.map((l) => ({ accountId: l.acc.value, debit: parseMoney(l.dt.value) || 0, credit: parseMoney(l.ct.value) || 0, counterpartyId: l.cp.value || null, memo: l.memo.value }));
    }

    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Провести'));
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const payload = { date: date.value, description: desc.value, lines: [], templateId: active ? active.id : undefined };
        for (const [i, l] of lines.entries()) {
          const d = parseMoney(l.dt.value);
          const c = parseMoney(l.ct.value);
          if (d === null || c === null) return err.show(TF("Строка {0}: некорректная сумма", i + 1));
          if (!l.acc.value && !d && !c) continue;
          const line = { accountId: l.acc.value, debit: d, credit: c, counterpartyId: l.cp.value || null, memo: l.memo.value };
          if (l.fxAcc && l.fxAcc()) line.fx = { amount: parseUnits(l.fxAmt.value, decimalsOf(l.fxAcc().currency)) || 0, rate: String(l.fxRate.value).replace(',', '.') };
          payload.lines.push(line);
        }
        busy(btn, err, async () => {
          const r = await api('POST', '/api/entries', payload);
          if (r.pending) {
            toast(TF("На подтверждение: {0} — {1}. В учёт проводка попадёт после подтверждения другим сотрудником.", money(r.approval.total), r.approval.description));
          } else {
            toast(TF("Проводка №{0} сохранена", r.number));
            engrave(btn.parentElement, r.number, desc.value);
          }
          const files = [...docsInput.files];
          docsInput.value = '';
          if (files.length) reportUpload(await uploadDocs(r.id, files));
          desc.value = '';
          baseInput.value = '';
          if (active) {
            active.uses = (active.uses || 0) + 1;
            applyTemplate(false);
            desc.value = '';
            if (active.description) desc.value = active.description;
            if (!baseField.hidden) baseInput.focus();
          } else {
            resetLines();
            desc.focus();
          }
        });
      },
    },
      templates.length || can('write')
        ? h('div', { class: 'card tpl-bar' },
          h('div', { class: 'row' }, field(T('Шаблон'), tplSel), baseField, h('a', { class: 'btn ghost', href: '#/templates' }, T('Все шаблоны'))),
          tplHint,
          chips
        )
        : null,
      h('div', { class: 'card' },
        S.settings.closedUntil ? h('div', { class: 'alert info' }, TF("Период по {0} закрыт: проводки с датой не позже этой даты запрещены.", ruDate(S.settings.closedUntil))) : null,
        h('div', { class: 'row' }, h('label', { class: 'field narrow' }, h('span', null, T('Дата')), date), field(T('Содержание операции'), desc)),
        h('div', { class: 'row', style: null }, field(T('Документы'), docsInput, T('счёт, акт, чек — прикрепятся после проведения')))
      ),
      h('div', { class: 'card flush' },
        h('div', { class: 'table-wrap' },
          h('table', { class: 'lines' },
            h('thead', null, h('tr', null, h('th', null, T('Счёт')), h('th', { class: 'num' }, T('Дебет')), h('th', { class: 'num' }, T('Кредит')), h('th', null, T('Контрагент')), h('th', null, T('Комментарий')), h('th'))),
            tbody,
            h('tfoot', null, h('tr', null, h('td', null, T('Итого')), totDt, totCt, diff, h('td')))
          )
        )
      ),
      err,
      h('div', { class: 'actions' },
        btn,
        h('button', { class: 'btn', type: 'button', onclick: () => { addLine(); } }, T('+ Строка')),
        h('button', { class: 'btn', type: 'button', onclick: balanceLast, title: T('Подставить разницу в пустую строку') }, T('Уравнять')),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => saveTemplateDialog(currentLines(), desc.value, (t) => {
          templates = [t, ...templates];
          active = t;
          renderTemplateControls();
        }) }, T('Сохранить как шаблон'))
      )
    );
    body.append(form);
    const pre = params && params.get('template');
    if (pre && templates.some((t) => t.id === pre)) pickTemplate(pre);
    else desc.focus();
  }

  // ======================= Шаблоны проводок =======================

  async function viewTemplates(body, params, head) {
    const list = h('div');
    let templates = [];
    const seedBtn = h('button', { class: 'btn', type: 'button', onclick: () => busy(seedBtn, null, async () => {
      const r = await api('POST', '/api/templates/standard');
      toast(r.added ? TF("Добавлено стандартных шаблонов: {0}", r.added) : T('Все стандартные шаблоны уже есть'));
      await load();
    }) }, T('Добавить стандартные'));
    head.append(h('div', { class: 'head-actions' }, seedBtn, h('button', { class: 'btn primary', type: 'button', onclick: () => editTemplate(null) }, T('+ Новый шаблон'))));
    body.append(
      h('p', { class: 'muted' }, T('Шаблон хранит счета и доли сумм типовой операции. В новой проводке выберите шаблон и введите основную сумму — остальные строки (НДС, НДФЛ, взносы) рассчитаются сами.')),
      list
    );

    async function load() {
      templates = await api('GET', '/api/templates');
      render();
    }

    function render() {
      if (!templates.length) {
        return fill(list, h('div', { class: 'card' }, emptyMini('img/em/stamp.webp', T('Шаблонов пока нет. Добавьте стандартные или создайте свой.'))));
      }
      fill(list, h('div', { class: 'card flush' }, table([T('Шаблон'), T('Строки'), { t: T('Использован'), cls: 'num' }, ''],
        templates.map((t) => h('tr', null,
          h('td', { class: 'tpl-name' }, h('b', null, t.name), t.description ? h('div', { class: 'muted small' }, t.description) : null),
          h('td', null, h('div', { class: 'tpl-lines compact' }, t.lines.map((l) => templateLineView(l, true)))),
          h('td', { class: 'num' }, t.uses ? `${t.uses} ${plural(t.uses, T('раз'), T('раза'), T('раз'))}` : '—'),
          h('td', { class: 'nowrap' },
            h('a', { class: 'btn small primary', href: '#/entry-new?template=' + encodeURIComponent(t.id) }, T('Применить')), ' ',
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => editTemplate(t) }, T('Изменить')),
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => remove(t) }, T('Удалить'))
          )
        ))
      )));
    }

    async function remove(t) {
      if (!(await confirmDialog(TF("Удалить шаблон «{0}»?", t.name), T('Проводки, сделанные по шаблону, останутся без изменений.'), T('Удалить'), true))) return;
      try {
        const r = await api('DELETE', '/api/templates/' + encodeURIComponent(t.id));
        toast(r && r.pending ? T('Удаление отправлено на подтверждение другому сотруднику') : T('Шаблон удалён'));
        await load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    function editTemplate(t) {
      const err = errorBox();
      const name = h('input', { type: 'text', maxlength: 100, value: t ? t.name : '' });
      const d = h('input', { type: 'text', maxlength: 500, value: t ? t.description : '' });
      const tbody = h('tbody');
      const rows = [];

      function addRow(src) {
        const s = src || { side: rows.length % 2 ? 'credit' : 'debit', ratio: { num: 1, den: 1 } };
        const r = { ratio: s.ratio || null, dirty: false };
        const mode = ratioMode(r.ratio);
        r.acc = accountSelect(s.accountId || '', { onlyActive: true, placeholder: T('— счёт —') });
        r.side = h('select', { value: s.side }, h('option', { value: 'debit' }, T('Дебет')), h('option', { value: 'credit' }, T('Кредит')));
        r.mode = h('select', { value: mode.key }, RATIO_MODES.map((m) => h('option', { value: m.key }, m.label)));
        r.pct = h('input', { type: 'text', inputmode: 'decimal', class: 'amount pct', value: mode.pct || '', placeholder: '%', 'aria-label': T('Процент от основной суммы') });
        r.pct.hidden = mode.key !== 'pct';
        r.mode.addEventListener('change', () => {
          r.pct.hidden = r.mode.value !== 'pct';
          r.dirty = true;
          if (!r.pct.hidden) r.pct.focus();
        });
        r.pct.addEventListener('input', () => { r.dirty = true; });
        r.cp = cpSelect(s.counterpartyId);
        r.memo = h('input', { type: 'text', maxlength: 200, value: s.memo || '', 'aria-label': T('Комментарий') });
        r.tr = h('tr', null,
          h('td', { class: 'col-acc' }, r.acc),
          h('td', null, r.side),
          h('td', null, h('div', { class: 'mode' }, r.mode, r.pct)),
          h('td', { class: 'col-cp' }, r.cp),
          h('td', null, r.memo),
          h('td', null, h('button', { class: 'btn ghost small', type: 'button', 'aria-label': T('Удалить строку'), onclick: () => {
            if (rows.length <= 2) return toast(T('В шаблоне нужно минимум 2 строки'), 'error');
            rows.splice(rows.indexOf(r), 1);
            r.tr.remove();
          } }, '✕'))
        );
        rows.push(r);
        tbody.append(r.tr);
      }

      function ratioOf(r, n) {
        if (!r.dirty) return r.ratio;
        const key = r.mode.value;
        if (key === 'manual') return null;
        if (key === 'pct') {
          const v = Number(String(r.pct.value).replace(',', '.').trim());
          if (!(v > 0) || v > 1000000) throw new Error(TF("Строка {0}: укажите процент от основной суммы", n));
          return { num: Math.round(v * 10000), den: 1000000 };
        }
        const m = RATIO_MODES.find((x) => x.key === key);
        return { num: m.num, den: m.den };
      }

      (t ? t.lines : [null, null]).forEach((l) => addRow(l));
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
        const payload = { name: name.value, description: d.value, lines: rows.map((r, i) => ({ accountId: r.acc.value, side: r.side.value, ratio: ratioOf(r, i + 1), counterpartyId: r.cp.value || null, memo: r.memo.value })) };
        if (t) await api('PATCH', '/api/templates/' + encodeURIComponent(t.id), payload);
        else await api('POST', '/api/templates', payload);
        dlg.close();
        toast(t ? T('Шаблон сохранён') : T('Шаблон создан'));
        await load();
      }) }, t ? T('Сохранить') : T('Создать шаблон'));
      const dlg = dialog(t ? TF("Шаблон «{0}»", t.name) : T('Новый шаблон'), [
        err,
        h('div', { class: 'row' }, field(T('Название'), name), field(T('Содержание операции'), d, T('подставится в проводку'))),
        h('div', { class: 'card flush', style: null },
          h('div', { class: 'table-wrap' }, h('table', { class: 'lines' },
            h('thead', null, h('tr', null, h('th', null, T('Счёт')), h('th', null, T('Сторона')), h('th', null, T('Сумма строки')), h('th', null, T('Контрагент')), h('th', null, T('Комментарий')), h('th'))),
            tbody
          ))
        ),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow() }, T('+ Строка'))),
        h('p', { class: 'muted small' }, T('Основная сумма — наибольшая сумма операции (например, сумма с НДС или начисленная зарплата). «НДС 20% в т.ч.» = основная × 20/120, «без НДС 20%» = основная × 100/120.')),
      ], [save]);
      dlg.classList.add('wide');
      name.focus();
    }

    await load();
  }

  // ======================= Загрузка из Excel =======================

  const TABLE_KINDS = {
    counterparties: { label: T('Контрагенты'), headers: [T('Наименование'), T('ИНН'), T('КПП'), T('Адрес'), T('Примечание'), T('Вид (организация / физлицо)')], sample: ['ООО «Альфа»', '7701234567', '770101001', 'г. Москва, ул. Лесная, 1', '', 'организация'], cols: ['name', 'taxId', 'kpp', 'address', 'note'] },
    accounts: { label: T('План счетов'), headers: [T('Код'), T('Наименование'), T('Тип (актив / пассив / капитал / доходы / расходы)'), T('Валюта')], sample: ['51.1', T('Расчётный счёт в банке Б'), T('актив'), ''], cols: ['code', 'name', 'type', 'currency'] },
    balances: { label: T('Начальные остатки'), headers: [T('Счёт'), T('Дебет'), T('Кредит'), T('Контрагент')], sample: ['51', '150000,00', '', ''], cols: ['code', 'debit', 'credit', 'counterparty'] },
  };

  async function viewTables(body) {
    const err = errorBox();
    const kind = h('select', null, Object.entries(TABLE_KINDS).map(([k, v]) => h('option', { value: k }, v.label)));
    const file = h('input', { type: 'file', accept: '.xlsx,.csv,.txt' });
    const date = h('input', { type: 'date', value: yearStart() });
    const dateField = field(T('Дата остатков'), date, T('обычно — начало года или день перехода в Одем'));
    const tplBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
      const k = TABLE_KINDS[kind.value];
      const cell = (s) => (/[;"\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s);
      const text = '\ufeff' + [k.headers, k.sample].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      const a = h('a', { href: url, download: 'odem-' + kind.value + '.csv' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } }, T('Скачать шаблон'));
    const checkBtn = h('button', { class: 'btn primary', type: 'submit' }, T('Проверить файл'));
    const out = h('div');
    let content = null;
    const syncKind = () => {
      dateField.hidden = kind.value !== 'balances';
      fill(out);
    };
    kind.addEventListener('change', syncKind);
    file.addEventListener('change', () => fill(out));
    syncKind();

    const form = h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      busy(checkBtn, err, async () => {
        const f = file.files[0];
        if (!f) throw new Error(T('Выберите файл'));
        content = await fileToBase64(f);
        const r = await api('POST', '/api/import/table/preview', { kind: kind.value, content, fileName: f.name });
        renderPreview(r, f.name);
      });
    } },
    h('p', { class: 'muted' }, T('Подойдёт файл Excel (.xlsx) или CSV из 1С, банка или другой программы. Колонки узнаются по заголовкам; если заголовков нет — порядок как в шаблоне. Сначала файл проверяется: вы увидите, что будет добавлено, а что пропущено и почему.')),
    err,
    h('div', { class: 'row' }, field(T('Что загружаем'), kind), field(T('Файл'), file), dateField),
    h('div', { class: 'actions' }, checkBtn, tplBtn));
    body.append(form, out);

    function renderPreview(r, fileName) {
      const k = TABLE_KINDS[r.kind];
      const badge = (s) => (s === 'ok' ? h('span', { class: 'badge ok' }, T('будет добавлено')) : s === 'skip' ? h('span', { class: 'badge' }, T('пропуск')) : h('span', { class: 'badge danger' }, T('ошибка')));
      const show = (it, c) => {
        const v = it.values[c];
        if (c === 'debit' || c === 'credit') return v ? money(v) : '';
        if (c === 'type') return v ? (S.types[v] || v) : '';
        return v == null ? '' : String(v);
      };
      const unbalanced = r.kind === 'balances' && r.difference !== 0;
      const commit = h('button', { class: 'btn primary', type: 'button', disabled: !r.summary.ok || unbalanced, onclick: () => busy(commit, null, async () => {
        const res = await api('POST', '/api/import/table/commit', { kind: r.kind, content, fileName, date: date.value });
        if (res.pending) toast(res.message);
        else toast(TF('Загружено: {0}. Пропущено: {1}.', res.added, res.skipped));
        await loadRefs();
        fill(out, h('div', { class: 'alert ok' }, TF('Загружено строк: {0}.', res.added), res.entry ? [' ', h('a', { href: '#/journal' }, TF('Проводка №{0}', res.entry.number))] : null));
      }) }, T('Загрузить'));
      fill(out,
        h('div', { class: 'card' },
          h('h3', null, TF('{0}: {1}', k.label, fileName)),
          h('p', null, TF('Будет добавлено: {0}. Пропущено: {1}. С ошибками: {2}.', r.summary.ok, r.summary.skip, r.summary.error),
            r.headerRow > 0 ? h('span', { class: 'muted' }, ' ' + TF('Заголовки — в строке {0}.', r.headerRow)) : h('span', { class: 'muted' }, ' ' + T('Заголовков нет — колонки взяты по порядку шаблона.'))),
          r.kind === 'balances' ? h('div', { class: unbalanced ? 'alert error' : 'alert ok' },
            TF('Дебет: {0}. Кредит: {1}.', money(r.debit), money(r.credit)), ' ',
            unbalanced ? TF('Разница {0} — остатки должны сходиться: проверьте файл.', money(Math.abs(r.difference))) : T('Остатки сходятся: будет создана одна проводка «Ввод начальных остатков».')) : null,
          h('div', { class: 'actions' }, commit)),
        h('div', { class: 'card flush' }, table([T('Строка'), ...k.cols.map((c, i) => k.headers[i]), T('Результат')],
          r.items.map((it) => h('tr', { class: it.status === 'error' ? 'row-error' : null },
            h('td', { class: 'num' }, it.row),
            k.cols.map((c) => h('td', { class: c === 'debit' || c === 'credit' ? 'num' : null }, show(it, c))),
            h('td', null, badge(it.status), it.message ? h('div', { class: 'muted small' }, it.message) : null))))),
        r.total > r.items.length ? h('p', { class: 'muted small' }, TF('Показаны первые {0} строк из {1}.', r.items.length, r.total)) : null);
    }
  }

  // ======================= Импорт выписки =======================

  async function fileToBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(s);
  }

  const REASONS = {
    memory: ['accent', T('запомнено'), T('Этот счёт вы выбирали для этого контрагента раньше')],
    rule: ['', T('по назначению'), T('Подобран по тексту назначения платежа')],
    default: ['warn', T('по умолчанию'), T('Подходящего правила нет — проверьте счёт')],
  };

  async function viewImport(body) {
    await loadRefs();
    const err = errorBox();
    const bankDefault = S.accounts.find((a) => a.active && (a.code === '51' || a.code === '1010')) || S.accounts.find((a) => a.active && a.type === 'asset');
    const bankSel = accountSelect(bankDefault && bankDefault.id, { allowEmpty: false, onlyActive: true });
    const file = h('input', { type: 'file', accept: '.txt,.csv,.ofx,.qfx', class: 'file-input' });
    const readBtn = h('button', { class: 'btn primary', type: 'submit' }, T('Прочитать выписку'));
    const preview = h('div');
    const historyBox = h('div');
    const state = { b64: null, fileName: '', mapping: null, bankAccountNumber: null };

    async function parse() {
      const r = await api('POST', '/api/import/parse', {
        bankAccountId: bankSel.value,
        fileName: state.fileName,
        content: state.b64,
        mapping: state.mapping,
        bankAccountNumber: state.bankAccountNumber,
      });
      renderPreview(r);
    }

    body.append(
      h('form', {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          busy(readBtn, err, async () => {
            const f = file.files && file.files[0];
            if (!f) throw new Error(T('Выберите файл выписки'));
            if (f.size > 5 * 1024 * 1024) throw new Error(T('Файл больше 5 МБ — выгрузите выписку за более короткий период'));
            state.b64 = await fileToBase64(f);
            state.fileName = f.name;
            state.mapping = null;
            state.bankAccountNumber = null;
            await parse();
          });
        },
      },
        h('p', { class: 'muted', style: null }, T('Выгрузите выписку из интернет-банка и загрузите её сюда. Поддерживаются: 1С «Клиент-банк» (файл kl_to_1c.txt — есть почти у всех российских банков), CSV любого банка, OFX/QFX. Файл обрабатывается только на этом компьютере.')),
        err,
        h('div', { class: 'row' },
          field(T('Деньги на счёте учёта'), bankSel, T('обычно 51 «Расчётные счета»')),
          field(T('Файл выписки'), file),
          readBtn
        )
      ),
      preview,
      historyBox
    );

    function renderPreview(r) {
      const rows = r.rows.map((x) => ({ ...x }));
      const ctrls = new Map();
      const perr = errorBox();
      const counter = h('span', { class: 'muted' });
      const commitBtn = h('button', { class: 'btn primary', type: 'button' }, T('Провести'));

      function recount() {
        let n = 0;
        let inS = 0;
        let outS = 0;
        for (const x of rows) {
          if (!x.include) continue;
          n++;
          if (x.direction === 'in') inS += x.amount;
          else outS += x.amount;
        }
        commitBtn.textContent = n ? TF("Провести {0} {1}", n, plural(n, T('операцию'), T('операции'), T('операций'))) : T('Нечего проводить');
        commitBtn.disabled = !n;
        counter.textContent = n ? TF("поступления {0}, списания {1}", money(inS), money(outS)) : '';
      }

      // --- колонки CSV ---
      let mappingCard = null;
      if (r.csv) {
        const labels = { date: T('Дата'), amount: T('Сумма (со знаком)'), debit: T('Списание'), credit: T('Поступление'), description: T('Назначение'), counterparty: T('Контрагент'), inn: T('ИНН') };
        const sels = {};
        for (const [f, label] of Object.entries(labels)) {
          sels[f] = h('select', { value: r.csv.mapping[f] !== undefined ? String(r.csv.mapping[f]) : '' }, h('option', { value: '' }, '—'), r.csv.headers.map((hd, i) => h('option', { value: String(i) }, hd)));
        }
        const apply = h('button', { class: 'btn', type: 'button', onclick: () => busy(apply, null, async () => {
          state.mapping = Object.fromEntries(Object.entries(sels).map(([f, s]) => [f, s.value === '' ? null : Number(s.value)]));
          await parse();
        }) }, T('Применить колонки'));
        mappingCard = h('details', { class: 'card mapping', open: r.needsMapping ? true : null },
          h('summary', null, r.needsMapping ? T('Не удалось распознать колонки — укажите их') : TF("Колонки CSV распознаны автоматически (разделитель «{0}»)", r.csv.delimiter)),
          h('div', { class: 'mapping-grid' }, Object.entries(labels).map(([f, label]) => field(label, sels[f]))),
          h('p', { class: 'muted small' }, T('Укажите либо одну колонку «Сумма» со знаком (минус — списание), либо две колонки «Списание» и «Поступление».')),
          h('div', { class: 'actions' }, apply)
        );
        if (r.needsMapping) {
          fill(preview, mappingCard);
          return;
        }
      }

      // --- выбор расчётного счёта, если их в файле несколько ---
      let acctPicker = null;
      if (r.accountNumbers && r.accountNumbers.length > 1) {
        const sel = h('select', { value: r.bankAccountNumber }, r.accountNumbers.map((n) => h('option', { value: n }, n)));
        sel.addEventListener('change', () => {
          state.bankAccountNumber = sel.value;
          parse().catch((e) => toast(e.message, 'error'));
        });
        acctPicker = h('div', { class: 'card' }, field(T('В файле несколько расчётных счетов — какой загружаем?'), sel));
      }

      // --- сверка остатков ---
      const rec = r.reconciliation;
      const notes = [];
      if (rec.statementOpening !== null && rec.ledgerOpening !== null) {
        const diff = rec.statementOpening - rec.ledgerOpening;
        notes.push(diff === 0
          ? h('div', { class: 'alert ok' }, TF("Остаток на {0} по выписке совпадает с учётом: {1} {2}.", ruDate(rec.from), money(rec.ledgerOpening), cur()))
          : h('div', { class: 'alert warn' }, TF("Остаток на {0}: по выписке {1}, в учёте {2} — разница {3}. Возможно, загружены не все предыдущие выписки или есть ручные проводки по счёту.", ruDate(rec.from), money(rec.statementOpening), money(rec.ledgerOpening), money(diff))));
      }
      if (rec.statementClosing !== null && rec.ledgerOpening !== null) {
        const after = rec.ledgerOpening + rec.incoming - rec.outgoing;
        if (after !== rec.statementClosing) notes.push(h('div', { class: 'alert warn' }, TF("После проведения всех операций остаток в учёте будет {0}, а по выписке на конец периода — {1}.", money(after), money(rec.statementClosing))));
      }
      const dups = rows.filter((x) => x.duplicate).length;
      if (dups) notes.push(h('div', { class: 'alert info' }, TF("{0} {1} раньше — они отмечены и не будут проведены повторно.", dups, plural(dups, T('операция уже была загружена'), T('операции уже были загружены'), T('операций уже были загружены')))));
      if (r.skipped) notes.push(h('div', { class: 'alert info' }, TF("Пропущено строк без даты или суммы: {0} (обычно это итоги или служебные строки).", r.skipped)));

      // --- массовое назначение счёта ---
      const bulkAcc = accountSelect('', { onlyActive: true, placeholder: T('— счёт —') });
      const bulk = h('div', { class: 'bulk' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => setAll(true) }, T('Отметить все')),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => setAll(false) }, T('Снять все')),
        h('span', { class: 'muted small' }, T('Отмеченным назначить:')),
        bulkAcc,
        h('button', { class: 'btn small', type: 'button', onclick: () => {
          if (!bulkAcc.value) return toast(T('Выберите счёт'), 'error');
          for (const x of rows) if (x.include) {
            x.accountId = bulkAcc.value;
            ctrls.get(x.id).acc.value = bulkAcc.value;
            ctrls.get(x.id).badge.replaceChildren();
          }
        } }, T('Применить'))
      );
      function setAll(v) {
        for (const x of rows) {
          if (x.closed) continue;
          x.include = v;
          ctrls.get(x.id).chk.checked = v;
          ctrls.get(x.id).tr.classList.toggle('excluded', !v);
        }
        recount();
      }

      // --- таблица операций ---
      const cpName = (id) => (S.counterparties.find((c) => c.id === id) || {}).name;
      const trs = rows.map((x) => {
        const chk = h('input', { type: 'checkbox', 'aria-label': T('Провести'), disabled: x.closed || null });
        chk.checked = x.include;
        const acc = accountSelect(x.accountId || '', { onlyActive: true, placeholder: T('— выберите счёт —') });
        const badge = h('span');
        if (x.reason && REASONS[x.reason]) {
          const [cls, text, title] = REASONS[x.reason];
          badge.append(h('span', { class: 'badge ' + cls, title }, text));
        }
        const cpOpts = [h('option', { value: '' }, T('— без контрагента —'))];
        if (x.counterpartyId) cpOpts.push(h('option', { value: x.counterpartyId }, cpName(x.counterpartyId) || T('найден')));
        else if (x.name || x.inn) cpOpts.push(h('option', { value: 'new' }, TF("+ новый: {0}", (x.name || x.inn).slice(0, 40))));
        if (S.counterparties.length <= 300) {
          for (const c of S.counterparties) if (c.active && c.id !== x.counterpartyId) cpOpts.push(h('option', { value: c.id }, c.name));
        }
        const cp = h('select', { value: x.counterpartyId || (x.name || x.inn ? 'new' : '') }, cpOpts);
        x.counterparty = cp.value;
        const tr = h('tr', { class: x.include ? '' : 'excluded' },
          h('td', null, chk),
          h('td', { class: 'nowrap' }, ruDate(x.date), x.duplicate ? h('div', null, h('span', { class: 'badge' }, T('уже загружена'))) : null, x.closed ? h('div', null, h('span', { class: 'badge danger' }, T('закрытый период'))) : null),
          h('td', { class: 'num ' + (x.direction === 'in' ? 'amount-in' : 'amount-out') }, (x.direction === 'in' ? '+' : '−') + NBSP + money(x.amount)),
          h('td', null, h('div', null, x.name || h('span', { class: 'muted' }, '—')), x.inn ? h('div', { class: 'muted small' }, T('ИНН ') + x.inn) : null, cp),
          h('td', null, h('div', { class: 'purpose', title: x.purpose }, x.purpose || '—'), x.docNumber ? h('div', { class: 'muted small' }, NO + ' ' + x.docNumber) : null),
          h('td', null, acc, badge)
        );
        chk.addEventListener('change', () => {
          x.include = chk.checked;
          tr.classList.toggle('excluded', !chk.checked);
          recount();
        });
        acc.addEventListener('change', () => {
          x.accountId = acc.value;
          badge.replaceChildren();
          acc.removeAttribute('aria-invalid');
        });
        cp.addEventListener('change', () => { x.counterparty = cp.value; });
        ctrls.set(x.id, { chk, acc, badge, tr });
        return tr;
      });

      commitBtn.addEventListener('click', () => busy(commitBtn, perr, async () => {
        const missing = rows.filter((x) => x.include && !x.accountId);
        for (const x of missing) ctrls.get(x.id).acc.setAttribute('aria-invalid', 'true');
        if (missing.length) {
          ctrls.get(missing[0].id).acc.focus();
          throw new Error(TF("Не выбран корреспондирующий счёт у {0} {1}", missing.length, plural(missing.length, T('операции'), T('операций'), T('операций'))));
        }
        const res = await api('POST', '/api/import/commit', {
          token: r.token,
          rows: rows.map((x) => ({ id: x.id, include: x.include, accountId: x.accountId, counterparty: x.counterparty || null })),
        });
        await loadRefs();
        file.value = '';
        fill(preview, h('div', { class: 'card import-done' },
          h('h2', null, TF("Проведено {0} {1}", res.created, plural(res.created, T('операция'), T('операции'), T('операций')))),
          h('p', null, TF("Проводки №{0}–{1}. Поступления {2}, списания {3} {4}.", res.firstNumber, res.lastNumber, money(res.incoming), money(res.outgoing), cur()) +
            (res.counterpartiesCreated ? TF(" Создано контрагентов: {0}.", res.counterpartiesCreated) : '') +
            (res.skipped ? TF(" Пропущено: {0}.", res.skipped) : '')),
          h('p', { class: 'muted small' }, T('Выбранные счета запомнены — в следующий раз для этих контрагентов они подставятся сами.')),
          h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/journal' + qs({ from: rec.from || '', to: rec.to || '' }) }, T('Открыть в журнале')))
        ));
        toast(TF("Выписка проведена: {0} {1}", res.created, plural(res.created, T('операция'), T('операции'), T('операций'))));
        loadHistory();
      }));

      fill(preview,
        mappingCard,
        acctPicker,
        h('div', { class: 'kpis' },
          kpi(T('Операций в выписке'), rows.length, (v) => String(v)),
          kpi(T('Поступления'), rec.incoming),
          kpi(T('Списания'), rec.outgoing)
        ),
        notes,
        h('div', { class: 'card flush' },
          h('div', { class: 'card-toolbar' }, h('div', null, h('b', null, r.fileName), h('div', { class: 'muted small' }, `${r.formatTitle}${rec.from ? TF(", период {0} – {1}", ruDate(rec.from), ruDate(rec.to)) : ''}`)), bulk),
          table(['', T('Дата'), { t: TF("Сумма, {0}", cur()), cls: 'num' }, T('Контрагент'), T('Назначение платежа'), T('Корр. счёт')], trs, { empty: T('В выписке нет операций') })
        ),
        perr,
        h('div', { class: 'import-bar' }, commitBtn, counter)
      );
      recount();
    }

    async function loadHistory() {
      const list = await api('GET', '/api/import/history').catch(() => []);
      if (!list.length) return fill(historyBox);
      fill(historyBox, h('h3', null, T('Последние загрузки')), h('div', { class: 'card flush' }, table(
        [T('Когда'), T('Файл'), T('Счёт'), { t: T('Проведено'), cls: 'num' }, { t: T('Поступления'), cls: 'num' }, { t: T('Списания'), cls: 'num' }, T('Кто')],
        list.map((i) => h('tr', null,
          h('td', { class: 'nowrap' }, ruDateTime(i.at)), h('td', null, i.fileName), h('td', { class: 'code' }, i.bankCode),
          h('td', { class: 'num' }, i.created), h('td', { class: 'num' }, money(i.incoming || 0)), h('td', { class: 'num' }, money(i.outgoing || 0)), h('td', { class: 'muted' }, i.byName)
        ))
      )));
    }
    loadHistory();
  }

  function plural(n, one, few, many) {
    if (LANG === 'en') return Math.abs(n) === 1 ? one : many;
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // ======================= План счетов =======================

  async function viewAccounts(body) {
    await loadRefs();
    const list = h('div', { class: 'card flush' });
    function render() {
      fill(list, table([T('Код'), T('Наименование'), T('Тип'), T('Валюта'), T('Статус'), ''],
        S.accounts.map((a) => h('tr', null,
          h('td', { class: 'code' }, a.code),
          h('td', null, a.name),
          h('td', null, S.types[a.type]),
          h('td', { class: 'mono' }, a.currency || h('span', { class: 'muted' }, S.org.currency)),
          h('td', null, a.active ? h('span', { class: 'badge ok' }, T('открыт')) : h('span', { class: 'badge' }, T('закрыт'))),
          h('td', { class: 'nowrap' },
            h('a', { class: 'btn small ghost', href: '#/card' + qs({ account: a.id, from: yearStart(), to: today() }) }, T('Карточка')),
            can('write') ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => editAccount(a) }, T('Изменить')) : null
          )
        )),
        { empty: emptyMini('img/em/cards.webp', T('Счетов пока нет. Добавьте первый счёт в форме выше.')) }
      ));
    }
    function editAccount(a) {
      const err = errorBox();
      const name = h('input', { type: 'text', value: a.name, maxlength: 200 });
      const type = h('select', { value: a.type }, Object.entries(S.types).map(([k, v]) => h('option', { value: k }, v)));
      const active = h('input', { type: 'checkbox' });
      active.checked = a.active;
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
        await api('PATCH', '/api/accounts/' + encodeURIComponent(a.id), { name: name.value, type: type.value, active: active.checked });
        toast(T('Счёт обновлён'));
        dlg.close();
        await loadRefs();
        render();
      }) }, T('Сохранить'));
      const dlg = dialog(TF("Счёт {0}", a.code), [err, field(T('Наименование'), name), field(T('Тип'), type, T('нельзя менять, если по счёту есть проводки')), h('label', { class: 'check' }, active, h('span', null, T('Открыт для проводок')))], [save]);
    }
    if (can('write')) {
      const err = errorBox();
      const code = h('input', { type: 'text', maxlength: 20, placeholder: T('51 или 1010') });
      const accCur = h('select', null, h('option', { value: '' }, S.org.currency + T(' (учёта)')), ((S.catalog || {}).currencies || []).filter((c) => c !== S.org.currency).map((c) => h('option', { value: c }, c)),
        h('optgroup', { label: T('Криптовалюты (кошелёк)') }, Object.keys((S.catalog || {}).crypto || {}).map((c) => h('option', { value: c }, c))));
      const name = h('input', { type: 'text', maxlength: 200 });
      const type = h('select', null, Object.entries(S.types).map(([k, v]) => h('option', { value: k }, v)));
      const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Добавить счёт'));
      body.append(h('form', { class: 'card', onsubmit: (e) => {
        e.preventDefault();
        busy(btn, err, async () => {
          await api('POST', '/api/accounts', { code: code.value, name: name.value, type: type.value, currency: accCur.value || null });
          toast(T('Счёт добавлен'));
          code.value = name.value = '';
          await loadRefs();
          render();
        });
      } }, h('h2', null, T('Новый счёт')), err, h('div', { class: 'row' }, h('label', { class: 'field narrow' }, h('span', null, T('Код')), code), field(T('Наименование'), name), h('label', { class: 'field narrow' }, h('span', null, T('Тип')), type), h('label', { class: 'field narrow' }, h('span', null, T('Валюта')), accCur), btn)));
    }
    body.append(list);
    render();
  }

  // ======================= Контрагенты =======================

  async function viewCounterparties(body) {
    await loadRefs();
    const list = h('div', { class: 'card flush' });
    function render() {
      fill(list, table([T('Наименование'), T('ИНН / Tax ID'), T('Примечание'), T('Статус'), ''],
        S.counterparties.map((c) => h('tr', null,
          h('td', null, c.name), h('td', { class: 'mono' }, c.taxId), h('td', { class: 'muted' }, c.note),
          h('td', null, c.active ? h('span', { class: 'badge ok' }, T('активен')) : h('span', { class: 'badge' }, T('архив'))),
          h('td', { class: 'nowrap' },
            can('write') ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => edit(c) }, T('Изменить')) : null
          )
        )),
        { empty: emptyMini('img/em/partners.webp', T('Контрагентов пока нет. Добавьте их здесь или создайте прямо из банковской выписки.')) }
      ));
    }
    function formFields(c = {}) {
      return {
        name: h('input', { type: 'text', maxlength: 200, value: c.name || '' }),
        taxId: h('input', { type: 'text', maxlength: 20, value: c.taxId || '', class: 'mono' }),
        note: h('input', { type: 'text', maxlength: 500, value: c.note || '' }),
        kind: h('select', { value: c.kind || 'company' }, h('option', { value: 'company' }, T('Организация / ИП')), h('option', { value: 'person' }, T('Физлицо'))),
        kpp: h('input', { type: 'text', maxlength: 20, value: c.kpp || '', class: 'mono' }),
        address: h('input', { type: 'text', maxlength: 300, value: c.address || '' }),
      };
    }
    function edit(c) {
      const err = errorBox();
      const f = formFields(c);
      const active = h('input', { type: 'checkbox' });
      active.checked = c.active;
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
        await api('PATCH', '/api/counterparties/' + encodeURIComponent(c.id), { name: f.name.value, taxId: f.taxId.value, note: f.note.value, kind: f.kind.value, kpp: f.kpp.value, address: f.address.value, active: active.checked });
        dlg.close();
        toast(T('Сохранено'));
        await loadRefs();
        render();
      }) }, T('Сохранить'));
      const dlg = dialog(c.name, [err, field(T('Наименование'), f.name), field(T('ИНН / Tax ID'), f.taxId), field(T('КПП'), f.kpp), field(T('Адрес'), f.address, T('для счетов и актов')), field(T('Примечание'), f.note), field(T('Вид'), f.kind), h('label', { class: 'check' }, active, h('span', null, T('Активен')))], [save]);
    }
    if (can('write')) {
      const err = errorBox();
      const f = formFields();
      const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Добавить'));
      body.append(h('form', { class: 'card', onsubmit: (e) => {
        e.preventDefault();
        busy(btn, err, async () => {
          await api('POST', '/api/counterparties', { name: f.name.value, taxId: f.taxId.value, note: f.note.value, kind: f.kind.value });
          f.name.value = f.taxId.value = f.note.value = '';
          toast(T('Контрагент добавлен'));
          await loadRefs();
          render();
        });
      } }, h('h2', null, T('Новый контрагент')), err, h('div', { class: 'row' }, field(T('Наименование'), f.name), h('label', { class: 'field narrow' }, h('span', null, T('ИНН / Tax ID')), f.taxId), field(T('Примечание'), f.note), h('label', { class: 'field narrow' }, h('span', null, T('Вид')), f.kind), btn)));
    }
    body.append(list);
    render();
  }

  // ======================= Отчёты =======================

  function periodForm(params, onSubmit, extra = []) {
    const from = h('input', { type: 'date', value: params.get('from') || monthStart() });
    const to = h('input', { type: 'date', value: params.get('to') || today() });
    const quick = (label, f, t) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => { from.value = f; to.value = t; form.requestSubmit(); } }, label);
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3);
    const form = h('form', { class: 'card filters', onsubmit: (e) => { e.preventDefault(); onSubmit(from.value, to.value); } },
      extra, field(T('С'), from), field(T('По'), to),
      h('button', { class: 'btn primary', type: 'submit' }, T('Сформировать')),
      h('div', { class: 'actions', style: null },
        quick(T('Месяц'), monthStart(), today()),
        quick(T('Квартал'), isoLocal(new Date(now.getFullYear(), q * 3, 1)), today()),
        quick(T('Год'), yearStart(), today()),
        quick(T('Прошлый год'), `${now.getFullYear() - 1}-01-01`, `${now.getFullYear() - 1}-12-31`)
      )
    );
    return { form, from, to };
  }

  async function viewTrial(body, params) {
    const out = h('div');
    const exp = h('a', { class: 'btn', download: '' }, T('Экспорт CSV'));
    const { form } = periodForm(params, (f, t) => {
      history.replaceState(null, '', '#/trial' + qs({ from: f, to: t }));
      run(f, t);
    }, []);
    form.append(exp);
    body.append(form, out);
    async function run(from, to) {
      const r = await api('GET', '/api/reports/trial-balance' + qs({ from, to })).catch((e) => toast(e.message, 'error'));
      if (!r) return;
      exp.href = '/api/export/trial-balance.csv' + qs({ from, to, company: S.company });
      const m = moneyOrBlank;
      const group = h('thead', null, h('tr', { class: 'group' }, h('th', { colspan: 2 }), h('th', { colspan: 2 }, T('Сальдо на начало')), h('th', { colspan: 2 }, T('Обороты за период')), h('th', { colspan: 2 }, T('Сальдо на конец'))));
      const t = r.totals;
      fill(out, 
        r.balanced ? null : h('div', { class: 'alert error' }, T('Внимание: итоги не сходятся — проверьте целостность данных.')),
        h('div', { class: 'card flush' }, table(
          [T('Счёт'), T('Наименование'), { t: T('Дебет'), cls: 'num' }, { t: T('Кредит'), cls: 'num' }, { t: T('Дебет'), cls: 'num' }, { t: T('Кредит'), cls: 'num' }, { t: T('Дебет'), cls: 'num' }, { t: T('Кредит'), cls: 'num' }],
          r.rows.map((x) => h('tr', { class: 'clickable', onclick: () => go('card', { account: x.accountId, from: r.from || '', to: r.to || '' }) },
            h('td', { class: 'code' }, x.code), h('td', null, x.name),
            h('td', { class: 'num' }, m(x.openDt)), h('td', { class: 'num' }, m(x.openCt)),
            h('td', { class: 'num' }, m(x.turnDt)), h('td', { class: 'num' }, m(x.turnCt)),
            h('td', { class: 'num' }, m(x.closeDt)), h('td', { class: 'num' }, m(x.closeCt))
          )),
          {
            groupHead: group,
            empty: T('За период нет движений'),
            foot: h('tr', null, h('td', { colspan: 2 }, T('Итого')), [t.openDt, t.openCt, t.turnDt, t.turnCt, t.closeDt, t.closeCt].map((v) => h('td', { class: 'num' }, money(v)))),
          }
        ))
      );
    }
    run(params.get('from') || monthStart(), params.get('to') || today());
  }

  async function viewCard(body, params) {
    const out = h('div');
    const acc = accountSelect(params.get('account'), { allowEmpty: true, placeholder: T('— выберите счёт —') });
    const { form } = periodForm(params, (f, t) => {
      history.replaceState(null, '', '#/card' + qs({ account: acc.value, from: f, to: t }));
      run(acc.value, f, t);
    }, [h('label', { class: 'field grow' }, h('span', null, T('Счёт')), acc)]);
    body.append(form, out);
    async function run(account, from, to) {
      if (!account) return fill(out, h('div', { class: 'card empty' }, T('Выберите счёт')));
      const r = await api('GET', '/api/reports/account-card' + qs({ account, from, to })).catch((e) => toast(e.message, 'error'));
      if (!r) return;
      const bal = (v) => (v === 0 ? money(0) : `${money(Math.abs(v))} ${v > 0 ? T('Д') : T('К')}`);
      fill(out, 
        h('div', { class: 'kpis' },
          kpi(T('Сальдо на начало'), bal(r.opening)), kpi(T('Оборот Дт'), r.turnDt), kpi(T('Оборот Кт'), r.turnCt), kpi(T('Сальдо на конец'), bal(r.closing))
        ),
        h('div', { class: 'card flush' }, table(
          [T('Дата'), { t: NO, cls: 'num' }, T('Содержание'), T('Корр. счёт'), T('Контрагент'), { t: T('Дебет'), cls: 'num' }, { t: T('Кредит'), cls: 'num' }, { t: T('Сальдо'), cls: 'num' }],
          r.moves.map((mv) => h('tr', { class: 'clickable', onclick: () => openEntry(mv.entryId) },
            h('td', { class: 'nowrap' }, ruDate(mv.date)), h('td', { class: 'num' }, mv.number), h('td', null, mv.description, mv.memo ? h('div', { class: 'muted small' }, mv.memo) : null),
            h('td', { class: 'code' }, mv.corr), h('td', null, mv.counterparty, mv.fx ? h('div', { class: 'muted small mono' }, `${fmtUnits(mv.fx.amount, decimalsOf(mv.fx.currency))} ${mv.fx.currency} × ${(mv.fx.rate / 1e6).toFixed(4)}`) : null),
            h('td', { class: 'num' }, moneyOrBlank(mv.debit)), h('td', { class: 'num' }, moneyOrBlank(mv.credit)), h('td', { class: 'num' }, bal(mv.balance))
          )),
          { empty: T('Нет движений за период') }
        ))
      );
    }
    run(acc.value, params.get('from') || monthStart(), params.get('to') || today());
  }

  /** Итоговая плитка. Числа «досчитываются» при формировании отчёта — видно, что итог пересчитан. */
  function kpi(label, value, fmt = money) {
    const out = h('div', { class: 'value' }, typeof value === 'number' ? fmt(value) : value);
    if (typeof value === 'number' && value !== 0 && !reducedMotion()) {
      const t0 = performance.now();
      const dur = 650;
      out.textContent = fmt(0);
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const eased = 1 - (1 - k) ** 3;
        out.textContent = fmt(k < 1 ? Math.round(value * eased) : value);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    const animated = typeof value === 'number' && value !== 0 && !reducedMotion();
    return h('div', { class: 'kpi' + (animated ? ' shine' : '') }, h('div', { class: 'label' }, label), out);
  }

  function emptyMini(img, text) {
    return h('div', { class: 'empty-mini' }, h('img', { src: img, alt: '', width: 84, height: 84 }), h('span', null, text));
  }

  // Волна от точки нажатия на кнопках — отклик на действие, не фоновая анимация.
  document.addEventListener('pointerdown', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('.btn, .chip') : null;
    if (!btn || btn.disabled || reducedMotion()) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = size + 'px';
    s.style.left = ev.clientX - r.left - size / 2 + 'px';
    s.style.top = ev.clientY - r.top - size / 2 + 'px';
    btn.append(s);
    setTimeout(() => s.remove(), 650);
  }, { passive: true });

  function emptyState(img, title, text, action) {
    return h('div', { class: 'empty-state' },
      h('img', { src: img, alt: '', width: 220, height: 220, loading: 'lazy', decoding: 'async' }),
      h('div', null, h('h2', null, title), h('p', null, text), action || null)
    );
  }

  function amountTable(title, rows, total) {
    return h('div', { class: 'card flush report-section' }, table(
      [T('Счёт'), title, { t: TF("Сумма, {0}", cur()), cls: 'num' }],
      rows.map((r) => h('tr', null, h('td', { class: 'code' }, r.code), h('td', null, r.name), h('td', { class: 'num' }, money(r.amount)))),
      { empty: T('Нет данных'), foot: h('tr', null, h('td', { colspan: 2 }, T('Итого')), h('td', { class: 'num' }, money(total))) }
    ));
  }

  async function viewBalance(body, params) {
    const date = h('input', { type: 'date', value: params.get('date') || today() });
    const out = h('div');
    body.append(h('form', { class: 'card filters', onsubmit: (e) => { e.preventDefault(); history.replaceState(null, '', '#/balance' + qs({ date: date.value })); run(); } },
      field(T('На дату'), date), h('button', { class: 'btn primary', type: 'submit' }, T('Сформировать'))), out);
    async function run() {
      const r = await api('GET', '/api/reports/balance' + qs({ date: date.value })).catch((e) => toast(e.message, 'error'));
      if (!r) return;
      const t = r.totals;
      fill(out, 
        h('div', { class: 'kpis' }, kpi(T('Активы'), t.assets), kpi(T('Обязательства'), t.liabilities), kpi(T('Капитал'), t.equity), kpi(T('Финансовый результат (не закрыт)'), t.profit)),
        r.balanced ? h('div', { class: 'alert ok' }, TF("Баланс сходится: Активы = Обязательства + Капитал + Результат = {0} {1}", money(t.assets), cur())) : h('div', { class: 'alert error' }, T('Баланс не сходится — проверьте данные')),
        h('h3', null, T('Активы')), amountTable(T('Наименование'), r.groups.asset, t.assets),
        h('h3', null, T('Обязательства')), amountTable(T('Наименование'), r.groups.liability, t.liabilities),
        h('h3', null, T('Капитал')), amountTable(T('Наименование'), r.groups.equity, t.equity),
        h('p', { class: 'muted small' }, T('Упрощённый управленческий баланс: суммы — сальдо счетов по их типу. Регулирующие счета (например, амортизация) уменьшают итог своей группы.'))
      );
    }
    run();
  }

  async function viewPnl(body, params) {
    const out = h('div');
    const { form } = periodForm(params, (f, t) => { history.replaceState(null, '', '#/pnl' + qs({ from: f, to: t })); run(f, t); });
    body.append(form, out);
    async function run(from, to) {
      const r = await api('GET', '/api/reports/pnl' + qs({ from, to })).catch((e) => toast(e.message, 'error'));
      if (!r) return;
      const t = r.totals;
      fill(out, 
        h('div', { class: 'kpis' }, kpi(T('Доходы'), t.income), kpi(T('Расходы'), t.expense), kpi(t.net >= 0 ? T('Прибыль') : T('Убыток'), Math.abs(t.net))),
        h('h3', null, T('Доходы')), amountTable(T('Наименование'), r.income, t.income),
        h('h3', null, T('Расходы')), amountTable(T('Наименование'), r.expense, t.expense)
      );
    }
    run(params.get('from') || yearStart(), params.get('to') || today());
  }

  // ======================= Пользователи =======================

  /** Запросы двойного контроля: действия одного администратора, которые подтверждает другой. */
  async function requestsCard() {
    const items = await api('GET', '/api/requests');
    if (!items.length) return null;
    return h('div', { class: 'card approvals' },
      h('h2', null, T('Запросы администраторов '), h('span', { class: 'badge warn' }, items.length)),
      h('p', { class: 'muted' }, T('Включён двойной контроль: критичные действия выполняются после подтверждения вторым администратором. Запрос действует 24 часа.')),
      h('div', { class: 'list' }, items.map((r) => h('div', { class: 'li' },
        h('span', null, h('b', null, r.summary), h('div', { class: 'muted small' }, T('Запросил '), r.byName, ' · ', ruDateTime(r.at))),
        h('span', { class: 'nowrap' }, r.by === S.user.id
          ? h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => busy(e.target, null, async () => { await api('POST', `/api/requests/${r.id}/reject`, {}); toast(T('Запрос отозван')); route(); }) }, T('Отозвать'))
          : [h('button', { class: 'btn small primary', type: 'button', onclick: (e) => busy(e.target, null, async () => {
            if (!(await confirmDialog(T('Подтвердить действие?'), r.summary + T('. Ваше имя попадёт в журнал аудита как подтвердившего.'), T('Подтвердить')))) return;
            await api('POST', `/api/requests/${r.id}/approve`, {});
            S.requests = Math.max(0, (S.requests || 0) - 1);
            toast(T('Выполнено'));
            route();
          }) }, T('Подтвердить')), ' ', h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => busy(e.target, null, async () => {
            if (!(await confirmDialog(T('Отклонить запрос?'), r.summary, T('Отклонить'), true))) return;
            await api('POST', `/api/requests/${r.id}/reject`, {});
            S.requests = Math.max(0, (S.requests || 0) - 1);
            toast(T('Запрос отклонён'));
            route();
          }) }, T('Отклонить'))])))));
  }

  async function viewUsers(body) {
    const rq = await requestsCard().catch(() => null);
    if (rq) body.append(rq);
    const list = h('div', { class: 'card flush' });
    const roleOptions = (v) => h('select', { value: v }, Object.entries(S.roles).map(([k, t2]) => h('option', { value: k }, t2)));
    const companyName = (id) => (S.companies.find((c) => c.id === id) || {}).name || T('архив');
    /** Редактор доступа: все компании или выбранные, со своей ролью в каждой. */
    function accessEditor(access, roleSel) {
      const mode = h('select', { value: access ? 'some' : 'all' }, h('option', { value: 'all' }, T('Ко всем компаниям (роль выше)')), h('option', { value: 'some' }, T('К выбранным компаниям')));
      const rows = S.companies.map((c) => {
        const r = h('select', { value: (access && access[c.id]) || '' }, h('option', { value: '' }, T('— нет доступа —')), h('option', { value: 'accountant' }, T('Бухгалтер')), h('option', { value: 'auditor' }, T('Аудитор')), h('option', { value: 'viewer' }, T('Наблюдатель')));
        return { id: c.id, el: h('label', { class: 'access-row' }, h('span', null, c.name), r), r };
      });
      const list = h('div', { class: 'access-list' }, rows.map((x) => x.el));
      const sync = () => {
        const isAdmin = roleSel.value === 'admin';
        wrap.hidden = isAdmin;
        list.hidden = mode.value !== 'some';
      };
      const wrap = h('div', { class: 'access' }, field(T('Доступ'), mode), list);
      mode.addEventListener('change', sync);
      roleSel.addEventListener('change', sync);
      sync();
      return {
        el: wrap,
        value() {
          if (roleSel.value === 'admin' || mode.value === 'all') return null;
          const out = {};
          for (const x of rows) if (x.r.value) out[x.id] = x.r.value;
          return out;
        },
      };
    }
    async function render() {
      const users = await api('GET', '/api/users');
      fill(list, table([T('Логин'), T('Имя'), T('Роль'), T('Компании'), T('Статус'), T('Сессий'), ''],
        users.map((u) => {
          const me = u.id === S.user.id;
          return h('tr', null,
            h('td', { class: 'mono' }, u.username, me ? h('span', { class: 'muted' }, T(' (вы)')) : null),
            h('td', null, u.displayName),
            h('td', null, S.roles[u.role]),
            h('td', { class: 'small' }, u.role === 'admin' || !u.access ? h('span', { class: 'muted' }, T('все')) : Object.entries(u.access).map(([id, r]) => h('div', null, companyName(id), ' — ', (S.roles[r] || r).toLowerCase()))),
            h('td', null,
              u.active ? h('span', { class: 'badge ok' }, T('активен')) : h('span', { class: 'badge danger' }, T('заблокирован')), ' ',
              u.active && !u.hasPassword ? h('span', { class: 'badge warn' }, T('нет пароля')) : null,
              u.mustChangePassword ? h('span', { class: 'badge' }, T('временный пароль')) : null, ' ',
              u.twoFactor || u.passkeys ? h('span', { class: 'badge accent', title: [u.twoFactor ? T('код из приложения') : null, u.passkeys ? 'Windows Hello' : null].filter(Boolean).join(T(' и ')) }, '2FA') : h('span', { class: 'badge', title: T('Вход только по паролю') }, T('без 2FA'))
            ),
            h('td', { class: 'num' }, u.sessions),
            h('td', { class: 'nowrap' }, me ? null : [
              h('button', { class: 'btn small ghost', type: 'button', onclick: () => editUser(u) }, T('Изменить')),
              u.active ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => resetPassword(u) }, T('Сбросить пароль')) : null,
              u.twoFactor || u.passkeys ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => reset2fa(u) }, T('Сбросить 2FA')) : null,
            ])
          );
        })
      ));
    }
    function editUser(u) {
      const err = errorBox();
      const name = h('input', { type: 'text', value: u.displayName, maxlength: 100 });
      const role = roleOptions(u.role);
      const acc = accessEditor(u.access, role);
      const active = h('input', { type: 'checkbox' });
      active.checked = u.active;
      const denyBoxes = Object.entries(S.caps || {}).map(([k, label]) => {
        const box = h('input', { type: 'checkbox', value: k });
        box.checked = (u.deny || []).includes(k);
        return { k, box, el: h('label', { class: 'check' }, box, h('span', null, label)) };
      });
      const denyWrap = h('fieldset', { class: 'deny-set' }, h('legend', null, T('Запретить сверх роли')), denyBoxes.map((d) => d.el),
        h('p', { class: 'muted small' }, T('Ограничения действуют для всех компаний пользователя. Администратора ограничить нельзя.')));
      const syncDeny = () => { denyWrap.hidden = role.value === 'admin'; };
      role.addEventListener('change', syncDeny);
      syncDeny();
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
        if (!active.checked && u.active && !(await confirmDialog(T('Заблокировать пользователя?'), T('Его сессии будут завершены, а его ключ доступа удалён. Чтобы вернуть доступ, нужно будет разблокировать его и задать новый пароль.'), T('Заблокировать'), true))) return;
        const r = await api('PATCH', '/api/users/' + encodeURIComponent(u.id), { displayName: name.value, role: role.value, active: active.checked, access: acc.value(), ...(role.value === 'admin' ? {} : { deny: denyBoxes.filter((d) => d.box.checked).map((d) => d.k) }) });
        dlg.close();
        toast(r && r.pending ? r.message : T('Сохранено'));
        render();
      }) }, T('Сохранить'));
      const dlg = dialog(TF("Пользователь {0}", u.username), [err, field(T('Имя'), name), field(T('Роль'), role), acc.el, denyWrap, h('label', { class: 'check' }, active, h('span', null, T('Активен')))], [save]);
    }
    async function reset2fa(u) {
      const text = T('Используйте, если пользователь потерял телефон. Его сессии будут завершены, войти можно будет только по паролю') +
        (S.settings.require2fa ? T(', после чего он будет обязан подключить 2FA заново.') : T('. Подключить 2FA заново он сможет в профиле.'));
      if (!(await confirmDialog(TF("Сбросить 2FA пользователя {0}?", u.username), text, T('Сбросить 2FA'), true))) return;
      try {
        const r = await api('POST', `/api/users/${encodeURIComponent(u.id)}/2fa/reset`);
        toast(r && r.pending ? r.message : T('2FA сброшена'));
        render();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    function resetPassword(u) {
      const err = errorBox();
      const pw = h('input', { type: 'text', class: 'mono', value: genPassword(), autocomplete: 'off', spellcheck: 'false' });
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
        const r = await api('POST', `/api/users/${encodeURIComponent(u.id)}/password`, { password: pw.value });
        dlg.close();
        toast(r && r.pending ? r.message + T('. Запишите пароль сейчас: после подтверждения он начнёт действовать.') : T('Временный пароль установлен. Передайте его пользователю лично.'));
        render();
      }) }, T('Установить'));
      const dlg = dialog(TF("Новый пароль: {0}", u.username), [err, h('p', { class: 'muted' }, T('Пользователь будет обязан сменить его при первом входе. Все его текущие сессии будут завершены.')), field(T('Временный пароль'), pw)], [save]);
    }
    const err = errorBox();
    const f = {
      username: h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' }),
      displayName: h('input', { type: 'text', maxlength: 100 }),
      role: roleOptions('accountant'),
      password: h('input', { type: 'text', class: 'mono', value: genPassword(), autocomplete: 'off', spellcheck: 'false' }),
    };
    const fAcc = accessEditor(null, f.role);
    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Создать'));
    body.append(
      h('form', { class: 'card', onsubmit: (e) => {
        e.preventDefault();
        busy(btn, err, async () => {
          const r = await api('POST', '/api/users', { username: f.username.value, displayName: f.displayName.value, role: f.role.value, password: f.password.value, access: fAcc.value() });
          toast(r && r.pending ? r.message : T("Пользователь создан. Передайте временный пароль лично — при первом входе его потребуется сменить."));
          f.username.value = f.displayName.value = '';
          f.password.value = genPassword();
          render();
        });
      } },
        h('h2', null, T('Новый пользователь')), err,
        h('div', { class: 'row' }, field(T('Логин'), f.username), field(T('Имя'), f.displayName), h('label', { class: 'field narrow' }, h('span', null, T('Роль')), f.role)),
        fAcc.el,
        h('div', { class: 'row' }, field(T('Временный пароль'), f.password), h('button', { class: 'btn', type: 'button', onclick: () => { f.password.value = genPassword(); } }, T('Сгенерировать')), btn),
        h('p', { class: 'muted small' },
          T('Роли: Администратор — всё, включая пользователей и настройки; Бухгалтер — проводки, счета, контрагенты; Аудитор — просмотр и журнал аудита; Наблюдатель — только просмотр учёта и отчётов.'))
      ),
      list
    );
    await render();
  }

  // ======================= Главная =======================

  /** Краткая сумма для осей и подсказок: 1,2 млн / 350 тыс. */
  function moneyShort(k) {
    const v = Math.abs(k) / 100;
    const sign = k < 0 ? '−' : '';
    if (v >= 1e9) return sign + (v / 1e9).toFixed(1).replace('.', DEC) + T(' млрд');
    if (v >= 1e6) return sign + (v / 1e6).toFixed(1).replace('.', DEC) + T(' млн');
    if (v >= 1e3) return sign + Math.round(v / 1e3) + T(' тыс.');
    return sign + Math.round(v);
  }

  const MONTH_SHORT = [T('янв'), T('фев'), T('мар'), T('апр'), T('май'), T('июн'), T('июл'), T('авг'), T('сен'), T('окт'), T('ноя'), T('дек')];
  const SERIES = [
    { key: 'income', label: T('Доходы'), color: '#e23b63' },
    { key: 'expense', label: T('Расходы'), color: '#4f8fd6' },
  ];

  /** Столбцы «доходы / расходы» по месяцам: SVG без библиотек, подсказка при наведении, таблица данных. */
  function monthsChart(months, currency) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 720;
    const H = 240;
    const padL = 56;
    const padB = 26;
    const padT = 10;
    const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
    const step = 10 ** Math.floor(Math.log10(max));
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const groupW = (W - padL) / months.length;
    const barW = Math.min(18, (groupW - 10) / 2);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', T('Доходы и расходы по месяцам'));
    const el = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text !== undefined) n.textContent = text;
      svg.append(n);
      return n;
    };
    for (let i = 0; i <= 4; i++) {
      const v = (top / 4) * i;
      el('line', { x1: padL, x2: W, y1: y(v), y2: y(v), class: i ? 'grid' : 'axis' });
      el('text', { x: padL - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, moneyShort(v));
    }
    const tip = h('div', { class: 'chart-tip', hidden: true });
    const bar = (x, v, color) => {
      // Столбец со скруглёнными верхними углами (4px), опирается на ось.
      const y0 = y(0);
      const y1 = Math.min(y(v), y0 - (v > 0 ? 2 : 0));
      const r = Math.min(4, barW / 2, (y0 - y1) / 2);
      return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + barW - r} Q${x + barW},${y1} ${x + barW},${y1 + r} V${y0} Z`;
    };
    months.forEach((m, i) => {
      const gx = padL + i * groupW + (groupW - barW * 2 - 2) / 2;
      SERIES.forEach((s, j) => {
        if (!m[s.key]) return;
        el('path', { d: bar(gx + j * (barW + 2), m[s.key], s.color), fill: s.color, class: 'bar' });
      });
      const mm = Number(m.month.slice(5, 7));
      el('text', { x: padL + i * groupW + groupW / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, MONTH_SHORT[mm - 1]);
      // Зона наведения шире столбцов.
      const hit = el('rect', { x: padL + i * groupW, y: padT, width: groupW, height: H - padT - padB, class: 'hit', tabindex: 0 });
      const show = () => {
        fill(tip, h('b', null, `${MONTH_SHORT[mm - 1]} ${m.month.slice(0, 4)}`),
          SERIES.map((s) => h('div', { class: 'tip-row' }, h('i', { class: 'sw', 'data-c': s.key }), s.label, h('span', { class: 'num' }, money(m[s.key]) + ' ' + currency))));
        tip.hidden = false;
        const box = svg.getBoundingClientRect();
        const rx = ((padL + i * groupW + groupW / 2) / W) * box.width;
        tip.style.left = Math.min(Math.max(rx, 90), box.width - 90) + 'px';
      };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      hit.addEventListener('blur', () => { tip.hidden = true; });
    });
    const legend = h('div', { class: 'legend' }, SERIES.map((s) => h('span', null, h('i', { class: 'sw', 'data-c': s.key }), s.label)));
    const data = h('details', { class: 'chart-data' }, h('summary', null, T('Данные графика')),
      table([T('Месяц'), { t: T('Доходы'), cls: 'num' }, { t: T('Расходы'), cls: 'num' }],
        months.map((m) => h('tr', null, h('td', null, `${MONTH_SHORT[Number(m.month.slice(5, 7)) - 1]} ${m.month.slice(0, 4)}`), h('td', { class: 'num' }, money(m.income)), h('td', { class: 'num' }, money(m.expense))))));
    return h('div', { class: 'chart-wrap' }, legend, h('div', { class: 'chart-box' }, svg, tip), data);
  }

  /** Применить настройки сети: сервер переоткроет порт, браузер перейдёт на новый адрес. */
  async function applyNetworkNow(btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/network/apply', {});
      toast(TF('Переходим на {0} …', r.url));
      setTimeout(() => { location.href = r.url; }, 1800);
    } catch (e) {
      if (btn) btn.disabled = false;
      toast(e.message, 'error');
    }
  }

  function connectFileLink(label) {
    return h('a', { class: 'btn', href: '/api/network/connect.cmd', download: 'Odem-connect.cmd' }, label || T('Файл для компьютеров сотрудников'));
  }

  function networkPendingCard() {
    if (!S.networkPending || S.role !== 'admin') return null;
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => applyNetworkNow(e.currentTarget) }, T('Включить доступ из сети'));
    return h('div', { class: 'card' },
      h('h2', null, T('Сервер для офиса готов')),
      h('p', null, T('Сертификаты созданы, вход по сети — только из вашей локальной сети, по паролю и коду 2FA. Осталось два шага:')),
      h('ol', { class: 'steps' },
        h('li', null, T('Скачайте файл «Odem-connect.cmd» и запустите его на этом компьютере и на компьютерах сотрудников (флешкой или через общую папку). Он добавит доверие к серверу и ярлык «Одем» на рабочий стол.')),
        h('li', null, T('Нажмите «Включить доступ из сети». Приложение перейдёт на защищённый адрес HTTPS; войдите снова.'))),
      h('div', { class: 'actions' }, connectFileLink(), btn));
  }

  async function viewHome(body) {
    body.append(networkPendingCard());
    if (denied('reports')) {
      body.append(h('div', { class: 'card' }, emptyState('img/ledger.webp', T('Сводка скрыта'),
        T('Администратор закрыл для вас отчёты и сводку по деньгам. Журнал проводок и остальные разделы доступны в меню.'), null)));
      return;
    }
    const d = await api('GET', '/api/dashboard');
    const cur = d.currency;
    if (!d.entries) {
      body.append(h('div', { class: 'card' }, emptyState('img/ledger.webp', T('Здесь появится сводка по компании'),
        T('Как только появятся проводки, на главной будут деньги на счетах, доходы и расходы по месяцам, долги покупателей и поставщиков и ближайшие налоги.'),
        can('write') ? h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/entry-new' }, T('Создать проводку')), h('a', { class: 'btn', href: '#/import' }, T('Загрузить выписку'))) : null)));
      return;
    }
    const net = d.ytd.net;
    body.append(
      h('div', { class: 'kpis' },
        kpi(T('Деньги на счетах, ') + cur, d.moneyTotal),
        kpi(T('Доходы с начала года'), d.ytd.income),
        kpi(T('Расходы с начала года'), d.ytd.expense),
        kpi(net >= 0 ? T('Прибыль с начала года') : T('Убыток с начала года'), Math.abs(net))),
      h('div', { class: 'card' }, h('h2', null, T('Доходы и расходы по месяцам, ') + cur), monthsChart(d.months, cur)),
      h('div', { class: 'home-grid' },
        h('div', { class: 'card' }, h('h2', null, T('Деньги')),
          d.money.length ? h('div', { class: 'list' }, d.money.map((a) => h('div', { class: 'li' },
            h('span', null, h('span', { class: 'code' }, a.code), ' ', a.name),
            h('span', { class: 'num' }, money(a.balance), a.fx !== null ? h('div', { class: 'muted small' }, fmtUnits(a.fx, decimalsOf(a.currency)) + ' ' + a.currency) : null))))
            : h('p', { class: 'muted' }, T('Остатков на денежных счетах нет.'))),
        h('div', { class: 'card' }, h('h2', null, T('Ближайшие налоги')),
          d.taxMode ? null : h('p', { class: 'muted' }, T('Налоговый режим компании не выбран.')),
          d.taxes.length ? h('div', { class: 'list' }, d.taxes.map((x) => h('div', { class: 'li' }, h('span', null, x.title ? `${x.title}: ${x.period} ${x.year}` : x.label, h('div', { class: 'muted small' }, T('до ') + ruDate(x.deadline))), h('span', { class: 'num' }, money(x.amount)))))
            : d.taxMode ? h('p', { class: 'muted' }, T('Платежей к уплате не найдено.')) : null,
          h('a', { class: 'btn small ghost', href: '#/taxes' }, T('Открыть расчёт'))),
        h('div', { class: 'card' }, h('h2', null, T('Расчёты')),
          h('div', { class: 'list' },
            h('div', { class: 'li' }, h('span', null, T('Нам должны покупатели')), h('span', { class: 'num' }, money(d.receivable))),
            h('div', { class: 'li' }, h('span', null, T('Мы должны поставщикам')), h('span', { class: 'num' }, money(d.payable)))),
          d.topCounterparties.length ? [h('h3', null, T('Крупнейшие контрагенты года')), h('div', { class: 'list' }, d.topCounterparties.map((c) => h('div', { class: 'li' }, h('span', null, c.name), h('span', { class: 'num muted' }, moneyShort(c.turnover)))))] : null),
        h('div', { class: 'card' }, h('h2', null, T('Последние проводки')),
          h('div', { class: 'list' }, d.recent.map((e) => h('button', { class: 'li li-btn', type: 'button', onclick: () => openEntry(e.id) },
            h('span', null, h('span', { class: 'muted small' }, `${NO}${e.number}, ${ruDate(e.date)}`), h('div', null, e.description)),
            h('span', { class: 'num' }, money(e.total))))),
          h('a', { class: 'btn small ghost', href: '#/journal' }, T('Весь журнал')))
      )
    );
  }

  // ======================= Налоги =======================

  /** Скачать файл, который сервер отдаёт на POST-запрос (с теми же заголовками, что и api()). */
  async function downloadPost(url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (S.csrf) headers['X-CSRF-Token'] = S.csrf;
    if (S.company) headers['X-Company'] = S.company;
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && trServer(data.error)) || TF('Ошибка {0}', res.status));
    }
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd) || /filename="([^"]+)"/.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : 'file';
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = h('a', { href: blobUrl, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    return name;
  }

  /** Декларация по УСН (КНД 1152017, XML формата 5.09): что не хранится в учёте, вводится здесь. */
  async function usnDeclarationDialog(year) {
    const d = await api('GET', '/api/tax/usn-xml/defaults' + qs({ year }));
    const err = errorBox();
    const inp = (v, attrs = {}) => h('input', { type: 'text', value: v == null ? '' : String(v), ...attrs });
    const f = {
      taxOffice: inp('', { maxlength: 4, inputmode: 'numeric', placeholder: '7701' }),
      oktmo: inp('', { maxlength: 11, inputmode: 'numeric', placeholder: '45000000' }),
      phone: inp('', { maxlength: 20 }),
      correction: inp('0', { maxlength: 3, inputmode: 'numeric' }),
      period: h('select', null, [['34', T('Календарный год')], ['50', T('Последний период при реорганизации, ликвидации или закрытии ИП')], ['95', T('Последний период при переходе на другой режим')], ['96', T('Последний период при прекращении деятельности на УСН')]].map(([v, l]) => h('option', { value: v }, v + ' — ' + l))),
      signer: h('select', null, h('option', { value: '1' }, d.ip ? T('Сам ИП') : T('Руководитель')), h('option', { value: '2' }, T('Представитель'))),
      lastName: inp(''), firstName: inp(''), middleName: inp(''),
      repDoc: inp('', { maxlength: 120 }),
      tpLastName: inp(''), tpFirstName: inp(''), tpMiddleName: inp(''),
      employer: h('input', { type: 'checkbox' }),
      fixed: inp(d.fixed, { inputmode: 'numeric' }), onePct: inp(d.onePct, { inputmode: 'numeric' }),
      paidCur: inp('0', { inputmode: 'numeric' }), paidPrev: inp('0', { inputmode: 'numeric' }),
    };
    f.employer.checked = d.hasEmployees;
    const signerBox = h('div', null, h('h3', null, T('Подписант')), h('div', { class: 'row' }, field(T('Фамилия'), f.lastName), field(T('Имя'), f.firstName), field(T('Отчество'), f.middleName)), field(T('Документ о полномочиях представителя'), f.repDoc));
    const syncSigner = () => {
      signerBox.hidden = d.ip && f.signer.value === '1';
      f.repDoc.closest('label').hidden = f.signer.value !== '2';
    };
    f.signer.addEventListener('change', syncSigner);
    const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
      const form = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      const name = await downloadPost('/api/tax/usn-xml', { year, form });
      dlg.close();
      toast(TF('Файл {0} сохранён. Проверьте его в программе ФНС перед отправкой.', name));
    }) }, T('Сформировать XML'));
    const dlg = dialog(TF('Декларация по УСН за {0} год', year), [
      h('p', { class: 'muted' }, T('Формат 5.09 (приказ ФНС от 26.11.2025 № ЕД-7-3/1017@). Доходы, расходы и налог берутся из расчёта на этой странице; ниже — то, чего в учёте нет. Перед отправкой проверьте файл в бесплатной программе ФНС «Налогоплательщик ЮЛ» или у оператора ЭДО.')),
      err,
      h('div', { class: 'row' }, field(T('Код налогового органа'), f.taxOffice), field(T('ОКТМО'), f.oktmo), field(T('Телефон'), f.phone)),
      h('div', { class: 'row' }, field(T('Номер корректировки'), f.correction, T('0 — первичная')), field(T('Период'), f.period)),
      d.ip ? [h('h3', null, T('Индивидуальный предприниматель')), h('div', { class: 'row' }, field(T('Фамилия'), f.tpLastName), field(T('Имя'), f.tpFirstName), field(T('Отчество'), f.tpMiddleName))] : null,
      field(T('Кто подписывает'), f.signer),
      signerBox,
      h('label', { class: 'check' }, f.employer, h('span', null, T('Есть выплаты физлицам (работники) — уменьшение налога на взносы не больше 50%'))),
      d.ip ? [h('h3', null, T('Взносы ИП за себя (строки 150–162 / 290–320)')),
        h('div', { class: 'row' }, field(T('Фиксированные взносы за год'), f.fixed), field(T('1% с дохода свыше 300 000 ₽'), f.onePct)),
        h('div', { class: 'row' }, field(T('Из них 1% уплачено в этом году за этот год'), f.paidCur), field(T('1% за прошлый год, уплаченный в этом'), f.paidPrev))] : null,
    ], [save]);
    syncSigner();
  }

  async function viewTaxes(body, params) {
    const thisYear = new Date().getFullYear();
    const yearSel = h('select', { value: params.get('year') || String(thisYear) }, [thisYear + 1, thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y2) => h('option', { value: String(y2) }, String(y2))));
    const out = h('div');
    const kud = h('a', { class: 'btn', download: '' }, T('КУДиР (CSV)'));
    const kudForm = h('a', { class: 'btn', target: '_blank', rel: 'noopener' }, T('КУДиР по форме (печать / PDF)'));
    const declBtn = h('button', { class: 'btn', type: 'button', onclick: () => usnDeclarationDialog(Number(yearSel.value)) }, T('Декларация УСН (XML для ФНС)'));
    body.append(h('div', { class: 'card filters' }, field(T('Год'), yearSel), kud, kudForm, declBtn), out);
    yearSel.addEventListener('change', () => load());

    async function load() {
      const y2 = Number(yearSel.value);
      history.replaceState(null, '', '#/taxes' + qs({ year: y2 }));
      kud.href = '/api/export/kudir.csv' + qs({ year: y2, company: S.company });
      kudForm.href = '/api/reports/kudir/print' + qs({ year: y2, company: S.company });
      kudForm.hidden = !(S.org && S.org.country === 'RU' && ['ru_usn6', 'ru_usn15'].includes(S.org.taxMode));
      declBtn.hidden = kudForm.hidden || y2 < 2025;
      const r = await api('GET', '/api/tax' + qs({ year: y2 }));
      if (!r.mode) {
        fill(out, h('div', { class: 'card' }, emptyMini('img/em/seal.webp', r.notes[0]), S.user.role === 'admin' ? h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/companies' }, T('Выбрать режим'))) : null));
        return;
      }
      const cashLike = r.mode.base === 'cash';
      const showExp = r.mode.kind !== 'income' && r.mode.kind !== 'npd';
      const total = r.mode.periods === 'month' ? r.periods.reduce((s2, p2) => s2 + p2.tax, 0) : r.periods[r.periods.length - 1].tax;
      const due = r.periods.reduce((s2, p2) => s2 + p2.due, 0);
      fill(out,
        h('div', { class: 'kpis' }, kpi(T('Режим'), r.mode.title), kpi(T('Налог за год (начислено)'), total), kpi(T('К уплате по периодам, всего'), due)),
        h('div', { class: 'card flush' }, table(
          [T('Период'), { t: cashLike ? T('Поступления') : T('Доходы'), cls: 'num' }, showExp ? { t: cashLike ? T('Выплаты') : T('Расходы'), cls: 'num' } : null, { t: T('База'), cls: 'num' }, { t: T('Вычет'), cls: 'num' }, { t: r.mode.periods === 'month' ? T('Налог') : T('Налог нарастающим итогом'), cls: 'num' }, { t: T('К уплате'), cls: 'num' }, T('Срок')].filter(Boolean),
          r.periods.map((p2) => h('tr', null,
            h('td', { class: 'nowrap' }, p2.label),
            h('td', { class: 'num' }, money(p2.income)),
            showExp ? h('td', { class: 'num' }, money(p2.expense)) : null,
            h('td', { class: 'num' }, money(p2.base)),
            h('td', { class: 'num' }, p2.deduction ? money(p2.deduction) : ''),
            h('td', { class: 'num' }, money(p2.tax)),
            h('td', { class: 'num' }, h('b', null, money(p2.due))),
            h('td', { class: 'nowrap' }, p2.deadline ? ruDate(p2.deadline) : '—'))))),
        r.vat ? [h('h3', null, T('НДС по кварталам')), h('div', { class: 'card flush' }, table([T('Квартал'), { t: T('Начислен с реализации'), cls: 'num' }, { t: T('К вычету'), cls: 'num' }, { t: T('К уплате'), cls: 'num' }],
          r.vat.map((v) => h('tr', null, h('td', null, v.label), h('td', { class: 'num' }, money(v.output)), h('td', { class: 'num' }, money(v.input)), h('td', { class: 'num' }, h('b', null, money(v.payable)))))))] : null,
        h('div', { class: 'card notes' }, h('h3', null, T('Как считается')), h('ul', null, r.notes.map((n) => h('li', null, n))),
          S.user.role === 'admin' ? taxSettingsForm(r) : null)
      );
    }

    function taxSettingsForm(r) {
      const err = errorBox();
      const rate = h('input', { type: 'number', step: '0.1', min: 0, max: 100, value: r.params.rate ?? '' });
      const vat = h('input', { type: 'number', step: '0.1', min: 0, max: 100, value: r.params.vatRate ?? '' });
      const emp = h('input', { type: 'checkbox' });
      emp.checked = !!r.params.hasEmployees;
      const save = h('button', { class: 'btn', type: 'button', onclick: () => busy(save, err, async () => {
        const ts = { hasEmployees: emp.checked };
        if (rate.value !== '') ts.rate = Number(rate.value);
        if (vat.value !== '') ts.vatRate = Number(vat.value);
        await api('PATCH', '/api/companies/' + encodeURIComponent(S.company), { taxSettings: ts });
        toast(T('Налоговые настройки сохранены'));
        load();
      }) }, T('Сохранить ставки'));
      return h('div', null, h('h3', null, T('Ставки компании')), err,
        h('div', { class: 'row' },
          r.params.rate !== null && r.params.rate !== undefined ? h('label', { class: 'field narrow' }, h('span', null, T('Ставка налога, %')), rate) : null,
          r.params.vatRate ? h('label', { class: 'field narrow' }, h('span', null, T('НДС, %')), vat) : null,
          h('label', { class: 'check' }, emp, h('span', null, T('Есть сотрудники'))), save));
    }

    await load();
  }

  // ======================= Курсы валют =======================

  async function viewRates(body) {
    const cat = S.catalog || {};
    const base = S.org.currency;
    const list = h('div');
    const curSel = h('select', null, (cat.currencies || []).filter((c) => c !== base).map((c) => h('option', { value: c }, c)),
      h('optgroup', { label: T('Криптовалюты') }, Object.keys(cat.crypto || {}).map((c) => h('option', { value: c }, c))));
    const rDate = h('input', { type: 'date', value: today() });
    const rVal = h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: '92' + DEC + '5' });
    const err = errorBox();
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, T('Сохранить курс'));
    if (can('write')) {
      body.append(h('form', { class: 'card', onsubmit: (e) => {
        e.preventDefault();
        busy(addBtn, err, async () => {
          await api('POST', '/api/rates', { date: rDate.value, currency: curSel.value, base, rate: rVal.value });
          rVal.value = '';
          toast(T('Курс сохранён'));
          load();
        });
      } }, h('h2', null, T('Курс вручную')), err,
        h('div', { class: 'row' }, h('label', { class: 'field narrow' }, h('span', null, T('Дата')), rDate), h('label', { class: 'field narrow' }, h('span', null, T('Валюта')), curSel),
          h('label', { class: 'field narrow' }, h('span', null, TF("1 ед. = ? {0}", base)), rVal), addBtn)));
    }
    const fx = h('div', { class: 'card' }, h('h2', null, T('Официальные курсы и переоценка')));
    const auto = S.settings.rates && S.settings.rates.autoFetch;
    if (S.user.role === 'admin') {
      const fetchBtn = h('button', { class: 'btn', type: 'button', disabled: auto ? null : true, onclick: () => busy(fetchBtn, null, async () => {
        const r = await api('POST', '/api/rates/fetch', { date: rDate.value });
        toast(TF("Загружено курсов: {0}", r.loaded) + (r.errors.length ? T(' (часть источников недоступна)') : ''), r.errors.length ? 'error' : '');
        load();
      }) }, T('Загрузить курсы ЦБ РФ и ЕЦБ'));
      fx.append(h('div', { class: 'actions' }, fetchBtn, auto ? h('span', { class: 'muted small' }, T('на дату из поля выше')) : h('span', { class: 'muted small' }, T('Включите загрузку в «Настройках»: приложение по умолчанию не выходит в интернет.'))));
    }
    if (can('write')) {
      const rvDate = h('input', { type: 'date', value: today() });
      const rvErr = errorBox();
      const rvBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(rvBtn, rvErr, async () => {
        const r = await api('POST', '/api/fx/revalue', { date: rvDate.value });
        toast(TF("Переоценка: проводка №{0}. Положительная разница {1}, отрицательная {2}", r.number, money(r.gain), money(r.loss)));
      }) }, T('Переоценить валютные счета'));
      fx.append(h('h3', null, T('Переоценка')), rvErr, h('p', { class: 'muted small' }, T('Остатки валютных счетов пересчитываются по курсу на дату, разница проводится на счета курсовых разниц.')),
        h('div', { class: 'row' }, h('label', { class: 'field narrow' }, h('span', null, T('На дату')), rvDate), rvBtn));
    }
    body.append(fx, list);

    async function load() {
      const items = await api('GET', '/api/rates');
      if (!items.length) return fill(list, h('div', { class: 'card' }, emptyMini('img/em/statement.webp', T('Курсов пока нет. Добавьте курс вручную или включите загрузку официальных курсов.'))));
      fill(list, h('div', { class: 'card flush' }, table([T('Дата'), T('Курс'), T('Источник'), ''],
        items.map((r) => h('tr', null,
          h('td', { class: 'nowrap' }, ruDate(r.date)),
          h('td', { class: 'mono' }, `1 ${r.currency} = ${(r.rate / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '').replace('.', DEC)} ${r.base}`),
          h('td', { class: 'muted' }, r.source),
          h('td', null, can('write') && r.source === T('вручную') ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            try {
              await api('POST', '/api/rates/delete', { date: r.date, currency: r.currency, base: r.base });
              load();
            } catch (e) { toast(e.message, 'error'); }
          } }, T('Удалить')) : null))))));
    }
    await load();
  }

  // ======================= Компании =======================

  async function viewCompanies(body, params, head) {
    const list = h('div');
    const cat = S.catalog || {};
    head.append(h('div', { class: 'head-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => editCompany(null) }, T('+ Добавить компанию'))));
    body.append(list);
    const countryName = (code) => ((cat.countries || []).find((c) => c.id === code) || {}).title || '—';
    const modeName = (id) => ((cat.taxModes || []).find((m) => m.id === id) || {}).title || '—';

    async function load() {
      const items = await api('GET', '/api/companies');
      fill(list, h('div', { class: 'card flush' }, table([T('Компания'), T('Страна'), T('Валюта'), T('Налоговый режим'), { t: T('Проводок'), cls: 'num' }, T('Статус'), ''],
        items.map((c) => h('tr', null,
          h('td', null, h('b', null, c.name), c.taxId ? h('div', { class: 'muted small' }, c.taxId) : null),
          h('td', null, countryName(c.country)),
          h('td', { class: 'mono' }, c.currency),
          h('td', null, modeName(c.taxMode)),
          h('td', { class: 'num' }, c.entries),
          h('td', null, c.active ? h('span', { class: 'badge ok' }, T('активна')) : h('span', { class: 'badge' }, T('архив'))),
          h('td', { class: 'nowrap' },
            c.active && c.id !== S.company ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => switchCompany(c.id) }, T('Открыть')) : null,
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => editCompany(c) }, T('Изменить')))
        )))));
    }

    function editCompany(c) {
      const err = errorBox();
      const name = h('input', { type: 'text', maxlength: 200, value: c ? c.name : '' });
      const taxId = h('input', { type: 'text', maxlength: 20, value: c ? c.taxId || '' : '', class: 'mono' });
      // У компаний из старых версий страны нет — предлагаем её по валюте учёта.
      const guessCountry = (cur) => ({ RUB: 'RU', USD: 'US', KZT: 'KZ', BYN: 'BY', EUR: 'EU' })[cur] || 'EU';
      const country = h('select', { value: c ? c.country || guessCountry(c.currency) : 'RU' }, (cat.countries || []).map((x) => h('option', { value: x.id }, x.title)));
      const entity = h('select');
      const mode = h('select');
      const currency = h('select', { disabled: c ? true : null }, (cat.currencies || ['RUB', 'USD', 'EUR']).map((x) => h('option', { value: x }, x)));
      const template = h('select', { disabled: c ? true : null }, (cat.templates || []).map((x) => h('option', { value: x.id }, x.title)));
      const closed = h('input', { type: 'date', value: c ? c.closedUntil || '' : '' });
      const active = h('input', { type: 'checkbox' });
      active.checked = c ? c.active : true;
      const rq = (c && c.requisites) || {};
      const rqF = {};
      for (const [k, label, max] of [['legalName', T('Полное наименование'), 300], ['kpp', T('КПП'), 20], ['ogrn', T('ОГРН / ОГРНИП'), 20], ['address', T('Юридический адрес'), 300], ['bankName', T('Банк'), 200], ['bik', T('БИК / SWIFT'), 20], ['account', T('Расчётный счёт / IBAN'), 40], ['corrAccount', T('Корр. счёт'), 40], ['director', T('Руководитель (Фамилия И. О.)'), 120], ['chiefAccountant', T('Главный бухгалтер'), 120], ['email', 'E-mail', 120], ['phone', T('Телефон'), 40]]) {
        rqF[k] = { label, el: h('input', { type: 'text', maxlength: max, value: rq[k] || '' }) };
      }
      const rqBox = h('details', { class: 'req-box' }, h('summary', null, T('Реквизиты для счетов и актов')),
        h('div', { class: 'req-grid' }, Object.values(rqF).map((x) => field(x.label, x.el))));
      const apOn = h('input', { type: 'checkbox' });
      apOn.checked = !!(c && c.approval && c.approval.enabled);
      const apSum = h('input', { type: 'text', inputmode: 'decimal', class: 'amount', placeholder: money(10000000), value: c && c.approval && c.approval.threshold ? (c.approval.threshold / 100).toFixed(2).replace('.', DEC) : '' });
      const fillEntity = () => {
        const ctry = (cat.countries || []).find((x) => x.id === country.value) || {};
        fill(entity, (ctry.entities || []).map((x) => h('option', { value: x.id }, x.title)));
        if (c && c.entityType) entity.value = c.entityType;
        if (!entity.value && entity.options.length) entity.selectedIndex = 0;
        fillModes();
        if (!c) {
          if (ctry.currency) currency.value = ctry.currency;
          if (ctry.template) template.value = ctry.template;
        }
      };
      const fillModes = () => {
        fill(mode, h('option', { value: '' }, T('— не выбран —')), (cat.taxModes || []).filter((m) => m.country === country.value && (!m.entities || m.entities.includes(entity.value))).map((m) => h('option', { value: m.id }, m.title)));
        if (c && c.taxMode) mode.value = c.taxMode;
        if (!mode.value) mode.selectedIndex = 0;
      };
      country.addEventListener('change', fillEntity);
      entity.addEventListener('change', fillModes);
      fillEntity();
      if (c) currency.value = c.currency;
      if (c) template.value = c.template;
      const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
        if (c) {
          await api('PATCH', '/api/companies/' + encodeURIComponent(c.id), { name: name.value, taxId: taxId.value, country: country.value, entityType: entity.value || null, taxMode: mode.value || null, closedUntil: closed.value || null, active: active.checked, approval: { enabled: apOn.checked, threshold: parseMoney(apSum.value) || 0 }, requisites: Object.fromEntries(Object.entries(rqF).map(([k, x]) => [k, x.el.value])) });
        } else {
          await api('POST', '/api/companies', { name: name.value, taxId: taxId.value, country: country.value, entityType: entity.value, taxMode: mode.value || null, currency: currency.value, template: template.value });
        }
        dlg.close();
        toast(c ? T('Компания сохранена') : T('Компания добавлена'));
        applySession(await api('GET', '/api/session'));
        route();
      }) }, c ? T('Сохранить') : T('Добавить'));
      const dlg = dialog(c ? c.name : T('Новая компания'), [
        err,
        h('div', { class: 'row' }, field(T('Название'), name), field(T('ИНН / налоговый номер'), taxId)),
        h('div', { class: 'row' }, field(T('Страна'), country), field(T('Форма'), entity), field(T('Налоговый режим'), mode)),
        h('div', { class: 'row' }, field(T('Валюта учёта'), currency, c ? T('не меняется') : null), field(T('План счетов'), template, c ? T('не меняется') : null)),
        c ? h('div', { class: 'row' }, field(T('Период закрыт по'), closed), h('label', { class: 'check' }, active, h('span', null, T('Активна (снимите, чтобы убрать в архив)')))) : null,
        c ? rqBox : null,
        c ? h('div', { class: 'row' },
          h('label', { class: 'check' }, apOn, h('span', null, h('b', null, T('Четыре глаза')), h('div', { class: 'muted small' }, T('Проводки и сторно от этой суммы попадают в учёт только после подтверждения другим бухгалтером или администратором.')))),
          field(T('Порог, ') + (c.currency || ''), apSum)) : null,
      ], [save]);
      dlg.classList.add('wide');
      name.focus();
    }

    await load();
  }

  // ======================= Журнал аудита =======================

  const ACTIONS = {
    'system.setup': T('Первичная настройка'),
    'auth.login': T('Вход'),
    'auth.logout': T('Выход'),
    'auth.login_failed': T('Неудачная попытка входа'),
    'auth.session_expired': T('Сессия завершена по тайм-ауту'),
    'auth.password_changed': T('Смена пароля'),
    'auth.password_change_failed': T('Неудачная смена пароля'),
    'auth.recovered': T('Восстановление доступа по ключу'),
    'auth.recovery_failed': T('Неудачная попытка восстановления'),
    'auth.recovery_key_regenerated': T('Перевыпуск ключа восстановления'),
    'user.create': T('Создание пользователя'),
    'user.update': T('Изменение пользователя'),
    'user.password_reset': T('Сброс пароля пользователя'),
    'user.2fa_reset': T('Сброс 2FA пользователя'),
    'auth.2fa_failed': T('Неверный код 2FA'),
    'auth.2fa_enabled': T('Включение 2FA'),
    'auth.2fa_disabled': T('Отключение 2FA'),
    'security.rollback': T('Откат данных к старой версии'),
    'security.audit_mismatch': T('Журнал не совпадает с отпечатком'),
    'security.anchor_invalid': T('Якорь подделан или повреждён'),
    'security.anchor_missing': T('Якорь не найден'),
    'security.anchor_other_vault': T('Хранилище заменено другим'),
    'security.alert_ack': T('Подтверждение предупреждения'),
    'auth.elevated': T('Подтверждение паролем'),
    'auth.session_revoked': T('Принудительное завершение сессии'),
    'security.machine_bound': T('Привязка хранилища к компьютеру'),
    'security.machine_unbound': T('Снятие привязки к компьютеру'),
    'entry.approved': T('Подтверждение проводки (четыре глаза)'),
    'data.export': T('Выгрузка данных в файл'),
    'document.create': T('Создание документа'),
    'document.update': T('Изменение документа'),
    'report.reconciliation': T('Печать акта сверки'),
    'recurring.create': T('Создание регулярной операции'),
    'recurring.update': T('Изменение регулярной операции'),
    'recurring.delete': T('Удаление регулярной операции'),
    'recurring.posted': T('Проведение регулярной операции'),
    'recurring.failed': T('Ошибка регулярной операции'),
    'license.installed': T('Установка лицензии'),
    'security.syslog': T('Настройка пересылки журнала'),
    'security.syslog_test': T('Тест пересылки журнала'),
    'network.ca_created': T('Создан удостоверяющий центр'),
    'network.server_cert': T('Выпущен сертификат сервера'),
    'network.update': T('Изменение настроек сети'),
    'network.denied': T('Отказ в доступе из сети'),
    'device.issued': T('Выпущен сертификат устройства'),
    'device.revoked': T('Отозван сертификат устройства'),
    'device.admin': T('Изменены права устройства'),
    'auth.session_device_mismatch': T('Сессия использована с другого устройства'),
    'entry.rejected': T('Отклонение проводки (четыре глаза)'),
    'deletion.requested': T('Запрос на удаление (четыре глаза)'),
    'deletion.approved': T('Подтверждено удаление (четыре глаза)'),
    'deletion.rejected': T('Отклонено удаление (четыре глаза)'),
    'audit.signer_created': T('Создан ключ подписи журнала'),
    'network.applied': T('Применены настройки сети'),
    'system.updated': T('Обновление программы (копия перед обновлением)'),
    'import.table': T('Загрузка из Excel'),
    'sync.enabled': T('Синхронизация включена'),
    'sync.disabled': T('Синхронизация выключена'),
    'sync.pulled': T('Получена версия из папки синхронизации'),
    'sync.joined': T('Компьютер подключён из папки синхронизации'),
    'security.sync_conflict': T('Синхронизация остановлена: конфликт версий'),
    'admin.request_created': T('Запрос второму администратору'),
    'admin.request_approved': T('Подтверждение запроса администратора'),
    'admin.request_rejected': T('Отклонение запроса администратора'),
    'auth.passkey_added': T('Привязка Windows Hello'),
    'auth.passkey_removed': T('Отвязка Windows Hello'),
    'auth.passkey_failed': T('Неудачный вход Windows Hello'),
    'settings.update': T('Изменение настроек'),
    'account.create': T('Создание счёта'),
    'account.update': T('Изменение счёта'),
    'counterparty.create': T('Создание контрагента'),
    'counterparty.update': T('Изменение контрагента'),
    'entry.create': T('Проводка'),
    'entry.reverse': T('Сторно проводки'),
    'backup.create': T('Создание резервной копии'),
    'backup.verify': T('Проверка резервных копий'),
    'backup.download': T('Скачивание резервной копии'),
    'import.commit': T('Импорт банковской выписки'),
    'company.create': T('Добавлена компания'),
    'rate.set': T('Курс валюты'),
    'rate.delete': T('Удалён курс'),
    'rate.fetch': T('Загрузка курсов ЦБ/ЕЦБ'),
    'fx.revalue': T('Переоценка валюты'),
    'backup.export': T('Архив скопирован в папку'),
    'company.update': T('Изменена компания'),
    'attachment.upload': T('Прикреплён документ'),
    'attachment.view': T('Открыт документ'),
    'attachment.delete': T('Удалён документ'),
    'template.create': T('Создание шаблона'),
    'template.update': T('Изменение шаблона'),
    'template.delete': T('Удаление шаблона'),
    'template.seed': T('Добавление стандартных шаблонов'),
  };
  const SECURITY = new Set(['auth.login_failed', 'auth.password_change_failed', 'auth.recovery_failed', 'auth.recovered', 'auth.recovery_key_regenerated', 'user.password_reset', 'user.2fa_reset', 'auth.2fa_failed', 'auth.2fa_disabled', 'auth.passkey_failed', 'auth.passkey_removed', 'security.rollback', 'security.audit_mismatch', 'security.anchor_invalid', 'security.anchor_missing', 'security.anchor_other_vault', 'network.denied', 'device.revoked', 'auth.session_device_mismatch', 'attachment.delete']);

  function detailsText(a) {
    const d = a.details || {};
    if (a.action === 'entry.create') return TF("№{0} от {1}, {2}", d.number, ruDate(d.date), money(d.amount));
    if (a.action === 'entry.reverse') return TF("№{0} сторнирует №{1}", d.number, d.reverses);
    const s = JSON.stringify(d);
    return s === '{}' ? '' : s;
  }

  // ======================= Документы =======================

  const DOC_TYPES = { invoice: T('Счёт'), act: T('Акт') };
  const DOC_STATUS = { draft: ['', T('черновик')], issued: ['accent', T('выставлен')], paid: ['ok', T('оплачен')], cancelled: ['danger', T('отменён')] };

  async function viewDocuments(body, params, head) {
    if (can('write')) {
      head.append(
        h('button', { class: 'btn primary', type: 'button', onclick: () => editDocument({ type: 'invoice' }) }, T('+ Счёт')), ' ',
        h('button', { class: 'btn', type: 'button', onclick: () => editDocument({ type: 'act' }) }, T('+ Акт')));
    }
    const list = await api('GET', '/api/documents');
    if (!list.length) {
      body.append(h('div', { class: 'card empty' }, h('p', null, T('Документов пока нет. Создайте счёт на оплату или акт — печатная форма откроется в новой вкладке, её можно распечатать или сохранить в PDF.'))));
      return;
    }
    body.append(h('div', { class: 'card flush' }, table([T('Документ'), T('Контрагент'), { t: T('Сумма'), cls: 'num' }, T('Статус'), ''], list.map((d) => h('tr', null,
      h('td', null, h('b', null, DOC_TYPES[d.type], ' ' + NO + ' ', d.number), h('div', { class: 'muted small' }, ruDate(d.date))),
      h('td', null, d.counterpartyName),
      h('td', { class: 'num' }, money(d.total), d.vat ? h('div', { class: 'muted small' }, T('НДС '), money(d.vat)) : null),
      h('td', null, h('span', { class: 'badge ' + DOC_STATUS[d.status][0] }, DOC_STATUS[d.status][1])),
      h('td', { class: 'nowrap' },
        h('a', { class: 'btn small', href: '/api/documents/' + encodeURIComponent(d.id) + '/print' + qs({ company: S.company }), target: '_blank', rel: 'noopener' }, T('Печать / PDF')), ' ',
        can('write') ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => editDocument(d) }, T('Изменить')) : null,
        can('write') && d.type === 'invoice' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => editDocument({ ...d, id: undefined, number: undefined, type: 'act', date: today(), status: 'issued', basis: TF("Счёт № {0} от {1}", d.number, ruDate(d.date)) }) }, T('Акт по счёту')) : null)
    )))));
  }

  function editDocument(d) {
    const isNew = !d.id;
    const err = errorBox();
    const date = h('input', { type: 'date', value: d.date || today() });
    const due = h('input', { type: 'date', value: d.dueDate || '' });
    const cp = cpSelect(d.counterpartyId);
    const vatMode = h('select', { value: d.vatMode || 'none' }, h('option', { value: 'none' }, T('Без НДС')), h('option', { value: 'included' }, T('НДС в том числе')), h('option', { value: 'excluded' }, T('НДС сверху')));
    const basis = h('input', { type: 'text', maxlength: 300, value: d.basis || '', placeholder: T('Например: договор № 12 от 01.03.2026') });
    const note = h('input', { type: 'text', maxlength: 1000, value: d.note || '' });
    const status = h('select', { value: d.status || 'issued' }, Object.entries(DOC_STATUS).map(([k, v]) => h('option', { value: k }, v[1])));
    const rowsBox = h('tbody');
    const totalEl = h('div', { class: 'doc-total' });
    const rows = [];
    const qtyText = (q) => (q % 1000 ? (q / 1000).toFixed(3).replace(/0+$/, '').replace('.', DEC) : String(q / 1000));
    const recalc = () => {
      let sum = 0;
      let vat = 0;
      for (const r of rows) {
        const q = Number(String(r.qty.value).replace(',', '.')) || 0;
        const pr = parseMoney(r.price.value) || 0;
        const amt = Math.round(q * pr);
        r.sum.textContent = money(amt);
        const rate = Number(r.vat.value) || 0;
        if (vatMode.value !== 'none' && rate) vat += vatMode.value === 'included' ? Math.round((amt * rate) / (100 + rate)) : Math.round((amt * rate) / 100);
        sum += amt;
      }
      for (const r of rows) r.vat.disabled = vatMode.value === 'none';
      const total = vatMode.value === 'excluded' ? sum + vat : sum;
      fill(totalEl, T('Итого: '), h('b', null, money(total)), vat ? h('span', { class: 'muted' }, T(' · НДС ') + money(vat)) : null);
    };
    const addRow = (it = {}) => {
      const r = {
        name: h('input', { type: 'text', maxlength: 300, value: it.name || '', placeholder: T('Услуга или товар') }),
        qty: h('input', { type: 'text', inputmode: 'decimal', class: 'amount', value: it.qty ? qtyText(it.qty) : '1' }),
        unit: h('input', { type: 'text', maxlength: 12, value: it.unit || T('шт'), list: 'doc-units' }),
        price: h('input', { type: 'text', inputmode: 'decimal', class: 'amount', value: it.price ? (it.price / 100).toFixed(2).replace('.', DEC) : '' }),
        vat: h('select', { value: it.vatRate === null || it.vatRate === undefined ? '20' : String(it.vatRate) }, [0, 5, 7, 10, 12, 16, 20, 22].map((v) => h('option', { value: String(v) }, v + '%'))),
        sum: h('span', { class: 'num' }),
      };
      r.tr = h('tr', null, h('td', null, r.name), h('td', null, r.qty), h('td', null, r.unit), h('td', null, r.price), h('td', null, r.vat), h('td', { class: 'num' }, r.sum),
        h('td', null, h('button', { class: 'btn small ghost', type: 'button', 'aria-label': T('Удалить строку'), onclick: () => { rows.splice(rows.indexOf(r), 1); r.tr.remove(); recalc(); } }, '✕')));
      for (const k of ['qty', 'price']) r[k].addEventListener('input', recalc);
      r.vat.addEventListener('change', recalc);
      rows.push(r);
      rowsBox.append(r.tr);
      recalc();
    };
    (d.items && d.items.length ? d.items : [{}]).forEach(addRow);
    vatMode.addEventListener('change', recalc);
    const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
      const payload = { type: d.type, date: date.value, dueDate: due.value || null, counterpartyId: cp.value, vatMode: vatMode.value, basis: basis.value, note: note.value, status: status.value,
        items: rows.map((r) => ({ name: r.name.value, qty: r.qty.value, unit: r.unit.value, price: parseMoney(r.price.value), vatRate: vatMode.value === 'none' ? null : Number(r.vat.value) })) };
      const res = isNew ? await api('POST', '/api/documents', payload) : await api('PATCH', '/api/documents/' + encodeURIComponent(d.id), payload);
      dlg.close();
      toast(TF("{0} № {1} сохранён", DOC_TYPES[res.type], res.number));
      route();
    }) }, T('Сохранить'));
    const dlg = dialog((isNew ? T('Новый ') : '') + (d.type === 'act' ? T('акт') : T('счёт')) + (isNew ? '' : ' ' + NO + ' ' + d.number), h('div', { class: 'doc-editor' },
      err,
      h('div', { class: 'row' }, field(T('Дата'), date), d.type === 'invoice' ? field(T('Оплатить до'), due) : null, field(T('Покупатель / заказчик'), cp), field(T('НДС'), vatMode)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'doc-items' },
        h('thead', null, h('tr', null, [T('Наименование'), T('Кол-во'), T('Ед.'), T('Цена'), T('НДС'), T('Сумма'), ''].map((x) => h('th', null, x)))), rowsBox)),
      h('datalist', { id: 'doc-units' }, [T('шт'), T('усл.'), T('ч'), T('мес.'), T('кг'), T('л'), T('м'), T('м²'), T('компл.')].map((u) => h('option', { value: u }))),
      h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => addRow() }, T('+ Строка')), totalEl),
      h('div', { class: 'row' }, field(T('Основание'), basis), field(T('Статус'), status)),
      field(T('Примечание'), note)), [save]);
    dlg.classList.add('wide');
  }

  // ======================= Акт сверки =======================

  async function viewRecon(body, params) {
    const cp = cpSelect(params.get('counterparty'));
    const from = h('input', { type: 'date', value: params.get('from') || today().slice(0, 4) + '-01-01' });
    const to = h('input', { type: 'date', value: params.get('to') || today() });
    const out = h('div');
    const show = h('button', { class: 'btn primary', type: 'submit' }, T('Сформировать'));
    body.append(h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      go('recon', { counterparty: cp.value, from: from.value, to: to.value });
    } }, h('div', { class: 'row' }, field(T('Контрагент'), cp), field(T('С'), from), field(T('По'), to)), h('div', { class: 'actions' }, show)), out);
    if (!params.get('counterparty')) return;
    const r = await api('GET', '/api/reports/reconciliation' + qs({ counterparty: params.get('counterparty'), from: from.value, to: to.value }));
    const side = (v) => (v > 0 ? [money(v), ''] : v < 0 ? ['', money(-v)] : ['', '']);
    const [od, oc] = side(r.opening);
    const [cd, cc] = side(r.closing);
    fill(out, h('div', { class: 'card flush' },
      h('div', { class: 'dlg-foot' },
        h('span', null, r.closing === 0 ? T('Задолженности нет') : r.closing > 0 ? TF("{0} должен нам {1} {2}", r.counterparty.name, money(r.closing), r.currency) : TF("Мы должны {0} {1} {2}", r.counterparty.name, money(-r.closing), r.currency)),
        h('a', { class: 'btn', href: '/api/reports/reconciliation/print' + qs({ counterparty: r.counterparty.id, from: r.from, to: r.to, company: S.company }), target: '_blank', rel: 'noopener' }, T('Печать / PDF'))),
      table([T('Дата'), T('Документ'), { t: T('Дебет'), cls: 'num' }, { t: T('Кредит'), cls: 'num' }], [
        h('tr', { class: 'group' }, h('td', null, ruDate(r.from)), h('td', null, T('Сальдо на начало')), h('td', { class: 'num' }, od), h('td', { class: 'num' }, oc)),
        ...r.rows.map((x) => h('tr', null, h('td', { class: 'nowrap' }, ruDate(x.date)), h('td', null, x.document), h('td', { class: 'num' }, x.debit ? money(x.debit) : ''), h('td', { class: 'num' }, x.credit ? money(x.credit) : ''))),
        h('tr', { class: 'group' }, h('td', null), h('td', null, T('Обороты')), h('td', { class: 'num' }, money(r.turnDebit)), h('td', { class: 'num' }, money(r.turnCredit))),
        h('tr', { class: 'group' }, h('td', null, ruDate(r.to)), h('td', null, T('Сальдо на конец')), h('td', { class: 'num' }, cd), h('td', { class: 'num' }, cc)),
      ])));
  }

  // ======================= Регулярные операции и календарь =======================

  const FREQ_TEXT = { monthly: T('ежемесячно'), quarterly: T('ежеквартально'), yearly: T('ежегодно') };
  const dayText = (d) => (d >= 29 ? T('в последний день') : TF('{0}-го числа', d));

  function recurringDialog(r) {
    const isNew = !r.id;
    const err = errorBox();
    const name = h('input', { type: 'text', maxlength: 120, value: r.name || '' });
    const desc = h('input', { type: 'text', maxlength: 500, value: r.description || '' });
    const freq = h('select', { value: r.freq || 'monthly' }, Object.entries(FREQ_TEXT).map(([k, v]) => h('option', { value: k }, v)));
    const day = h('select', { value: String(r.day || 5) }, [...Array(28)].map((_, i) => h('option', { value: String(i + 1) }, String(i + 1))), h('option', { value: '31' }, T('последний день месяца')));
    const mode = h('select', { value: r.mode || 'remind' }, h('option', { value: 'remind' }, T('Напоминать — проводить вручную')), h('option', { value: 'auto' }, T('Проводить автоматически')));
    const start = h('input', { type: 'date', value: today() });
    const end = h('input', { type: 'date', value: r.endDate || '' });
    const active = h('input', { type: 'checkbox' });
    active.checked = r.active !== false;
    const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, err, async () => {
      const body = { name: name.value, description: desc.value, freq: freq.value, day: Number(day.value), mode: mode.value, endDate: end.value || null };
      if (isNew) await api('POST', '/api/recurring', { ...body, entryId: r.entryId, startDate: start.value });
      else await api('PATCH', '/api/recurring/' + encodeURIComponent(r.id), { ...body, active: active.checked });
      dlg.close();
      toast(isNew ? T('Регулярная операция создана') : T('Сохранено'));
      if (isNew) go('recurring');
      else route();
    }) }, T('Сохранить'));
    const dlg = dialog(isNew ? T('Новая регулярная операция') : r.name, [err,
      h('p', { class: 'muted' }, isNew ? T('Строки проводки (счета, суммы, контрагенты) берутся из выбранной проводки.') : ''),
      field(T('Название'), name), field(T('Содержание проводки'), desc),
      h('div', { class: 'row' }, field(T('Периодичность'), freq), field(T('День'), day)),
      field(T('Режим'), mode),
      h('div', { class: 'row' }, isNew ? field(T('Начиная с'), start) : null, field(T('Окончание'), end, T('необязательно'))),
      isNew ? null : h('label', { class: 'check' }, active, h('span', null, T('Активна'))),
      h('p', { class: 'muted small' }, T('Автоматическое проведение выполняет сервер при открытом хранилище. Суммы больше порога «четырёх глаз» попадут на подтверждение.'))], [save]);
  }

  async function viewRecurring(body) {
    const list = await api('GET', '/api/recurring');
    if (!list.length) {
      body.append(h('div', { class: 'card empty' }, h('p', null, T('Регулярных операций пока нет. Откройте любую проводку в журнале (например, аренду) и нажмите «Сделать регулярной».')), h('a', { class: 'btn', href: '#/journal' }, T('К журналу'))));
      return;
    }
    body.append(h('div', { class: 'card flush' }, table([T('Операция'), T('Расписание'), T('Следующий срок'), { t: T('Сумма'), cls: 'num' }, ''], list.map((r) => h('tr', { class: r.active ? '' : 'reversed' },
      h('td', null, h('b', null, r.name), r.cpName ? h('div', { class: 'muted small' }, r.cpName) : null, r.lastError ? h('div', { class: 'alert error small' }, T('Остановлена: ') + r.lastError) : null),
      h('td', { class: 'small' }, FREQ_TEXT[r.freq], ', ', dayText(r.day), h('div', null, r.mode === 'auto' ? h('span', { class: 'badge ok' }, T('автоматически')) : h('span', { class: 'badge' }, T('напоминание')))),
      h('td', { class: 'nowrap' }, r.active ? ruDate(r.nextDate) : '—', r.overdue ? h('div', null, h('span', { class: 'badge warn' }, T('пора'))) : null, h('div', { class: 'muted small' }, T('проведено: ') + (r.posted || 0))),
      h('td', { class: 'num' }, money(r.total)),
      h('td', { class: 'nowrap' }, can('write') ? [
        r.active ? h('button', { class: 'btn small primary', type: 'button', onclick: (e) => busy(e.target, null, async () => {
          const res = await api('POST', `/api/recurring/${encodeURIComponent(r.id)}/post`, {});
          toast(res.pending ? T('Срок проведён — сумма больше порога, ждёт подтверждения') : TF("Проведено: проводка №{0} от {1}", res.number, ruDate(res.date)));
          S.recurringDue = Math.max(0, (S.recurringDue || 0) - (r.overdue && r.mode === 'remind' ? 1 : 0));
          route();
        }) }, T('Провести срок ') + ruDate(r.nextDate)) : null, ' ',
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => recurringDialog(r) }, T('Изменить')), ' ',
        h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => busy(e.target, null, async () => {
          if (!(await confirmDialog(T('Удалить «') + r.name + '»?', T('Проведённые проводки останутся в журнале.'), T('Удалить'), true))) return;
          const d = await api('DELETE', '/api/recurring/' + encodeURIComponent(r.id));
          if (d && d.pending) toast(T('Удаление отправлено на подтверждение другому сотруднику'));
          route();
        }) }, T('Удалить'))] : null)
    )))));
  }

  function periodFormNamed(name, params, extra = []) {
    const from = h('input', { type: 'date', value: params.get('from') || today().slice(0, 4) + '-01-01' });
    const to = h('input', { type: 'date', value: params.get('to') || today() });
    const form = h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      go(name, { from: from.value, to: to.value, ...Object.fromEntries(extra.map(([k, el]) => [k, el.value])) });
    } }, h('div', { class: 'row' }, field(T('С'), from), field(T('По'), to), extra.map(([, el, label]) => field(label, el)), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, T('Показать')))));
    return { form, from, to };
  }

  async function viewCashFlow(body, params) {
    const { form, from, to } = periodFormNamed('cashflow', params);
    body.append(form);
    const r = await api('GET', '/api/reports/cash-flow' + qs({ from: from.value, to: to.value }));
    body.append(
      h('div', { class: 'kpis' }, kpi(T('На начало, ') + r.currency, r.opening), kpi(T('Поступило'), r.inflow), kpi(T('Выплачено'), r.outflow), kpi(T('На конец'), r.closing)),
      h('div', { class: 'card flush' }, r.rows.length
        ? table([T('Счёт'), T('Статья'), { t: T('Поступления'), cls: 'num' }, { t: T('Выплаты'), cls: 'num' }, { t: T('Итого'), cls: 'num' }], [
          ...r.rows.map((x) => h('tr', null, h('td', { class: 'code' }, x.code), h('td', null, x.name), h('td', { class: 'num' }, x.inflow ? money(x.inflow) : ''), h('td', { class: 'num' }, x.outflow ? money(x.outflow) : ''), h('td', { class: 'num' + (x.inflow - x.outflow < 0 ? ' neg' : '') }, money(x.inflow - x.outflow)))),
          h('tr', { class: 'group' }, h('td', null), h('td', null, T('Всего')), h('td', { class: 'num' }, money(r.inflow)), h('td', { class: 'num' }, money(r.outflow)), h('td', { class: 'num' }, money(r.inflow - r.outflow)))])
        : h('p', { class: 'muted', style: null }, T('Движений по денежным счетам за период нет.'))));
  }

  async function viewPayouts(body, params) {
    const { form, from, to } = periodFormNamed('payouts', params);
    body.append(form);
    const r = await api('GET', '/api/reports/payouts' + qs({ from: from.value, to: to.value }));
    if (!r.rows.length) {
      body.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, TF('Выплат за период нет. Выплатой считается проводка, где счёт расчётов с персоналом ({0}) в дебете, а касса, банковский счёт или кошелёк — в кредите.', r.payrollAccounts.join(', ') || '—'))));
      return;
    }
    const chCodes = r.channels.map((c) => c.code);
    const fxText = (amount, cur) => (cur ? fmtUnits(amount, decimalsOf(cur)) + ' ' + cur : '');
    body.append(
      h('div', { class: 'kpis' }, kpi(T('Выплачено всего, ') + r.currency, r.total), kpi(T('Сотрудников'), r.people.length, String), kpi(T('Каналов'), r.channels.length, String)),
      h('h3', null, T('По каналам')),
      h('div', { class: 'card flush' }, table([T('Счёт'), T('Канал'), { t: T('Выплат'), cls: 'num' }, { t: TF('Сумма, {0}', r.currency), cls: 'num' }, { t: T('В валюте канала'), cls: 'num' }],
        r.channels.map((c) => h('tr', null, h('td', { class: 'code' }, c.code), h('td', null, c.name), h('td', { class: 'num' }, c.count), h('td', { class: 'num' }, money(c.amount)), h('td', { class: 'num' }, fxText(c.fx, c.currency)))))),
      h('h3', null, T('По сотрудникам')),
      h('div', { class: 'card flush' }, table([T('Сотрудник'), ...chCodes.map((code) => ({ t: code, cls: 'num' })), { t: T('Итого'), cls: 'num' }],
        r.people.map((p) => h('tr', null, h('td', null, p.person), chCodes.map((code) => h('td', { class: 'num' }, p.channels[code] ? money(p.channels[code]) : '')), h('td', { class: 'num' }, money(p.amount)))))),
      h('h3', null, T('Все выплаты')),
      h('div', { class: 'card flush' }, table([T('Дата'), { t: NO, cls: 'num' }, T('Содержание'), T('Сотрудник'), T('Канал'), { t: T('Сумма'), cls: 'num' }],
        r.rows.map((x) => h('tr', { class: 'clickable', onclick: () => openEntry(x.entryId) },
          h('td', { class: 'nowrap' }, ruDate(x.date)), h('td', { class: 'num' }, x.number), h('td', null, x.description),
          h('td', null, x.person || '—'), h('td', null, h('span', { class: 'code' }, x.channel), ' ', x.channelName),
          h('td', { class: 'num' }, money(x.amount), x.fx !== null ? h('div', { class: 'muted small' }, fxText(x.fx, x.currency)) : null))))),
      h('p', { class: 'muted small' }, TF('Счета расчётов с персоналом: {0}. Налоги и взносы с выплат начисляются обычными проводками — отчёт их не заменяет.', r.payrollAccounts.join(', '))));
  }

  async function viewConsolidated(body, params) {
    const cur = h('select', { value: params.get('currency') || (S.companies[0] || {}).currency || 'RUB' }, (S.catalog.currencies || ['RUB', 'USD', 'EUR']).map((c2) => h('option', { value: c2 }, c2)));
    const { form, from, to } = periodFormNamed('consolidated', params, [['currency', cur, T('Валюта отчёта')]]);
    body.append(form);
    if (S.companies.length < 2) body.append(h('div', { class: 'alert info' }, T('Сводный отчёт полезен, когда компаний несколько. Добавить компанию можно в «Администрирование» → «Компании».')));
    const r = await api('GET', '/api/reports/consolidated' + qs({ from: from.value, to: to.value, currency: cur.value }));
    const m = (v) => (v === null || v === undefined ? '—' : money(v));
    body.append(
      r.missingRates.length ? h('div', { class: 'alert error' }, T('Нет курса для пересчёта: ') + r.missingRates.join(', ') + ' → ' + r.currency + T('. Добавьте курс в «Курсы валют», иначе эти компании не попадут в итог.')) : null,
      h('div', { class: 'kpis' }, kpi(T('Деньги, ') + r.currency, r.totals.money), kpi(T('Доходы'), r.totals.income), kpi(T('Расходы'), r.totals.expense), kpi(r.totals.profit >= 0 ? T('Прибыль') : T('Убыток'), Math.abs(r.totals.profit))),
      h('div', { class: 'card flush' }, table([T('Компания'), T('Курс'), { t: T('Деньги'), cls: 'num' }, { t: T('Доходы'), cls: 'num' }, { t: T('Расходы'), cls: 'num' }, { t: T('Результат'), cls: 'num' }, { t: T('Нам должны'), cls: 'num' }, { t: T('Мы должны'), cls: 'num' }], [
        ...r.rows.map((x) => h('tr', null,
          h('td', null, h('b', null, x.name), h('div', { class: 'muted small' }, x.currency)),
          h('td', { class: 'small nowrap' }, x.currency === r.currency ? '—' : x.rate ? `1 ${x.currency} = ${(x.rate / 1e6).toFixed(4).replace('.', DEC)} ${r.currency}` : h('span', { class: 'badge danger' }, T('нет курса')), x.rateDate && x.currency !== r.currency ? h('div', { class: 'muted' }, ruDate(x.rateDate)) : null),
          ...['money', 'income', 'expense', 'profit', 'receivable', 'payable'].map((k) => h('td', { class: 'num' + (x.converted && x.converted[k] < 0 ? ' neg' : '') }, m(x.converted ? x.converted[k] : null), x.currency !== r.currency ? h('div', { class: 'muted small' }, money(x.own[k]) + ' ' + x.currency) : null)))),
        h('tr', { class: 'group' }, h('td', null, T('Итого, ') + r.currency), h('td', null), ...['money', 'income', 'expense', 'profit', 'receivable', 'payable'].map((k) => h('td', { class: 'num' }, money(r.totals[k])))),
      ])));
  }

  async function viewCalendar(body, params) {
    const days = Number(params.get('days')) || 60;
    const r = await api('GET', '/api/calendar?days=' + days);
    const sel = h('select', { value: String(days), onchange: (e) => go('calendar', { days: e.target.value }) }, [30, 60, 90, 180].map((d) => h('option', { value: String(d) }, d + T(' дней'))));
    const KIND = { recurring: T('регулярная'), invoice: T('счёт покупателю'), tax: T('налог') };
    body.append(
      h('div', { class: 'kpis' },
        kpi(T('Деньги сейчас, ') + r.currency, r.balance),
        kpi(T('Минимальный остаток'), r.min.balance),
        kpi(T('Остаток через ') + days + T(' дней'), r.items.length ? r.items[r.items.length - 1].balance : r.balance)),
      r.min.balance < 0 ? h('div', { class: 'alert error' }, TF("Кассовый разрыв: {0} остаток станет {1} {2}. Перенесите платежи или ускорьте поступления.", ruDate(r.min.date), money(r.min.balance), r.currency)) : null,
      h('div', { class: 'card flush' },
        h('div', { class: 'dlg-foot' }, h('span', { class: 'muted small' }, T('Поступления по выставленным счетам, регулярные платежи и налоги. Счёт без даты оплаты учитывается датой выставления.')), sel),
        r.items.length ? table([T('Дата'), T('Что'), T('Вид'), { t: T('Приход'), cls: 'num' }, { t: T('Расход'), cls: 'num' }, { t: T('Остаток'), cls: 'num' }], r.items.map((it) => h('tr', { class: it.overdue ? 'overdue' : '' },
          h('td', { class: 'nowrap' }, ruDate(it.date), it.overdue ? h('div', null, h('span', { class: 'badge warn' }, T('просрочено'))) : null),
          h('td', null, it.title, it.accrual ? h('div', { class: 'muted small' }, T('начисление без движения денег: ') + money(it.accrual)) : null),
          h('td', { class: 'small muted' }, KIND[it.kind]),
          h('td', { class: 'num' }, it.amount > 0 ? money(it.amount) : ''),
          h('td', { class: 'num' }, it.amount < 0 ? money(-it.amount) : ''),
          h('td', { class: 'num' + (it.balance < 0 ? ' neg' : '') }, money(it.balance)))))
          : h('p', { class: 'muted', style: null }, T('В выбранном периоде платежей нет.'))));
  }

  // ======================= Лицензия =======================

  async function licenseCard() {
    const r = await api('GET', '/api/license');
    const lim = r.limits;
    const key = h('textarea', { rows: 3, spellcheck: 'false', placeholder: 'ODEM1.…' });
    const err = errorBox();
    const save = h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.target, err, async () => {
      const res = await api('PUT', '/api/license', { key: key.value });
      toast(T('Лицензия установлена: ') + res.license.licensee);
      S.license = { edition: res.limits.edition, licensee: res.limits.licensee, expires: res.limits.expires, expired: false };
      route();
    }) }, T('Установить лицензию'));
    const n = (v) => (v === null || v === undefined ? T('без ограничений') : v);
    return h('div', { class: 'card' },
      h('h2', null, T('Лицензия '), lim.edition === 'basic' ? h('span', { class: 'badge' }, T('демо-версия')) : h('span', { class: 'badge ok' }, lim.licensee)),
      r.error ? h('div', { class: 'alert error' }, T('Установленный ключ недействителен: ') + r.error) : null,
      lim.expiredLicense ? h('div', { class: 'alert error' }, T('Срок лицензии истёк ') + ruDate(lim.expiredLicense.expires) + T('. Учёт работает, но добавлять компании и пользователей сверх базовой редакции нельзя.')) : null,
      h('dl', { class: 'meta' },
        h('dt', null, T('Компании')), h('dd', null, r.usage.companies, T(' из '), n(lim.maxCompanies)),
        h('dt', null, T('Пользователи')), h('dd', null, r.usage.users, T(' из '), n(lim.maxUsers)),
        h('dt', null, T('Действует до')), h('dd', null, lim.expires ? ruDate(lim.expires) : lim.edition === 'basic' ? '—' : T('бессрочно')),
        h('dt', null, T('Код установки')), h('dd', { class: 'mono small' }, r.installation)),
      h('p', { class: 'muted small' }, T('Код установки сообщите поставщику: лицензия, выданная на него, работает только в этой установке. Ключ проверяется без интернета.')),
      err, field(T('Ключ лицензии'), key), h('div', { class: 'actions' }, save));
  }

  // ======================= Сеть =======================

  function downloadBase64(b64, name, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function viewNetwork(body) {
    const r = await api('GET', '/api/network');
    const conf = r.config;
    const run = r.running;
    const host0 = (conf.names.find((n) => n !== 'localhost') || conf.ips.find((i) => i !== '127.0.0.1') || T('имя-сервера'));
    const lanUrl = `https://${host0}:${conf.port || run.port}/`;
    const lines = (arr) => (arr || []).join('\n');
    const parseLines = (s) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

    // --- состояние ---
    body.append(h('div', { class: 'card' },
      h('h2', null, T('Сейчас '), run.lan ? h('span', { class: 'badge ok' }, T('локальная сеть')) : h('span', { class: 'badge' }, T('только этот компьютер'))),
      run.lan
        ? h('p', null, T('Сервер принимает подключения по HTTPS: '), h('b', { class: 'mono' }, lanUrl), '. ', run.requireDeviceCert ? T('Подключаться могут только устройства с сертификатом.') : h('span', { class: 'badge warn' }, T('сертификаты устройств не требуются')))
        : h('p', { class: 'muted' }, T('Приложение доступно только на этом компьютере (http://localhost). Чтобы сотрудники работали со своих компьютеров, выполните три шага ниже и перезапустите сервер.')),
      r.restartRequired
        ? h('div', { class: 'alert info' },
          r.applyAvailable
            ? [T('Изменения сети ещё не действуют. '), h('button', { class: 'btn small primary', type: 'button', onclick: (e) => applyNetworkNow(e.currentTarget) }, T('Применить сейчас'))]
            : T('Изменения сети вступят в силу после перезапуска сервера: ярлык «Одем — остановить», затем «Одем» (или перезапуск службы).'))
        : null,
      r.ca ? h('p', { class: 'small' }, connectFileLink(T('Файл «Odem-connect.cmd» для компьютеров сотрудников')), ' ', h('span', { class: 'muted' }, T('— доверие к серверу и ярлык на рабочем столе, без прав администратора.'))) : null
    ));

    // --- шаг 1: центр ---
    const caBtn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.target, null, async () => {
      await api('POST', '/api/network/ca');
      toast(T('Удостоверяющий центр создан'));
      route();
    }) }, T('Создать удостоверяющий центр'));
    body.append(h('div', { class: 'card' },
      h('h2', null, T('1. Удостоверяющий центр '), r.ca ? h('span', { class: 'badge ok' }, T('создан')) : null),
      h('p', { class: 'muted' }, T('Свой центр сертификации приложения: им подписываются сертификат сервера и сертификаты устройств сотрудников. Его ключ хранится зашифрованным ключом данных — выпускать сертификаты можно только при открытом хранилище.')),
      r.ca
        ? [h('dl', { class: 'meta' }, h('dt', null, T('Действует до')), h('dd', null, ruDateTime(r.ca.notAfter)), h('dt', null, T('Отпечаток SHA-256')), h('dd', { class: 'mono small' }, r.ca.fingerprint)),
          h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/api/network/ca.cer', download: '' }, T('Скачать сертификат центра')), h('a', { class: 'btn ghost', href: '/api/network/client-setup.ps1', download: '' }, T('Скрипт для компьютеров сотрудников')))]
        : h('div', { class: 'actions' }, caBtn)));

    // --- шаг 2: сертификат сервера ---
    const names = h('textarea', { rows: 2, spellcheck: 'false' });
    names.value = lines(conf.names.length ? conf.names.filter((n) => n !== 'localhost') : r.suggestions.names.filter((n) => n !== 'localhost'));
    const ips = h('textarea', { rows: 2, spellcheck: 'false' });
    ips.value = lines(conf.ips.length ? conf.ips.filter((i) => i !== '127.0.0.1') : r.suggestions.ips.filter((i) => i !== '127.0.0.1'));
    const srvErr = errorBox();
    const srvBtn = h('button', { class: 'btn primary', type: 'button', disabled: r.ca ? null : true, onclick: (e) => busy(e.target, srvErr, async () => {
      await api('POST', '/api/network/server-cert', { names: parseLines(names.value), ips: parseLines(ips.value) });
      toast(T('Сертификат сервера выпущен'));
      route();
    }) }, r.server ? T('Выпустить заново') : T('Выпустить сертификат сервера'));
    body.append(h('div', { class: 'card' },
      h('h2', null, T('2. Сертификат сервера '), r.server ? h('span', { class: 'badge ok' }, T('выпущен')) : null),
      h('p', { class: 'muted' }, T('Имена и адреса, по которым сотрудники открывают приложение. Браузер проверит, что подключается именно к этому серверу. Лучше использовать постоянный IP-адрес (закрепите его на роутере) или имя компьютера.')),
      r.server ? h('p', { class: 'small' }, T('Сейчас: '), h('span', { class: 'mono' }, r.server.san), T(' · до '), ruDateTime(r.server.notAfter)) : null,
      srvErr,
      h('div', { class: 'row' }, field(T('Имена сервера'), names, T('по одному в строке')), field(T('IP-адреса сервера'), ips, T('по одному в строке'))),
      h('div', { class: 'actions' }, srvBtn)));

    // --- шаг 3: настройки сети ---
    const en = h('input', { type: 'checkbox' }); en.checked = !!conf.enabled;
    const port = h('input', { type: 'number', min: 1, max: 65535, value: conf.port || run.port });
    const bind = h('select', { value: conf.bind || '0.0.0.0' }, h('option', { value: '0.0.0.0' }, T('все сетевые адреса')), r.suggestions.ips.map((ip) => h('option', { value: ip }, ip)));
    const reqDev = h('input', { type: 'checkbox' }); reqDev.checked = conf.requireDeviceCert !== false;
    const localOk = h('input', { type: 'checkbox' }); localOk.checked = conf.allowLocalWithoutCert !== false;
    const adminDev = h('input', { type: 'checkbox' }); adminDev.checked = !!conf.adminDevicesOnly;
    const allowNets = h('textarea', { rows: 3, spellcheck: 'false', placeholder: '192.168.1.0/24' }); allowNets.value = lines(conf.allowedNetworks);
    const adminNets = h('textarea', { rows: 2, spellcheck: 'false', placeholder: '192.168.1.10' }); adminNets.value = lines(conf.adminNetworks);
    const netErr = errorBox();
    const netBtn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.target, netErr, async () => {
      const res = await api('PATCH', '/api/network', { enabled: en.checked, port: Number(port.value) || null, bind: bind.value, requireDeviceCert: reqDev.checked, allowLocalWithoutCert: localOk.checked, adminDevicesOnly: adminDev.checked, allowedNetworks: parseLines(allowNets.value), adminNetworks: parseLines(adminNets.value) });
      toast(res.pending ? res.message : T('Сохранено. Перезапустите сервер, чтобы применить.'));
      route();
    }) }, T('Сохранить'));
    const chk = (el, title, text) => h('label', { class: 'check' }, el, h('span', null, h('b', null, title), h('div', { class: 'muted small' }, text)));
    body.append(h('div', { class: 'card' },
      h('h2', null, T('3. Доступ из сети')),
      netErr,
      chk(en, T('Принимать подключения из локальной сети'), T('Только по HTTPS с сертификатом из шага 2. Без него сервер в сеть не выйдет.')),
      h('div', { class: 'row' }, field(T('Порт'), port), field(T('Адрес прослушивания'), bind)),
      chk(reqDev, T('Только зарегистрированные устройства (рекомендуется)'), T('Компьютер без сертификата устройства не увидит даже страницу входа. Украденный пароль бесполезен без устройства, а cookie сессии не работает на другом компьютере.')),
      chk(localOk, T('Разрешить вход на самом сервере без сертификата устройства'), T('Для администратора, работающего за компьютером-сервером.')),
      h('div', { class: 'row' },
        field(T('Разрешённые подсети'), allowNets, T('пусто — любые; например 192.168.1.0/24')),
        field(T('Администрирование только с адресов'), adminNets, T('пусто — с любых разрешённых'))),
      chk(adminDev, T('Администрирование только с устройств администратора'), T('Разделы «Администрирование» откроются только на устройствах, отмеченных ниже как «администратор».')),
      h('div', { class: 'actions' }, netBtn)));

    // --- устройства ---
    const devName = h('input', { type: 'text', maxlength: 60, placeholder: T('Например: Бухгалтерия-1 или Ноутбук Иванова') });
    const devAdmin = h('input', { type: 'checkbox' });
    const devErr = errorBox();
    const issueBtn = h('button', { class: 'btn primary', type: 'button', disabled: r.ca ? null : true, onclick: (e) => busy(e.target, devErr, async () => {
      const d = await api('POST', '/api/devices', { name: devName.value, admin: devAdmin.checked });
      devName.value = '';
      downloadBase64(d.p12, d.fileName, 'application/x-pkcs12');
      const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => { dlg.close(); route(); } }, T('Пароль записан'));
      const dlg = dialog(T('Сертификат устройства «') + d.name + '»', h('div', null,
        h('p', null, T('Файл '), h('b', { class: 'mono' }, d.fileName), T(' скачан. Пароль от него показывается только сейчас:')),
        h('div', { class: 'fingerprint mono' }, d.password),
        h('p', { class: 'muted' }, T('Передайте файл и пароль сотруднику разными способами (например, файл — на флешке, пароль — устно). Вместе с ними — сертификат центра и скрипт установки.'))), ok);
    }) }, T('Выпустить сертификат устройства'));
    const devRows = r.devices.map((d) => h('tr', { class: d.revokedAt ? 'reversed' : '' },
      h('td', null, h('b', null, d.name), d.admin ? h('span', null, ' ', h('span', { class: 'badge accent' }, T('администратор'))) : null, h('div', { class: 'muted small mono' }, d.serial.slice(0, 16))),
      h('td', { class: 'small' }, ruDateTime(d.issuedAt), h('div', { class: 'muted' }, d.issuedBy)),
      h('td', { class: 'small' }, ruDate(d.notAfter.slice(0, 10))),
      h('td', { class: 'small' }, d.lastSeen ? [ruDateTime(d.lastSeen.at), h('div', { class: 'muted' }, d.lastSeen.ip)] : h('span', { class: 'muted' }, '—')),
      h('td', null, d.revokedAt ? h('span', { class: 'badge danger' }, T('отозван ') + ruDate(d.revokedAt.slice(0, 10))) : h('span', { class: 'badge ok' }, T('действует'))),
      h('td', { class: 'nowrap' }, d.revokedAt ? null : [
        h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => busy(e.target, null, async () => {
          await api('POST', `/api/devices/${d.serial}/admin`, { admin: !d.admin });
          route();
        }) }, d.admin ? T('Снять «администратор»') : T('Сделать «администратор»')),
        ' ',
        h('button', { class: 'btn small danger', type: 'button', onclick: (e) => busy(e.target, null, async () => {
          if (!(await confirmDialog(T('Отозвать сертификат «') + d.name + '»?', T('Устройство сразу потеряет доступ, открытые на нём сессии завершатся. Вернуть сертификат нельзя — только выпустить новый.'), T('Отозвать'), true))) return;
          await api('POST', `/api/devices/${d.serial}/revoke`, {});
          toast(T('Сертификат отозван'));
          route();
        }) }, T('Отозвать'))])
    ));
    body.append(h('div', { class: 'card' },
      h('h2', null, T('Устройства сотрудников '), h('span', { class: 'badge' }, r.devices.filter((d) => !d.revokedAt).length)),
      h('p', { class: 'muted' }, T('Каждому компьютеру — свой сертификат. Ключ устройства импортируется как неэкспортируемый: скопировать его на другой компьютер нельзя. Потерянный или уволенного сотрудника — отзывайте.')),
      devErr,
      h('div', { class: 'row' }, field(T('Название устройства'), devName), h('label', { class: 'check' }, devAdmin, h('span', null, T('Устройство администратора')))),
      h('div', { class: 'actions' }, issueBtn),
      r.devices.length ? table([T('Устройство'), T('Выпущен'), T('До'), T('Последний доступ'), T('Статус'), ''], devRows) : null));

    // --- подключение сотрудника ---
    body.append(h('div', { class: 'card' },
      h('h2', null, T('Как подключить компьютер сотрудника')),
      h('ol', { class: 'steps' },
        h('li', null, T('Скачайте «Сертификат центра» и «Скрипт для компьютеров сотрудников» (шаг 1) и выпустите сертификат устройства.')),
        h('li', null, T('Положите в одну папку на компьютере сотрудника: odem-ca.cer, odem-client-setup.ps1 и файл .p12.')),
        h('li', null, T('Запустите: правый щелчок по скрипту → «Выполнить с помощью PowerShell». Подтвердите установку сертификата центра и введите пароль от .p12.')),
        h('li', null, T('Откройте ярлык «Одем» на рабочем столе ('), h('span', { class: 'mono' }, lanUrl), T('), выберите сертификат «Одем» и войдите своим паролем.')),
        h('li', null, T('Удалите файл .p12 с компьютера и флешки.')))));
  }

  // ======================= Безопасность =======================

  async function viewSecurity(body) {
    const r = await api('GET', '/api/security');
    const LEVEL = { critical: ['danger', T('критично')], warning: ['warn', T('внимание')], info: ['', T('сведения')] };
    const open = r.alerts.filter((a) => !a.ackAt);
    const done = r.alerts.filter((a) => a.ackAt);
    const ack = (a) => {
      const err = errorBox();
      const note = h('input', { type: 'text', maxlength: 300, placeholder: T('Например: восстанавливали данные из копии от 12.11') });
      const ok = h('button', { class: 'btn primary', type: 'button' }, T('Подтвердить'));
      const dlg = dialog(T('Подтвердить предупреждение'), h('div', null,
        h('p', null, h('b', null, a.title)),
        h('p', { class: 'muted' }, T('Подтверждайте, только если знаете причину. Ваше имя и комментарий попадут в журнал аудита.')),
        err, field(T('Причина'), note)), ok);
      ok.onclick = () => busy(ok, err, async () => {
        await api('POST', '/api/security/alerts/' + encodeURIComponent(a.id) + '/ack', { note: note.value });
        dlg.close();
        S.alerts = Math.max(0, (S.alerts || 0) - 1);
        toast(T('Предупреждение подтверждено'));
        route();
      });
      note.focus();
    };
    const alertCard = (a) => h('div', { class: 'sec-alert ' + (a.ackAt ? 'done' : a.level) },
      h('div', { class: 'sec-alert-head' },
        h('span', { class: 'badge ' + LEVEL[a.level][0] }, LEVEL[a.level][1]),
        h('b', null, a.title),
        h('span', { class: 'muted small' }, ruDateTime(a.at))),
      h('p', null, a.text),
      a.ackAt
        ? h('p', { class: 'muted small' }, T('Подтвердил '), a.ackBy, ' ', ruDateTime(a.ackAt), a.note ? ': «' + a.note + '»' : '')
        : can('admin') ? h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => ack(a) }, T('Подтвердить'))) : null
    );
    const fp = r.audit ? r.audit.fingerprint.toUpperCase().match(/.{4}/g).join(' ') : '—';
    body.append(
      h('div', { class: 'card' },
        h('h2', null, T('Предупреждения '), open.length ? h('span', { class: 'badge danger' }, open.length) : h('span', { class: 'badge ok' }, T('нет'))),
        open.length ? open.map(alertCard) : h('p', { class: 'muted' }, T('Неподтверждённых предупреждений нет. Здесь появятся сигналы об откате данных, подмене файлов и переписанном журнале.'))),
      h('div', { class: 'home-grid' },
        h('div', { class: 'card' },
          h('h2', null, T('Отпечаток журнала')),
          r.audit ? [
            h('div', { class: 'fingerprint mono' }, fp),
            h('p', { class: 'muted small' }, T('Запись №'), r.audit.seq, T(' от '), ruDateTime(r.audit.ts), '.'),
            h('p', { class: 'muted' }, T('Время от времени записывайте номер и отпечаток вне компьютера — в бумажный журнал или письмо руководителю. Если позже у записи с тем же номером окажется другой отпечаток, журнал переписали.')),
          ] : h('p', { class: 'muted' }, T('Журнал пуст.'))),
        h('div', { class: 'card' },
          h('h2', null, T('Защита от отката '), r.anchor.enabled ? h('span', { class: 'badge ok' }, T('включена')) : h('span', { class: 'badge warn' }, T('выключена'))),
          h('p', { class: 'muted' }, T('Номер версии данных и отпечаток журнала хранятся отдельно от хранилища. Если файл данных подменят старой копией, при следующем входе здесь появится предупреждение.')),
          h('dl', { class: 'meta' },
            h('dt', null, T('Версия данных')), h('dd', { class: 'mono' }, r.generation),
            h('dt', null, T('Файл якоря')), h('dd', { class: 'mono small' }, r.anchor.file || '—'),
            h('dt', null, T('Обновлён')), h('dd', null, r.anchor.at ? ruDateTime(r.anchor.at) : '—')),
          h('p', { class: 'muted small' }, T('Надёжнее держать якорь на другом диске или сервере: параметр anchorDir в config.json.')))),
      h('div', { class: 'card' },
        h('h2', null, T('Доступ к папкам '), !r.folders ? h('span', { class: 'badge warn' }, T('не настраивался')) : r.folders.every((f) => f.ok) ? h('span', { class: 'badge ok' }, T('только у сервера')) : h('span', { class: 'badge danger' }, T('есть посторонние'))),
        h('p', { class: 'muted' }, T('При запуске приложение оставляет доступ к папкам данных и якоря только учётной записи, под которой работает сервер, и системе. Другие пользователи компьютера не смогут скопировать или подменить файлы.')),
        r.folders ? h('div', { class: 'list' }, r.folders.map((f) => h('div', { class: 'li' },
          h('span', { class: 'mono small' }, f.dir),
          f.ok ? h('span', { class: 'badge ok' }, T('защищена')) : h('span', { class: 'badge danger', title: f.error || '' }, f.error ? T('ошибка') : T('посторонние: ') + f.extra.join(', '))))) : h('p', { class: 'muted small' }, T('Защита папок выключена в config.json (protectFolders: false).'))),
      r.machine.supported ? machineCard(r.machine) : '',
      await securityEventsCard(),
      can('admin') ? await allSessionsCard() : '',
      can('admin') ? await syslogCard() : '',
      done.length ? h('div', { class: 'card' }, h('h2', null, T('Подтверждённые')), done.slice(0, 30).map(alertCard)) : ''
    );
  }

  async function securityEventsCard() {
    const ev = await api('GET', '/api/security/events?days=7');
    const n = (k) => ev.counts[k] || 0;
    const kpis = [
      [T('Неудачные входы'), n('auth.login_failed') + n('auth.2fa_failed') + n('auth.passkey_failed')],
      [T('Отказы по сети'), n('network.denied')],
      [T('Выгрузки данных'), n('data.export')],
      [T('Сбросы паролей и 2FA'), n('user.password_reset') + n('user.2fa_reset')],
      [T('Предупреждения'), Object.entries(ev.counts).filter(([k]) => k.startsWith('security.') && !['security.alert_ack', 'security.syslog', 'security.syslog_test'].includes(k)).reduce((s, [, v]) => s + v, 0)],
    ];
    const KIND = { login: T('подбор пароля'), address: T('много попыток с адреса'), password: T('повтор пароля') };
    return h('div', { class: 'card' },
      h('h2', null, T('События за 7 дней')),
      h('div', { class: 'sec-kpis' }, kpis.map(([label, v]) => h('div', { class: 'sec-kpi' + (v ? ' hot' : '') }, h('b', null, v), h('span', null, label)))),
      ev.blocked.length ? h('div', { class: 'alert error' }, h('b', null, T('Сейчас заблокированы: ')), ev.blocked.map((b) => TF("{0} ({1}, {2} попыток, до {3})", b.label || '—', KIND[b.kind] || b.kind, b.fails, new Date(b.until).toLocaleTimeString(LOCALE))).join('; ')) : null,
      ev.recent.length
        ? table([T('Время'), T('Пользователь'), T('Событие'), T('Подробности')], ev.recent.map((a) => h('tr', null,
          h('td', { class: 'nowrap small' }, ruDateTime(a.ts)),
          h('td', null, a.username || (a.details && a.details.username) || h('span', { class: 'muted' }, '—')),
          h('td', null, ACTIONS[a.action] || a.action),
          h('td', { class: 'small mono' }, detailsText(a)))))
        : h('p', { class: 'muted' }, T('Событий безопасности не было.')));
  }

  async function allSessionsCard() {
    const list = await api('GET', '/api/sessions');
    return h('div', { class: 'card' },
      h('h2', null, T('Кто сейчас в приложении '), h('span', { class: 'badge' }, list.length)),
      table([T('Пользователь'), T('Устройство и адрес'), T('Вход'), T('Активность'), ''], list.map((s) => h('tr', null,
        h('td', null, h('b', null, s.displayName), h('div', { class: 'muted small' }, s.username)),
        h('td', { class: 'small' }, uaLabel(s.ua), s.device ? h('div', null, T('устройство: '), s.device) : null, h('div', { class: 'muted' }, s.ip)),
        h('td', { class: 'small nowrap' }, ruDateTime(s.createdAt)),
        h('td', { class: 'small nowrap' }, ruDateTime(s.lastSeen), s.elevated ? h('div', null, h('span', { class: 'badge warn' }, T('подтвердил пароль'))) : null),
        h('td', null, s.current ? h('span', { class: 'badge ok' }, T('вы')) : h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => busy(e.target, null, async () => {
          if (!(await confirmDialog(T('Завершить сессию ') + s.username + '?', T('Пользователь будет выведен из приложения на этом устройстве.'), T('Завершить'), true))) return;
          await api('POST', '/api/sessions/' + encodeURIComponent(s.id) + '/end', {});
          toast(T('Сессия завершена'));
          route();
        }) }, T('Завершить')))))));
  }

  async function syslogCard() {
    const s = await api('GET', '/api/security/syslog');
    const en = h('input', { type: 'checkbox' }); en.checked = !!s.enabled;
    const host = h('input', { type: 'text', value: s.host || '', placeholder: T('192.168.1.20 или siem.local'), spellcheck: 'false' });
    const port = h('input', { type: 'number', min: 1, max: 65535, value: s.port || 514 });
    const proto = h('select', { value: s.protocol || 'udp' }, h('option', { value: 'udp' }, 'UDP'), h('option', { value: 'tcp' }, 'TCP'));
    const err = errorBox();
    const save = h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.target, err, async () => {
      await api('PUT', '/api/security/syslog', { enabled: en.checked, host: host.value, port: Number(port.value), protocol: proto.value });
      toast(T('Настройки пересылки сохранены'));
      route();
    }) }, T('Сохранить'));
    const test = h('button', { class: 'btn', type: 'button', disabled: s.enabled ? null : true, onclick: (e) => busy(e.target, err, async () => {
      await api('POST', '/api/security/syslog/test', {});
      toast(T('Тестовое событие отправлено — проверьте сервер журналов'));
    }) }, T('Отправить тестовое событие'));
    return h('div', { class: 'card' },
      h('h2', null, T('Пересылка журнала (syslog) '), s.enabled ? h('span', { class: 'badge ok' }, T('включена')) : h('span', { class: 'badge' }, T('выключена'))),
      h('p', { class: 'muted' }, T('Каждая запись журнала аудита отправляется на сервер журналов (SIEM) вашей сети в формате RFC 5424. Копия журнала на другом сервере не даст незаметно переписать историю. Пароли и ключи не передаются.')),
      s.enabled ? h('p', { class: 'small' }, T('Отправлено с запуска: '), s.sent, s.lastError ? h('span', { class: 'badge danger' }, T(' ошибка: ') + s.lastError) : null) : null,
      err,
      h('label', { class: 'check' }, en, h('span', null, T('Пересылать события'))),
      h('div', { class: 'row' }, field(T('Сервер журналов'), host), field(T('Порт'), port), field(T('Протокол'), proto)),
      h('div', { class: 'actions' }, save, test));
  }

  function machineCard(m) {
    const toggle = h('button', { class: m.bound ? 'btn' : 'btn primary', type: 'button', onclick: (e) => busy(e.target, null, async () => {
      const ok = await confirmDialog(m.bound ? T('Снять привязку к компьютеру?') : T('Привязать хранилище к этому компьютеру?'),
        m.bound
          ? T('Файл хранилища и копии снова будут открываться паролем на любом компьютере.')
          : T('Пароли будут работать только на этом компьютере и под этой учётной записью Windows. Украденный файл или копия не откроются даже с паролем. Для переноса на новый компьютер понадобится ключ восстановления — проверьте, что он у вас есть.'),
        m.bound ? T('Снять привязку') : T('Привязать'), m.bound);
      if (!ok) return;
      const res = await api('POST', '/api/security/machine-binding', { enable: !m.bound });
      toast(res && res.pending ? res.message : m.bound ? T('Привязка снята') : T('Хранилище привязано к компьютеру'));
      route();
    }) }, m.bound ? T('Снять привязку') : T('Привязать к этому компьютеру'));
    return h('div', { class: 'card' },
      h('h2', null, T('Привязка к компьютеру '), m.bound ? h('span', { class: 'badge ok' }, T('включена')) : h('span', { class: 'badge' }, T('выключена'))),
      h('p', { class: 'muted' }, T('Ключи паролей дополнительно шифруются средствами Windows (DPAPI): их может расшифровать только учётная запись, под которой работает сервер, на этом компьютере. Файл хранилища или резервная копия, вынесенные с компьютера, открываются только ключом восстановления.')),
      m.bound ? h('p', { class: 'muted small' }, T('Включена '), ruDateTime(m.since), T('. При переносе на другой компьютер войдите ключом восстановления — привязка снимется, остальным пользователям нужно будет выдать новые пароли.')) : null,
      can('admin') ? h('div', { class: 'actions' }, toggle) : null);
  }

  async function viewAudit(body) {
    const status = h('div');
    const list = h('div', { class: 'card flush' });
    let offset = 0;
    const rows = [];
    const verifyBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(verifyBtn, null, async () => {
      const r = await api('GET', '/api/audit/verify');
      fill(status, r.ok
        ? h('div', { class: 'alert ok' }, TF("Цепочка целостна: {0} записей, подписи и связи верны. Контрольное значение последней записи: ", r.count), h('span', { class: 'mono small' }, r.head.slice(0, 32) + '…'),
          r.fingerprint ? h('div', { class: 'small' }, TF('Подписано ключом установки: {0} из {1}. Отпечаток открытого ключа: ', r.signed, r.count), h('span', { class: 'mono' }, r.fingerprint)) : null)
        : h('div', { class: 'alert error' }, TF("Нарушение целостности журнала на записи №{0} из {1}. Журнал мог быть изменён в обход приложения.", r.brokenAt, r.count)));
    }) }, T('Проверить целостность'));
    const exportBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        await ensureElevated();
        const a = h('a', { href: '/api/audit/export.json', download: '' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => toast(T('Файл сохранён без шифрования. Храните его в защищённой папке и удалите, когда он станет не нужен.')), 400);
      } catch (e) {
        toast(e.message, 'error');
      }
    } }, T('Выгрузить для внешней проверки'));
    body.append(
      h('div', { class: 'card' },
        h('p', { class: 'muted' }, T('Каждая запись содержит хеш предыдущей, защищена HMAC ключом хранилища и подписана ключом установки (Ed25519). Удаление, вставка или изменение любой записи обнаруживается проверкой. Журнал нельзя редактировать через приложение.')),
        h('p', { class: 'muted small' }, T('Внешняя проверка: аудитор получает выгрузку и заранее записанный отпечаток ключа и запускает «node tools/verify-audit.js файл --fingerprint отпечаток». Пароль и данные учёта для этого не нужны.')),
        h('div', { class: 'actions' }, verifyBtn, exportBtn)),
      status,
      list
    );
    async function load() {
      const r = await api('GET', '/api/audit' + qs({ offset, limit: 100 }));
      offset += r.items.length;
      rows.push(...r.items.map((a) => h('tr', null,
        h('td', { class: 'num' }, a.seq),
        h('td', { class: 'nowrap' }, ruDateTime(a.ts)),
        h('td', null, a.username || h('span', { class: 'muted' }, T('система'))),
        h('td', null, SECURITY.has(a.action) ? h('span', { class: 'badge warn' }, ACTIONS[a.action] || a.action) : ACTIONS[a.action] || a.action),
        h('td', { class: 'small mono' }, detailsText(a))
      )));
      fill(list, 
        table([{ t: NO, cls: 'num' }, T('Время'), T('Пользователь'), T('Действие'), T('Подробности')], rows),
        offset < r.total ? h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, null, load) }, T('Показать ещё'))) : null
      );
    }
    await load();
    verifyBtn.click();
  }

  const VIEW_KINDS = {
    journal: T('Журнал проводок'), entry: T('Проводка'), trial_balance: T('Оборотно-сальдовая ведомость'), account_card: T('Карточка счёта'),
    balance: T('Баланс'), pnl: T('Прибыли и убытки'), reconciliation: T('Акт сверки'), cash_flow: T('Движение денег'),
    consolidated: T('Сводный отчёт'), calendar: T('Платёжный календарь'), documents: T('Счета и акты'), document: T('Печать документа'),
    attachment: T('Вложение к проводке'), dashboard: T('Главная'), payouts: T('Выплаты сотрудникам'), kudir: T('КУДиР'), tax: T('Налоги'), counterparties: T('Контрагенты'),
    users: T('Пользователи'), audit: T('Журнал аудита'), access: T('Журнал доступа'), security: T('Безопасность'),
  };

  /** Журнал доступа: кто что смотрел. Повторные открытия одного и того же за 10 минут объединяются. */
  async function viewAccess(body) {
    const user = h('select', null, h('option', { value: '' }, T('Все пользователи')));
    const kind = h('select', null, h('option', { value: '' }, T('Все разделы')), Object.entries(VIEW_KINDS).map(([k, v]) => h('option', { value: k }, v)));
    const from = h('input', { type: 'date', value: monthStart() });
    const to = h('input', { type: 'date', value: today() });
    const list = h('div', { class: 'card flush' });
    let offset = 0;
    let rows = [];
    const form = h('form', { class: 'card filters', onsubmit: (e) => {
      e.preventDefault();
      offset = 0;
      rows = [];
      load().catch((x) => toast(x.message, 'error'));
    } },
    field(T('Пользователь'), user), field(T('Раздел'), kind), field(T('С'), from), field(T('По'), to),
    h('button', { class: 'btn primary', type: 'submit' }, T('Показать')));
    body.append(
      h('p', { class: 'muted' }, T('Просмотры данных записываются в зашифрованное хранилище: кто, когда, с какого адреса и что открыл, без самих данных. Изменения и выгрузки — в журнале аудита.')),
      form, list);
    let usersFilled = false;
    async function load() {
      const r = await api('GET', '/api/access' + qs({ user: user.value, kind: kind.value, from: from.value, to: to.value, offset, limit: 100 }));
      if (!usersFilled) {
        usersFilled = true;
        user.append(...r.users.map((u) => h('option', { value: u }, u)));
      }
      offset += r.items.length;
      rows.push(...r.items.map((a) => h('tr', null,
        h('td', { class: 'nowrap' }, ruDateTime(a.ts)),
        h('td', null, a.username),
        h('td', null, VIEW_KINDS[a.kind] || a.kind),
        h('td', null, a.company || '—', a.target ? h('div', { class: 'muted small' }, a.target) : null),
        h('td', { class: 'mono small' }, a.ip || '—'))));
      fill(list,
        table([T('Время'), T('Пользователь'), T('Раздел'), T('Что открыто'), T('Адрес')], rows, { empty: T('За этот период просмотров нет') }),
        offset < r.total ? h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, null, load) }, T('Показать ещё'))) : null);
    }
    await load();
  }

  // ======================= Настройки и копии =======================

  /** Синхронизация через общую папку: только шифр, один компьютер пишет в учёт. */
  function syncCard() {
    const card = h('div', { class: 'card' }, h('h2', null, T('Синхронизация между компьютерами')));
    const render = async () => {
      const s = await api('GET', '/api/sync');
      const err = errorBox();
      const dir = h('input', { type: 'text', value: s.dir || '', spellcheck: 'false', placeholder: 'C:\\Users\\…\\OneDrive\\Odem' });
      const on = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(on, err, async () => {
        await api('PUT', '/api/sync', { enabled: true, dir: dir.value.trim() });
        toast(T('Синхронизация включена'));
        render();
      }) }, s.enabled ? T('Сохранить папку') : T('Включить'));
      const off = s.enabled ? h('button', { class: 'btn', type: 'button', onclick: () => busy(off, err, async () => {
        await api('PUT', '/api/sync', { enabled: false });
        toast(T('Синхронизация выключена'));
        render();
      }) }, T('Выключить')) : null;
      fill(card,
        h('h2', null, T('Синхронизация между компьютерами'), ' ', s.enabled ? h('span', { class: 'badge ok' }, T('включена')) : h('span', { class: 'badge' }, T('выключена'))),
        h('p', { class: 'muted' }, T('Учёт можно вести на нескольких компьютерах по очереди через общую папку: OneDrive, Яндекс Диск или сетевую. В папку уходит только шифр — тот же зашифрованный файл и вложения, что на диске; ключа там нет. Пока учёт открыт на одном компьютере, другой не войдёт; после блокировки — войдёт и получит свежую версию.')),
        s.machineBound ? h('div', { class: 'alert warn' }, T('Хранилище привязано к этому компьютеру — на другом его не открыть. Снимите привязку на странице «Безопасность», чтобы включить синхронизацию.')) : null,
        s.conflict ? h('div', { class: 'alert error' }, TF('Синхронизация остановлена: в папке версия, изменённая на компьютере «{0}» в обход блокировки. Ничего не перезаписано. Сохраните архивы на обоих компьютерах и включите синхронизацию заново на том, где учёт верный.', s.conflict.other || '?')) : null,
        s.error ? h('div', { class: 'alert error' }, TF('Папка недоступна: {0}', s.error)) : null,
        s.enabled ? h('dl', { class: 'meta' },
          h('dt', null, T('Этот компьютер')), h('dd', null, s.node),
          h('dt', null, T('Папка')), h('dd', { class: 'mono small' }, s.dir),
          h('dt', null, T('Последняя отправка')), h('dd', null, s.lastPush ? ruDateTime(s.lastPush) : '—'),
          h('dt', null, T('Сейчас пишет')), h('dd', null, s.mirror && s.mirror.writer ? (s.mirror.writer.me ? T('этот компьютер') : s.mirror.writer.label) : T('никто'))) : null,
        err,
        h('div', { class: 'row' }, field(T('Папка синхронизации'), dir, T('полный путь; в ней появится подпапка odem-sync')), h('div', { class: 'actions' }, on, off)),
        h('p', { class: 'muted small' }, T('Второй компьютер: установите Одем и на экране первичной настройки выберите «У меня уже есть учёт в папке синхронизации».')));
    };
    render().catch((e) => fill(card, h('div', { class: 'alert error' }, e.message)));
    return card;
  }

  async function viewSettings(body) {
    const err = errorBox();
    const s = S.settings;
    const org = h('input', { type: 'text', value: S.org.name, maxlength: 200, placeholder: T('Мой учёт') });
    const archDir = h('input', { type: 'text', value: s.archiveDir || '', placeholder: T('например E:\\Одем-копии'), spellcheck: 'false', autocomplete: 'off' });
    const archAuto = h('input', { type: 'checkbox' });
    archAuto.checked = !!s.archiveAuto;
    const ratesAuto = h('input', { type: 'checkbox' });
    ratesAuto.checked = !!(s.rates && s.rates.autoFetch);
    const tg = h('input', { type: 'text', value: s.telegram ? '@' + s.telegram : '', maxlength: 100, placeholder: T('@username или t.me/username'), spellcheck: 'false', autocomplete: 'off' });
    const idle = h('input', { type: 'number', min: 1, max: 120, value: s.idleMinutes });
    const maxH = h('input', { type: 'number', min: 1, max: 24, value: s.sessionMaxHours });
    const closed = h('input', { type: 'date', value: s.closedUntil || '' });
    const req2fa = h('input', { type: 'checkbox' });
    req2fa.checked = !!s.require2fa;
    const dual = h('input', { type: 'checkbox' });
    dual.checked = !!s.dualControl;
    const minLen = h('input', { type: 'number', min: 12, max: 64, value: s.passwordMinLength || 12 });
    const expPol = h('select', { value: s.exportPolicy || 'all' },
      h('option', { value: 'all' }, T('Всем, у кого есть доступ к компании')),
      h('option', { value: 'staff' }, T('Всем, кроме наблюдателей')),
      h('option', { value: 'admins' }, T('Только администраторам')));
    const save = h('button', { class: 'btn primary', type: 'submit' }, T('Сохранить'));
    body.append(h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      busy(save, err, async () => {
        if ((closed.value || null) !== (s.closedUntil || null) && closed.value < (s.closedUntil || '') &&
          !(await confirmDialog(T('Открыть закрытый период?'), T('Вы переносите дату закрытия назад — в ранее закрытом периоде снова можно будет делать проводки. Действие будет записано в журнал аудита.'), T('Открыть период'), true))) return;
        const r = await api('PATCH', '/api/settings', { archiveDir: archDir.value, archiveAuto: archAuto.checked, ratesAutoFetch: ratesAuto.checked, orgName: org.value, telegram: tg.value, idleMinutes: Number(idle.value), sessionMaxHours: Number(maxH.value), closedUntil: closed.value || null, require2fa: req2fa.checked, dualControl: dual.checked, passwordMinLength: Number(minLen.value), exportPolicy: expPol.value });
        if (r.pendingMessage) toast(r.pendingMessage);
        S.settings = r;
        S.org.name = org.value.trim() || T('Мой учёт');
        toast(T('Настройки сохранены'));
        route();
      });
    } },
      h('h2', null, T('Общие')), err,
      h('div', { class: 'row' }, field(T('Название компании'), org, T('выбранной сейчас')), field(T('Рабочий Telegram'), tg, T('ссылка появится в верхней панели'))),
      h('div', { class: 'row' }, field(T('Папка для копий архива'), archDir, T('флешка или папка облака')), h('button', { class: 'btn', type: 'button', onclick: (ev) => busy(ev.currentTarget, null, async () => {
        const r = await api('POST', '/api/backups/export');
        toast(T('Архив сохранён: ') + r.file);
      }) }, T('Скопировать сейчас'))),
      h('label', { class: 'check' }, archAuto, h('span', null, h('b', null, T('Копировать архив в эту папку каждый день')), h('div', { class: 'muted small' }, T('Хранятся 14 последних архивов. Архив зашифрован — облако его не прочитает.')))),
      h('label', { class: 'check' }, ratesAuto, h('span', null, h('b', null, T('Загружать официальные курсы ЦБ РФ и ЕЦБ')), h('div', { class: 'muted small' }, T('Раз в день при входе. Наружу уходит только запрос курсов на дату; данные учёта не отправляются.')))),
      h('div', { class: 'row' },
        field(T('Автоблокировка, мин'), idle, T('при бездействии')),
        field(T('Макс. длительность сессии, ч'), maxH),
        field(T('Период закрыт по (включительно)'), closed, T('проводки с датой ≤ этой запрещены'))
      ),
      h('div', { class: 'row' },
        field(T('Минимальная длина пароля'), minLen, T('от 12 до 64')),
        field(T('Выгрузка данных в файлы (CSV, КУДиР)'), expPol, T('каждая выгрузка пишется в журнал аудита'))),
      h('label', { class: 'check' }, dual, h('span', null,
        h('b', null, T('Двойной контроль администраторов')),
        h('div', { class: 'muted small' }, T('Новый администратор, сброс пароля или 2FA сотрудника, снятие прав администратора, открытие закрытого периода, снятие привязки к компьютеру и отключение этого режима выполняются только после подтверждения вторым администратором. Нужны минимум два администратора.'))
      )),
      h('label', { class: 'check' }, req2fa, h('span', null,
        h('b', null, T('Требовать двухфакторную аутентификацию для всех')),
        h('div', { class: 'muted small' }, T('Пользователи без 2FA при следующем запросе будут обязаны подключить её. Включить можно, только если 2FA уже включена у вас.'))
      )),
      h('div', { class: 'actions' }, save)
    ));

    // --- лицензия ---
    body.append(await licenseCard());

    // --- резервные копии ---
    const blist = h('div');
    const bstatus = h('div');
    async function renderBackups(results) {
      const list = await api('GET', '/api/backups');
      const res = new Map((results || []).map((r) => [r.name, r]));
      fill(blist, table([T('Файл'), T('Создана'), { t: T('Размер'), cls: 'num' }, T('Проверка'), ''],
        list.map((b) => {
          const r = res.get(b.name);
          return h('tr', null,
            h('td', { class: 'mono small' }, b.name),
            h('td', { class: 'nowrap' }, ruDateTime(b.createdAt)),
            h('td', { class: 'num' }, TF("{0} КБ", Math.ceil(b.size / 1024)), b.attachments ? h('div', { class: 'muted small' }, TF("+ {0} док.", b.attachments)) : null),
            h('td', null, r ? (r.ok ? h('span', { class: 'badge ok' }, TF("OK: {0} проводок{1}", r.entries, r.attachments ? TF(", {0} док.", r.attachments) : '')) : h('span', { class: 'badge danger', title: r.error || '' }, T('ошибка'))) : h('span', { class: 'muted' }, '—')),
            h('td', null, h('a', { class: 'btn small', href: '/api/backups/archive/' + encodeURIComponent(b.name), download: '', onclick: async (e) => {
              if (S.elevatedUntil > Date.now()) return;
              e.preventDefault();
              const a = e.currentTarget;
              try { await ensureElevated(); } catch { return; }
              a.click();
            }, title: T('Один ZIP-файл: учёт и все документы копии, всё внутри зашифровано') }, T('Скачать архив')))
          );
        }),
        { empty: T('Копий пока нет. Автоматическая копия создаётся раз в сутки при изменениях.') }
      ));
    }
    const mk = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(mk, null, async () => {
      const r = await api('POST', '/api/backups');
      toast(TF("Создана копия {0}", r.name));
      renderBackups();
    }) }, T('Создать копию сейчас'));
    const vf = h('button', { class: 'btn', type: 'button', onclick: () => busy(vf, null, async () => {
      const r = await api('POST', '/api/backups/verify');
      const bad = r.filter((x) => !x.ok).length;
      fill(bstatus, h('div', { class: 'alert ' + (bad ? 'error' : 'ok') }, bad ? TF("Проблемы с {0} из {1} копий", bad, r.length) : TF("Все копии ({0}) целы и расшифровываются", r.length)));
      renderBackups(r);
    }) }, T('Проверить все копии'));
    body.append(h('div', { class: 'card' },
      h('h2', null, T('Резервные копии')),
      h('p', { class: 'muted' }, T('Копия — это тот же зашифрованный файл: без пароля или ключа восстановления она бесполезна. «Скачать архив» сохраняет копию одним ZIP-файлом вместе со всеми документами — его можно хранить на флешке или в облаке. Восстановление: остановите сервер и выполните '), h('span', { class: 'mono' }, T('npm run restore -- <архив.zip>')), '.'),
      h('div', { class: 'actions' }, mk, vf),
      bstatus,
      blist
    ));
    renderBackups();

    // --- синхронизация между компьютерами ---
    if (S.user.role === 'admin') body.append(syncCard());

    // --- ключ восстановления ---
    const rerr = errorBox();
    const rpw = h('input', { type: 'password', autocomplete: 'current-password' });
    const rout = h('div');
    const rsplit = h('input', { type: 'checkbox' });
    const rn = h('select', null, [2, 3, 4, 5].map((v) => h('option', { value: v }, String(v))));
    const rk = h('select', null, [2, 3, 4, 5].map((v) => h('option', { value: v }, String(v))));
    rn.value = '3';
    rk.value = '2';
    const rsplitRow = h('div', { class: 'row' }, field(T('Всего частей'), rn), field(T('Нужно для восстановления'), rk));
    rsplitRow.hidden = true;
    rsplit.addEventListener('change', () => { rsplitRow.hidden = !rsplit.checked; });
    const rbtn = h('button', { class: 'btn danger', type: 'button', onclick: () => busy(rbtn, rerr, async () => {
      if (rsplit.checked && Number(rk.value) > Number(rn.value)) throw new Error(T('Нужных частей не может быть больше, чем всего частей'));
      if (!(await confirmDialog(T('Перевыпустить ключ восстановления?'), T('Старый ключ сразу перестанет действовать. Новый будет показан один раз.'), T('Перевыпустить'), true))) return;
      const r = await api('POST', '/api/recovery-key', { password: rpw.value, ...(rsplit.checked ? { split: { n: Number(rn.value), k: Number(rk.value) } } : {}) });
      rpw.value = '';
      if (r.shares) fill(rout, h('div', { class: 'alert warn' }, T('Новый ключ — частями. Части показываются один раз:')), sharesBlock(r));
      else fill(rout, h('div', { class: 'alert warn' }, T('Новый ключ восстановления — сохраните его офлайн, он больше не будет показан:')), h('div', { class: 'recovery-key' }, r.recoveryKey));
    }) }, T('Перевыпустить ключ'));
    body.append(h('div', { class: 'card' },
      h('h2', null, T('Ключ восстановления')),
      h('p', { class: 'muted' }, T('Если ключ мог попасть к посторонним, перевыпустите его. Нужен ваш текущий пароль.')),
      h('label', { class: 'check' }, rsplit, h('span', null, T('Разделить ключ на части (схема Шамира): например, 3 части у трёх людей, восстановить можно любыми двумя'))),
      rsplitRow,
      rerr, h('div', { class: 'row' }, field(T('Ваш пароль'), rpw), rbtn), rout
    ));
  }

  function viewProfile(body) {
    const pw = h('div');
    body.append(
      h('div', { class: 'card' }, h('dl', { class: 'meta' },
        h('dt', null, T('Логин')), h('dd', { class: 'mono' }, S.user.username),
        h('dt', null, T('Имя')), h('dd', null, S.user.displayName),
        h('dt', null, T('Роль')), h('dd', null, S.roles[S.user.role]),
        h('dt', null, T('Язык интерфейса')), h('dd', null, langSwitch())
      )),
      h('div', { class: 'card' }, h('h2', null, T('Смена пароля')), pw),
      twoFactorCard(),
      passkeyCard(),
      screenLockCard(),
      sessionsCard()
    );
    passwordForm(pw);
  }

  /** О программе: версия, поддержка, политика конфиденциальности, сообщение об уязвимости. */
  async function viewAbout(body) {
    const a = await api('GET', '/api/about');
    const mail = (addr) => (addr ? h('a', { href: 'mailto:' + addr }, addr) : h('span', { class: 'muted' }, T('не указан')));
    body.append(
      h('div', { class: 'card' },
        h('dl', { class: 'meta' },
          h('dt', null, T('Программа')), h('dd', null, a.product + ' ' + a.version),
          h('dt', null, T('Среда')), h('dd', { class: 'mono small' }, 'Node.js ' + a.node),
          h('dt', null, T('Лицензия')), h('dd', null, S.license && S.license.licensee ? S.license.licensee : T('Демо-версия')),
          h('dt', null, T('Поддержка')), h('dd', null, mail(a.supportEmail), a.supportUrl ? [' · ', h('a', { href: a.supportUrl, target: '_blank', rel: 'noopener noreferrer' }, a.supportUrl)] : null),
          h('dt', null, T('Уязвимости')), h('dd', null, mail(a.securityEmail), h('div', { class: 'muted small' }, T('Сообщайте о проблемах безопасности на этот адрес, а не в открытых каналах. Порядок — в файле SECURITY.md.'))))),
      h('div', { class: 'card' },
        h('h2', null, T('Политика конфиденциальности')),
        h('p', null, T('Одем не собирает и не передаёт ваши данные: ни поставщику, ни третьим лицам. В программе нет аналитики, телеметрии, рекламы и автоматических обновлений.')),
        h('ul', null,
          h('li', null, T('Учёт, документы и журналы хранятся только на вашем компьютере (или сервере вашей сети) и зашифрованы. Ключ — пароли пользователей и ключ восстановления; у поставщика его нет.')),
          h('li', null, T('Резервные копии и выгрузки для внешней проверки зашифрованы так же; без пароля или ключа восстановления их не прочитать.')),
          h('li', null, T('В интернет программа обращается только если это включил администратор: загрузка официальных курсов валют (запрашиваются только курсы, данные учёта не передаются) и пересылка журнала в ваш syslog-сервер.')),
          h('li', null, T('Файлы, которые вы выгружаете (CSV, XML, PDF), сохраняются без шифрования — храните их в защищённой папке.'))),
        h('p', { class: 'muted small' }, TF('Сейчас включено: загрузка курсов — {0}; пересылка журнала в syslog — {1}.', a.outbound.rates ? T('да') : T('нет'), a.outbound.syslog ? T('да') : T('нет')))));
  }

  function sessionsCard() {
    const card = h('div', { class: 'card' }, h('h2', null, T('Активные сессии')));
    const load = async () => {
      const list = await api('GET', '/api/me/sessions');
      const others = list.filter((s) => !s.current);
      fill(card,
        h('h2', null, T('Активные сессии '), h('span', { class: 'badge' }, list.length)),
        h('p', { class: 'muted' }, T('Где сейчас открыт вход под вашим именем. Незнакомая сессия — повод завершить её и сменить пароль.')),
        h('div', { class: 'list' }, list.map((s) => h('div', { class: 'li' },
          h('span', null, h('b', null, uaLabel(s.ua)), s.current ? h('span', { class: 'badge ok' }, T(' эта сессия')) : null,
            h('div', { class: 'muted small' }, s.ip, T(' · вход '), ruDateTime(s.createdAt), T(' · активность '), ruDateTime(s.lastSeen))),
          s.current ? null : h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => busy(e.target, null, async () => {
            await api('POST', '/api/me/sessions/' + encodeURIComponent(s.id) + '/end');
            toast(T('Сессия завершена'));
            await load();
          }) }, T('Завершить'))))),
        others.length ? h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.target, null, async () => {
          const r = await api('POST', '/api/me/sessions/end-others');
          toast(T('Завершено сессий: ') + r.ended);
          await load();
        }) }, T('Завершить все остальные'))) : null
      );
    };
    load().catch((e) => card.append(h('div', { class: 'alert error' }, e.message)));
    return card;
  }

  /** Форма привязки Windows Hello: пароль → системное окно Windows → ключ сохранён. */
  function passkeyAddForm(onDone) {
    const err = errorBox();
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const name = h('input', { type: 'text', maxlength: 60, placeholder: T('Например: рабочий ноутбук'), value: 'Windows Hello' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, T('Привязать Windows Hello'));
    return h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        busy(btn, err, async () => {
          const opts = await api('POST', '/api/me/passkey/begin', { password: pw.value });
          pw.value = '';
          const credential = await passkeyCreate(opts);
          const r = await api('POST', '/api/me/passkey/finish', { credential, name: name.value });
          S.user.passkeys = r.passkeys;
          S.user.mustEnroll2fa = false;
          toast(T('Windows Hello привязан — используйте его при следующем входе'));
          await onDone();
        });
      },
    }, err, h('div', { class: 'row' }, field(T('Ваш пароль'), pw), field(T('Название'), name), btn));
  }

  function passkeyCard() {
    const card = h('div', { class: 'card' });
    const render = () => {
      const keys = S.user.passkeys || [];
      const list = keys.length
        ? h('div', { class: 'list' }, keys.map((k) => h('div', { class: 'li' },
          h('span', null, h('b', null, k.name), h('span', { class: 'muted small' }, ' · ', k.rpId, T(' · привязан '), ruDateTime(k.createdAt), k.lastUsedAt ? T(', вход ') + ruDateTime(k.lastUsedAt) : '')),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => remove(k) }, T('Отвязать'))
        )))
        : null;
      fill(card,
        h('h2', null, 'Windows Hello ', keys.length ? h('span', { class: 'badge ok' }, T('привязан')) : h('span', { class: 'badge' }, T('не привязан'))),
        h('p', { class: 'muted' }, T('Второй фактор без телефона: после пароля Windows спросит отпечаток, лицо или PIN-код. Ключ хранится в защищённом модуле компьютера и не покидает его.')),
        list,
        passkeySupported()
          ? passkeyAddForm(async () => render())
          : h('div', { class: 'alert info' }, T('Windows Hello работает только по адресу '), h('a', { href: localhostUrl() }, localhostUrl()), T(' — откройте приложение по нему.'))
      );
    };
    const remove = (k) => {
      const err = errorBox();
      const pw = h('input', { type: 'password', autocomplete: 'current-password' });
      const ok = h('button', { class: 'btn danger', type: 'button' }, T('Отвязать'));
      const dlg = dialog(T('Отвязать «') + k.name + '»?', h('div', null, h('p', { class: 'muted' }, T('Этим ключом больше нельзя будет подтвердить вход.')), err, field(T('Ваш пароль'), pw)), ok);
      ok.onclick = () => busy(ok, err, async () => {
        const r = await api('POST', '/api/me/passkey/delete', { id: k.id, password: pw.value });
        S.user.passkeys = r.passkeys;
        dlg.close();
        toast(T('Ключ отвязан'));
        render();
      });
      pw.focus();
    };
    render();
    return card;
  }

  function twoFactorCard() {
    const card = h('div', { class: 'card' });
    const render = () => {
      if (!S.user.twoFactor) {
        const box = h('div');
        fill(card,
          h('h2', null, T('Двухфакторная аутентификация '), h('span', { class: 'badge' }, T('выключена'))),
          h('div', { class: 'twofa-intro' },
            h('img', { src: 'img/twofa.webp', alt: '', width: 132, height: 132, loading: 'lazy', decoding: 'async' }),
            h('p', null, T('Помимо пароля при входе потребуется 6-значный код с телефона. Украденного пароля станет недостаточно.'))
          ),
          box
        );
        twoFactorSetup(box, async () => render());
        return;
      }
      const err = errorBox();
      const pw = h('input', { type: 'password', autocomplete: 'current-password' });
      const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, class: 'mono otp', placeholder: '000000' });
      const off = h('button', { class: 'btn danger', type: 'submit' }, T('Отключить 2FA'));
      fill(card,
        h('h2', null, T('Двухфакторная аутентификация '), h('span', { class: 'badge ok' }, T('включена'))),
        h('p', { class: 'muted' }, T('При входе запрашивается код из приложения-аутентификатора. Если потеряете телефон — обратитесь к администратору; администратор может восстановить доступ ключом восстановления.')),
        S.settings.require2fa
          ? h('div', { class: 'alert info' }, T('Администратор требует 2FA для всех — отключить её нельзя.'))
          : h('form', {
            onsubmit: (e) => {
              e.preventDefault();
              busy(off, err, async () => {
                if (!(await confirmDialog(T('Отключить 2FA?'), T('Вход снова будет защищён только паролем.'), T('Отключить'), true))) return;
                await api('POST', '/api/me/2fa/disable', { password: pw.value, code: code.value });
                S.user.twoFactor = false;
                toast(T('2FA отключена'));
                render();
              });
            },
          }, err, h('div', { class: 'row' }, field(T('Ваш пароль'), pw), h('label', { class: 'field narrow' }, h('span', null, T('Код из приложения')), code), off))
      );
    };
    render();
    return card;
  }

  // ======================= Запуск =======================

  async function boot() {
    let st;
    try {
      st = await api('GET', '/api/status');
    } catch (e) {
      fill(app, authCard(false, h('div', { class: 'alert error' }, e.message)));
      return;
    }
    setupCatalog = st.catalog || null;
    if (st.setupRequired) return renderSetup();
    try {
      const s = await api('GET', '/api/session');
      await onLoggedIn(s);
    } catch {
      renderLogin();
    }
  }

  buildSanctum();
  boot();
})();
