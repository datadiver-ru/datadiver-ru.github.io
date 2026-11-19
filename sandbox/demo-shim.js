'use strict';
// Демо «Одем» без сервера: запросы к /api получают записанные ответы (вымышленные данные),
// любые изменения отклоняются. Подключается только в статическом демо (npm run demo).
(() => {
  const DATA = window.ODEM_DEMO || {};
  const KEEP = ['account', 'counterparty', 'kind', 'user', 'year', 'days'];
  const realFetch = window.fetch.bind(window);
  let en = false;
  try {
    const v = localStorage.getItem('odem.lang');
    en = v ? v === 'en' : !/^(ru|be|kk|uk)\b/i.test(navigator.language || 'ru');
  } catch { /* язык по умолчанию */ }
  const MSG = {
    write: en
      ? 'The demo is read-only: the data is fictional and nothing is saved. Install Odem to keep your own books.'
      : 'В демо-версии запись недоступна: данные вымышленные и не сохраняются. Установите Одем, чтобы вести свой учёт.',
    missing: en ? 'This section is not available in the demo.' : 'В демо этот раздел недоступен.',
    file: en ? 'Files, printing and exports are not available in the demo.' : 'Файлы, печать и выгрузки в демо недоступны.',
    banner: en ? 'Demo · fictional data · read-only' : 'Демо · данные вымышленные · запись отключена',
  };
  const json = (status, obj) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }));

  function keyOf(u) {
    const q = [...u.searchParams].filter(([k]) => KEEP.includes(k)).sort();
    return u.pathname.slice(u.pathname.indexOf('/api/')) + (q.length ? '?' + q.map(([k, v]) => `${k}=${v}`).join('&') : '');
  }

  window.fetch = (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.includes('/api/')) return realFetch(input, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const path = url.pathname.slice(url.pathname.indexOf('/api/'));
    if (method === 'GET') {
      const key = 'GET ' + keyOf(url);
      if (key in DATA) return json(200, DATA[key]);
      // Следующие страницы списков пустые; прочие запросы — ответ без отборов по датам.
      if (Number(url.searchParams.get('offset')) > 0) return json(200, { items: [], total: 0, offset: 0, limit: 100, users: [] });
      const byPath = Object.keys(DATA).find((k) => k === 'GET ' + path || k.startsWith('GET ' + path + '?'));
      if (byPath) return json(200, DATA[byPath]);
      return json(404, { error: MSG.missing });
    }
    if (path === '/api/login' || path === '/api/login/2fa') return json(200, DATA['POST /api/login'] || DATA['GET /api/session']);
    if (path === '/api/logout' || path === '/api/ping') return json(200, { ok: true });
    if (path === '/api/me/elevate') return json(200, { ok: true, ttl: 300000 });
    return json(403, { error: MSG.write });
  };

  function note(text) {
    const t = document.createElement('div');
    t.className = 'toast error';
    t.textContent = text;
    (document.getElementById('toasts') || document.body).append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // Ссылки на файлы, печать и выгрузки ведут на сервер, которого в демо нет.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href*="/api/"]');
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    note(MSG.file);
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = MSG.banner;
    b.setAttribute('role', 'note');
    b.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:9999;padding:6px 14px;border-radius:999px;' +
      'background:rgba(110,10,36,.92);color:#fff;font:12.5px/1.3 "Segoe UI",system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:none';
    document.body.append(b);
  });
})();
