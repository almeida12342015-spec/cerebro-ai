/* Relógio Double — frontend pt-BR */
(function () {
  const state = {
    user: null,
    token: localStorage.getItem('rd_token') || null,
    liveTimer: null,
    dashTab: 'live',
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function views() {
    return ['landing', 'login', 'register', 'paywall', 'dashboard'];
  }

  function show(view) {
    views().forEach((v) => {
      const el = $(`#view-${v}`);
      if (el) el.classList.toggle('hidden', v !== view);
    });
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { ...opts, headers, credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function renderNav() {
    const nav = $('#nav-actions');
    if (!state.user) {
      nav.innerHTML = `
        <button class="btn btn-ghost" data-goto="login">Entrar</button>
        <button class="btn btn-primary" data-goto="register">Criar conta</button>`;
      return;
    }
    nav.innerHTML = `
      <span class="badge">${state.user.email}${state.user.role === 'admin' ? ' · admin' : ''}</span>
      ${state.user.paid || state.user.role === 'admin' ? '<button class="btn btn-primary" data-goto="dashboard">Dashboard</button>' : '<button class="btn" data-goto="paywall">Assinar</button>'}
      <button class="btn btn-ghost" id="btn-logout">Sair</button>`;
    $('#btn-logout')?.addEventListener('click', logout);
  }

  async function refreshMe() {
    if (!state.token) {
      state.user = null;
      return null;
    }
    try {
      const me = await api('/api/auth/me');
      state.user = me;
      return me;
    } catch {
      state.user = null;
      state.token = null;
      localStorage.removeItem('rd_token');
      return null;
    }
  }

  async function routeTo(name) {
    if (name === 'dashboard' || name === 'paywall') {
      await refreshMe();
      if (!state.user) return routeTo('login');
      if (name === 'dashboard') {
        if (!(state.user.paid || state.user.role === 'admin')) return routeTo('paywall');
        show('dashboard');
        setupDashTabs();
        startLive();
        return;
      }
    }
    if (name === 'landing' || name === 'login' || name === 'register') stopLive();
    show(name);
    renderNav();
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.token = null;
    state.user = null;
    localStorage.removeItem('rd_token');
    stopLive();
    renderNav();
    show('landing');
  }

  function bindAuthForms() {
    $('#form-login')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = $('#login-error');
      err.classList.add('hidden');
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
        });
        state.token = data.token;
        localStorage.setItem('rd_token', data.token);
        state.user = data.user;
        renderNav();
        await routeTo(data.user.paid || data.user.role === 'admin' ? 'dashboard' : 'paywall');
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });

    $('#form-register')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const err = $('#register-error');
      err.classList.add('hidden');
      try {
        const data = await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
        });
        state.token = data.token;
        localStorage.setItem('rd_token', data.token);
        state.user = data.user;
        renderNav();
        await routeTo('paywall');
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });
  }

  function bindCheckout() {
    $('#btn-checkout')?.addEventListener('click', async () => {
      const box = $('#checkout-result');
      const status = $('#checkout-status');
      box.classList.remove('hidden');
      status.textContent = 'Gerando cobrança PIX…';
      try {
        const data = await api('/api/payments/checkout', { method: 'POST', body: '{}' });
        const p = data.payment;
        if (p.stub) {
          status.innerHTML = `<strong>Modo stub:</strong> MERCADOPAGO_ACCESS_TOKEN não configurado.
            Peça ao admin para liberar dias manualmente, ou configure o token e reinicie.`;
          $('#qr-wrap').classList.add('hidden');
          $('#pix-copy').textContent = p.pix_qr_code || '';
        } else {
          status.textContent = `Pagamento ${p.status}. Escaneie o QR ou copie o código PIX. Após a confirmação (webhook), +30 dias.`;
          if (p.pix_qr_base64) {
            $('#qr-wrap').classList.remove('hidden');
            $('#qr-img').src = `data:image/png;base64,${p.pix_qr_base64}`;
          } else {
            $('#qr-wrap').classList.add('hidden');
          }
          $('#pix-copy').textContent = p.pix_qr_code || '';
        }
      } catch (ex) {
        status.textContent = ex.message;
      }
    });
  }

  function setupDashTabs() {
    const isAdmin = state.user?.role === 'admin';
    const tabAdmin = $('#tab-admin');
    if (tabAdmin) {
      tabAdmin.classList.toggle('hidden', !isAdmin);
      // fix duplicate class attribute from HTML — ensure visible for admin
      if (isAdmin) tabAdmin.classList.remove('hidden');
    }
    $$('[data-dash]').forEach((btn) => {
      btn.onclick = () => {
        state.dashTab = btn.getAttribute('data-dash');
        $$('[data-dash]').forEach((b) => b.classList.toggle('active', b === btn));
        $('#dash-live').classList.toggle('hidden', state.dashTab !== 'live');
        $('#dash-gale').classList.toggle('hidden', state.dashTab !== 'gale');
        $('#dash-admin').classList.toggle('hidden', state.dashTab !== 'admin');
        if (state.dashTab === 'admin') loadAdmin();
      };
    });
  }

  function colorLabel(c) {
    return { red: 'Vermelho', black: 'Preto', white: 'Branco' }[c] || c;
  }

  function renderLive(data) {
    const pred = data.prediction;
    const dot = $('#pred-dot');
    dot.className = `dot ${pred.color}`;
    $('#pred-color').textContent = colorLabel(pred.color);
    $('#pred-conf').textContent = `${(pred.confidence * 100).toFixed(1)}%`;
    $('#pred-model').textContent = pred.modelType;

    const acc = data.accuracy;
    $('#acc-pct').textContent = acc.total ? `${(acc.accuracy * 100).toFixed(1)}%` : '—';
    $('#acc-n').textContent = String(acc.total || 0);
    $('#rounds-n').textContent = String(data.collector?.rounds_collected ?? data.colors?.length ?? 0);

    const strip = $('#color-strip');
    strip.innerHTML = data.colors
      .slice(0, 48)
      .map((r) => `<div class="dot ${r.color}" title="${r.roll} · ${r.created_at}"></div>`)
      .join('');

    // confidence table from recent predictions embedded via second call — use gale history + colors
    // We store last fetch
    state.lastLive = data;

    const gale = data.gale;
    $('#gale-bank').textContent = `R$ ${Number(gale.bank).toFixed(2)}`;
    $('#gale-w').textContent = String(gale.wins);
    $('#gale-l').textContent = String(gale.losses);
    const st = gale.stakes;
    $('#gale-stakes').textContent = `${st.g0.toFixed(0)}/${st.g1.toFixed(0)}/${st.g2.toFixed(0)}`;

    const gt = $('#gale-table tbody');
    gt.innerHTML = (gale.history || [])
      .slice()
      .reverse()
      .map(
        (h) => `<tr>
        <td>${h.roundIndex}</td><td>G${h.galeLevel}</td><td>${h.stake.toFixed(2)}</td>
        <td>${colorLabel(h.predicted)}</td><td>${colorLabel(h.actual)}</td>
        <td>${h.result}</td><td>${(h.confidence * 100).toFixed(1)}%</td>
        <td>${h.bankAfter.toFixed(2)}</td></tr>`
      )
      .join('');
  }

  async function loadStatsTable() {
    try {
      const data = await api('/api/dashboard/stats');
      const tb = $('#pred-table tbody');
      tb.innerHTML = (data.recent || [])
        .map(
          (p) => `<tr>
          <td>${colorLabel(p.predicted_color)}</td>
          <td>${p.actual_color ? colorLabel(p.actual_color) : '—'}</td>
          <td>${(p.confidence * 100).toFixed(1)}%</td>
          <td>${p.correct == null ? '—' : p.correct ? '✅' : '❌'}</td>
          <td>${p.model_type}</td></tr>`
        )
        .join('');
    } catch {
      /* ignore */
    }
  }

  async function tickLive() {
    try {
      const data = await api('/api/dashboard/live');
      renderLive(data);
      await loadStatsTable();
    } catch (ex) {
      if (ex.status === 402) {
        stopLive();
        routeTo('paywall');
      }
    }
  }

  function startLive() {
    stopLive();
    tickLive();
    state.liveTimer = setInterval(tickLive, 5000);
  }

  function stopLive() {
    if (state.liveTimer) clearInterval(state.liveTimer);
    state.liveTimer = null;
  }

  async function loadAdmin() {
    try {
      const [overview, users, pays, collector] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/users'),
        api('/api/admin/payments'),
        api('/api/admin/collector'),
      ]);
      $('#admin-overview').textContent = JSON.stringify(overview, null, 2);
      $('#admin-collector').textContent = JSON.stringify(collector, null, 2);
      const ut = $('#admin-users tbody');
      ut.innerHTML = users.users
        .map(
          (u) => `<tr>
          <td>${u.email}</td><td>${u.role}</td><td>${u.paid_until || '—'}</td>
          <td>
            ${u.role !== 'admin' ? `<button class="btn" data-grant="${u.id}">+30d</button>
            <button class="btn btn-danger" data-revoke="${u.id}">Revogar</button>` : '—'}
          </td></tr>`
        )
        .join('');
      ut.querySelectorAll('[data-grant]').forEach((btn) => {
        btn.onclick = async () => {
          await api(`/api/admin/users/${btn.getAttribute('data-grant')}/grant`, {
            method: 'POST',
            body: JSON.stringify({ days: 30 }),
          });
          loadAdmin();
        };
      });
      ut.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.onclick = async () => {
          await api(`/api/admin/users/${btn.getAttribute('data-revoke')}/revoke`, { method: 'POST', body: '{}' });
          loadAdmin();
        };
      });
      const pt = $('#admin-payments tbody');
      pt.innerHTML = pays.payments
        .map(
          (p) => `<tr>
          <td class="mono">${p.id.slice(0, 8)}…</td>
          <td class="mono">${p.user_id.slice(0, 8)}…</td>
          <td>${p.status}</td>
          <td>R$ ${(p.amount_cents / 100).toFixed(2)}</td>
          <td>${p.created_at}</td></tr>`
        )
        .join('');
    } catch (ex) {
      $('#admin-overview').textContent = ex.message;
    }
  }

  function bindGoto() {
    document.body.addEventListener('click', (e) => {
      const t = e.target.closest('[data-goto]');
      if (!t) return;
      e.preventDefault();
      routeTo(t.getAttribute('data-goto'));
    });
  }

  async function boot() {
    bindGoto();
    bindAuthForms();
    bindCheckout();
    await refreshMe();
    renderNav();
    if (state.user && (state.user.paid || state.user.role === 'admin')) {
      routeTo('dashboard');
    } else if (state.user) {
      routeTo('paywall');
    } else {
      show('landing');
    }
  }

  boot();
})();
