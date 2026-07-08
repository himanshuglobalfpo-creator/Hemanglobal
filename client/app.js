/* LedgerLite client — dependency-free hash-router SPA.
 * Minimal wiring for every server feature: two-step MFA login, invoices/bills
 * with paperclip attachments, FX settings, reports + CSV, budgets, imports,
 * webhooks, audit page. */
(() => {
  "use strict";
  const app = document.getElementById("app");
  let me = null; // { userId, email, role, orgName, baseCurrency, totpEnabled }

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (cents, cur) => {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: cur || (me && me.baseCurrency) || "USD" }).format(cents / 100); }
    catch { return ((cents / 100).toFixed(2)) + " " + cur; }
  };
  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: opts.body && !(opts.raw) ? { "Content-Type": "application/json" } : (opts.headers || {}), ...opts, body: opts.raw ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined) });
    const isJson = (res.headers.get("content-type") || "").includes("json");
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (data && data.error) ? data.error + (data.issues ? "\n" + data.issues.join("\n") : "") : "request failed (" + res.status + ")";
      const err = new Error(msg); err.code = data && data.code; err.status = res.status; throw err;
    }
    return data;
  }
  const qs = (sel) => document.querySelector(sel);
  const val = (sel) => qs(sel) ? qs(sel).value.trim() : "";
  const showErr = (e) => { const el = qs("#err"); if (el) el.textContent = e.message || String(e); };

  /* ---------------- shell ---------------- */
  const NAV = [
    ["#/dashboard", "Dashboard"], ["#/customers", "Customers"], ["#/vendors", "Vendors"],
    ["#/invoices", "Invoices"], ["#/bills", "Bills"], ["#/reports", "Reports"],
    ["#/budgets", "Budgets"], ["#/import", "Import"], ["#/audit", "Audit"], ["#/settings", "Settings"],
  ];
  function shell(content) {
    const canAudit = me && ["owner", "admin", "accountant"].includes(me.role);
    app.innerHTML = `
      <nav><span class="brand">LedgerLite</span>
        ${NAV.filter(([h]) => h !== "#/audit" || canAudit).map(([h, label]) => `<a href="${h}" class="${location.hash.startsWith(h) ? "active" : ""}">${label}</a>`).join("")}
        <span class="spacer"></span>
        <span class="muted" style="color:#9db8d6">${esc(me.email)} · ${esc(me.orgName)} (${esc(me.baseCurrency)}) · ${esc(me.role)}</span>
        <button class="ghost" id="logout">Log out</button>
      </nav><main>${content}</main>`;
    qs("#logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); me = null; location.hash = "#/login"; };
  }

  /* ---------------- auth pages ---------------- */
  function loginPage() {
    app.innerHTML = `<div class="card login-box"><h1>LedgerLite</h1>
      <div class="row"><input id="email" placeholder="Email" style="flex:1"></div>
      <div class="row"><input id="password" type="password" placeholder="Password" style="flex:1"></div>
      <div class="err" id="err"></div>
      <div class="row"><button id="login">Log in</button><button class="ghost" id="toRegister">Create account</button></div></div>`;
    qs("#login").onclick = async () => {
      try {
        const r = await api("/api/auth/login", { method: "POST", body: { email: val("#email"), password: val("#password") } });
        if (r.mfaRequired) return mfaPage(r.mfaToken);
        await loadMe(); location.hash = "#/dashboard";
      } catch (e) { showErr(e); }
    };
    qs("#toRegister").onclick = () => registerPage();
  }

  function mfaPage(mfaToken) {
    app.innerHTML = `<div class="card login-box"><h1>Two-step verification</h1>
      <p class="muted">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
      <div class="row"><input id="code" placeholder="123456" maxlength="6" style="flex:1"></div>
      <div class="row"><input id="recovery" placeholder="or recovery code" style="flex:1"></div>
      <div class="err" id="err"></div>
      <div class="row"><button id="verify">Verify</button></div></div>`;
    qs("#verify").onclick = async () => {
      try {
        const body = { mfaToken };
        if (val("#code")) body.code = val("#code"); else body.recoveryCode = val("#recovery");
        await api("/api/auth/mfa/verify", { method: "POST", body });
        await loadMe(); location.hash = "#/dashboard";
      } catch (e) { showErr(e); }
    };
  }

  function registerPage() {
    app.innerHTML = `<div class="card login-box"><h1>Create your org</h1>
      <div class="row"><input id="name" placeholder="Your name" style="flex:1"></div>
      <div class="row"><input id="email" placeholder="Email" style="flex:1"></div>
      <div class="row"><input id="password" type="password" placeholder="Password (min 8)" style="flex:1"></div>
      <div class="row"><input id="orgName" placeholder="Organization name" style="flex:1"></div>
      <div class="row"><label>Base currency <select id="baseCurrency">${["USD","EUR","GBP","INR","CAD","AUD","JPY"].map((c) => `<option>${c}</option>`).join("")}</select></label></div>
      <div class="err" id="err"></div>
      <div class="row"><button id="register">Create</button><button class="ghost" id="toLogin">Back to login</button></div></div>`;
    qs("#register").onclick = async () => {
      try {
        await api("/api/auth/register", { method: "POST", body: { name: val("#name"), email: val("#email"), password: qs("#password").value, orgName: val("#orgName"), baseCurrency: val("#baseCurrency") } });
        await loadMe(); location.hash = "#/dashboard";
      } catch (e) { showErr(e); }
    };
    qs("#toLogin").onclick = () => loginPage();
  }

  /* ---------------- pages ---------------- */
  async function dashboardPage() {
    const tb = await api("/api/reports/trial-balance");
    shell(`<h1>Dashboard</h1><div class="card"><h2>Trial balance</h2>
      <table><thead><tr><th>Code</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${tb.filter((r) => r.debit || r.credit).map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${money(r.debit)}</td><td class="num">${money(r.credit)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No postings yet</td></tr>`}</tbody>
      <tfoot><tr><th></th><th>Total</th><th class="num">${money(tb.reduce((s, r) => s + r.debit, 0))}</th><th class="num">${money(tb.reduce((s, r) => s + r.credit, 0))}</th></tr></tfoot></table>
      <p class="muted">GL is 100% ${esc(me.baseCurrency)} (base currency); foreign documents carry their own currency.</p></div>`);
  }

  async function partiesPage(kind) {
    const rows = await api(`/api/${kind}`);
    const label = kind === "customers" ? "Customer" : "Vendor";
    shell(`<h1>${label}s</h1>
      <div class="card"><h2>New ${label.toLowerCase()}</h2>
        <div class="row"><input id="pname" placeholder="Name"><input id="pemail" placeholder="Email">
          <select id="pcur"><option value="">${esc(me.baseCurrency)} (base)</option>${["EUR","GBP","USD","INR","CAD","AUD","JPY"].filter((c) => c !== me.baseCurrency).map((c) => `<option>${c}</option>`).join("")}</select>
          <button id="padd">Add</button></div><div class="err" id="err"></div></div>
      <div class="card"><table><thead><tr><th>Name</th><th>Email</th><th>Currency</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email || "")}</td><td>${esc(r.currency || me.baseCurrency)}</td>
        <td>${kind === "customers" ? `<a href="/api/customers/${r.id}/statement" target="_blank">statement</a>` : ""}</td></tr>`).join("")}</tbody></table></div>`);
    qs("#padd").onclick = async () => {
      try { await api(`/api/${kind}`, { method: "POST", body: { name: val("#pname"), email: val("#pemail") || null, currency: val("#pcur") || null } }); route(); }
      catch (e) { showErr(e); }
    };
  }

  async function docsPage(kind) {
    const isInv = kind === "invoices";
    const [docs, parties, accounts] = await Promise.all([
      api(`/api/${kind}?pageSize=50`), api(isInv ? "/api/customers" : "/api/vendors"), api("/api/accounts"),
    ]);
    const partyKey = isInv ? "customer" : "vendor";
    const lineAccounts = accounts.filter((a) => (isInv ? a.type === "income" : a.type === "expense"));
    shell(`<h1>${isInv ? "Invoices" : "Bills"}</h1>
      <div class="card"><h2>New ${isInv ? "invoice" : "bill"}</h2>
        <div class="row">
          <select id="dparty">${parties.map((p) => `<option value="${p.id}" data-cur="${esc(p.currency || "")}">${esc(p.name)}${p.currency ? " (" + p.currency + ")" : ""}</option>`).join("")}</select>
          <input id="ddate" type="date" value="${new Date().toISOString().slice(0, 10)}">
          <input id="ddue" type="date" value="${new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)}">
          <input id="dfx" type="number" step="0.0001" placeholder="FX rate (foreign only)" style="width:170px">
        </div>
        <div class="row">
          <input id="ldesc" placeholder="Description" style="flex:1">
          <input id="lqty" type="number" value="1" style="width:80px">
          <input id="lrate" type="number" step="0.01" placeholder="Rate" style="width:110px">
          <select id="lacct">${lineAccounts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join("")}</select>
          <input id="ltax" type="number" value="0" step="0.1" style="width:70px" title="Tax %">
          <button id="dcreate">Create</button>
        </div><div class="err" id="err"></div></div>
      <div class="card"><table><thead><tr><th>Number</th><th>${partyKey}</th><th>Date</th><th>Currency</th><th class="num">Total</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead>
      <tbody id="doclist">${docs.rows.map((d) => {
        const cur = d.currency || me.baseCurrency; const foreign = !!d.currency;
        return `<tr><td>${esc(d.number)}</td><td>${esc(d[partyKey + "_name"])}</td><td>${esc(d.date)}</td><td>${esc(cur)}</td>
          <td class="num">${money(foreign ? d.foreign_total : d.total, cur)}${foreign ? `<div class="muted">${money(d.total)} base @ ${d.fx_rate}</div>` : ""}</td>
          <td class="num">${money(foreign ? d.foreign_amount_paid : d.amount_paid, cur)}</td>
          <td><span class="badge ${esc(d.status)}">${esc(d.status)}</span></td>
          <td>${d.status !== "paid" && d.status !== "void" ? `<button class="ghost" data-pay="${d.id}" data-cur="${esc(d.currency)}">Pay</button>` : ""}
              ${isInv ? `<a href="/api/invoices/${d.id}/document" target="_blank">doc</a>` : ""}
              <button class="ghost" data-clip="${d.id}">📎</button></td></tr>
          <tr id="clip-${d.id}" style="display:none"><td colspan="8"><div class="paperclip" id="clipbody-${d.id}">loading…</div></td></tr>`;
      }).join("")}</tbody></table><p class="muted">${docs.total} total</p></div>`);

    qs("#dcreate").onclick = async () => {
      try {
        const sel = qs("#dparty"); const opt = sel.options[sel.selectedIndex];
        const foreignCur = opt ? opt.getAttribute("data-cur") : "";
        const body = {
          [isInv ? "customerId" : "vendorId"]: Number(sel.value), date: val("#ddate"), dueDate: val("#ddue"),
          lines: [{ description: val("#ldesc") || "Item", quantity: Number(val("#lqty")) || 1, rate: Math.round(Number(val("#lrate")) * 100), accountId: Number(val("#lacct")), taxRate: Number(val("#ltax")) || 0 }],
        };
        if (foreignCur) { body.currency = foreignCur; if (val("#dfx")) body.fxRate = Number(val("#dfx")); }
        await api(`/api/${kind}`, { method: "POST", body }); route();
      } catch (e) { showErr(e); }
    };
    qs("#doclist").onclick = async (ev) => {
      const payId = ev.target.getAttribute && ev.target.getAttribute("data-pay");
      const clipId = ev.target.getAttribute && ev.target.getAttribute("data-clip");
      if (payId) {
        const cur = ev.target.getAttribute("data-cur");
        try {
          const body = { date: new Date().toISOString().slice(0, 10), bankAccountId: accounts.find((a) => a.subtype === "bank").id };
          if (cur) {
            const amt = prompt(`Amount in ${cur} (e.g. 100.00):`); if (amt === null) return;
            const rate = prompt("FX rate at payment date:"); if (rate === null) return;
            body.foreignAmount = Math.round(Number(amt) * 100); body.fxRate = Number(rate);
          } else {
            const amt = prompt(`Amount in ${me.baseCurrency} (e.g. 100.00):`); if (amt === null) return;
            body.amount = Math.round(Number(amt) * 100);
          }
          await api(`/api/${kind}/${payId}/pay`, { method: "POST", body }); route();
        } catch (e) { alert(e.message); }
      }
      if (clipId) toggleClip(isInv ? "invoice" : "bill", Number(clipId));
    };
  }

  /* TASK 3: paperclip section */
  async function toggleClip(entityType, entityId) {
    const rowEl = qs(`#clip-${entityId}`); const body = qs(`#clipbody-${entityId}`);
    if (rowEl.style.display !== "none") { rowEl.style.display = "none"; return; }
    rowEl.style.display = "";
    const render = async () => {
      const files = await api(`/api/attachments?entityType=${entityType}&entityId=${entityId}`);
      body.innerHTML = `<strong>📎 Attachments</strong>
        <ul>${files.map((f) => `<li><a href="/api/attachments/${f.id}/download">${esc(f.filename)}</a> <span class="muted">${(f.size_bytes / 1024).toFixed(1)} KB</span>
          <button class="ghost" data-del="${f.id}">✕</button></li>`).join("") || "<li class='muted'>none</li>"}</ul>
        <input type="file" id="file-${entityId}" accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx"> <button class="ghost" id="up-${entityId}">Upload</button>`;
      body.querySelector(`#up-${entityId}`).onclick = async () => {
        const input = body.querySelector(`#file-${entityId}`); const file = input.files[0];
        if (!file) return alert("choose a file");
        const res = await fetch(`/api/attachments?entityType=${entityType}&entityId=${entityId}&filename=${encodeURIComponent(file.name)}`, {
          method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); return alert(d.error || "upload failed"); }
        render();
      };
      body.onclick = async (ev) => {
        const del = ev.target.getAttribute && ev.target.getAttribute("data-del");
        if (del) { await api(`/api/attachments/${del}`, { method: "DELETE" }); render(); }
      };
    };
    render();
  }

  async function reportsPage() {
    const budgets = await api("/api/budgets");
    const now = new Date(); const y = now.getFullYear();
    const links = [
      ["Trial balance", `/api/reports/trial-balance`],
      ["Sales by customer", `/api/reports/sales-by-customer?from=${y}-01-01&to=${y}-12-31`],
      ["Expenses by vendor", `/api/reports/expenses-by-vendor?from=${y}-01-01&to=${y}-12-31`],
      ["P&L by month", `/api/reports/profit-loss-monthly?from=${y}-01-01&to=${y}-12-31`],
      ...budgets.map((b) => [`Budget vs actual — ${b.name}`, `/api/reports/budget-vs-actual?budgetId=${b.id}`]),
    ];
    shell(`<h1>Reports</h1><div class="card"><table><thead><tr><th>Report</th><th>View</th><th>Export</th></tr></thead>
      <tbody>${links.map(([name, url]) => `<tr><td>${esc(name)}</td><td><a href="${url}" target="_blank">JSON</a></td>
        <td><a href="${url}${url.includes("?") ? "&" : "?"}format=csv">CSV</a></td></tr>`).join("")}</tbody></table>
      <p class="muted">Every report accepts ?from=&to= (YYYY-MM-DD) and ?format=csv.</p></div>`);
  }

  async function budgetsPage() {
    const [budgets, accounts] = await Promise.all([api("/api/budgets"), api("/api/accounts")]);
    const plAccounts = accounts.filter((a) => a.type === "income" || a.type === "expense");
    shell(`<h1>Budgets</h1>
      <div class="card"><h2>New budget</h2><div class="row">
        <input id="bname" placeholder="Name"><input id="byear" type="number" value="${new Date().getFullYear()}" style="width:100px">
        <button id="badd">Create</button></div><div class="err" id="err"></div></div>
      <div class="card"><table><thead><tr><th>Name</th><th>Fiscal year</th><th></th></tr></thead>
        <tbody>${budgets.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.fiscal_year}</td>
          <td><button class="ghost" data-line="${b.id}">Set line</button>
              <a href="/api/reports/budget-vs-actual?budgetId=${b.id}&format=csv">vs actual CSV</a>
              <button class="danger" data-del="${b.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`);
    qs("#badd").onclick = async () => {
      try { await api("/api/budgets", { method: "POST", body: { name: val("#bname"), fiscalYear: Number(val("#byear")) } }); route(); }
      catch (e) { showErr(e); }
    };
    app.onclick = async (ev) => {
      const lineId = ev.target.getAttribute && ev.target.getAttribute("data-line");
      const delId = ev.target.getAttribute && ev.target.getAttribute("data-del");
      if (delId) { if (confirm("Delete budget?")) { await api(`/api/budgets/${delId}`, { method: "DELETE" }); route(); } }
      if (lineId) {
        const code = prompt("Account code (income/expense), e.g. 4000:\n" + plAccounts.map((a) => a.code + " " + a.name).join(", "));
        if (!code) return;
        const acct = plAccounts.find((a) => a.code === code.trim());
        if (!acct) return alert("unknown code");
        const monthly = prompt("Monthly amount in " + me.baseCurrency + " (applied to all 12 months):");
        if (monthly === null) return;
        const cents = Math.round(Number(monthly) * 100);
        const existing = await api(`/api/budgets/${lineId}`);
        const keep = existing.lines.filter((l) => l.account_id !== acct.id).map((l) => ({ accountId: l.account_id, month: l.month, amount: l.amount }));
        const lines = keep.concat(Array.from({ length: 12 }, (_, i) => ({ accountId: acct.id, month: i + 1, amount: cents })));
        await api(`/api/budgets/${lineId}/lines`, { method: "PUT", body: { lines } });
        alert("saved");
      }
    };
  }

  async function importPage() {
    const targets = [
      ["customers", "name,email,phone,address,shipping_city,shipping_state,shipping_zip"],
      ["vendors", "name,email,phone,address,shipping_city,shipping_state,shipping_zip"],
      ["chart-of-accounts", "code,name,type,subtype"],
      ["invoices", "number,customer_name,date,due_date,line_description,quantity,rate,income_account_code,tax_rate"],
      ["opening-balances", "account_code,debit,credit"],
    ];
    shell(`<h1>Data import</h1><div class="card">
      <div class="row">
        <select id="itarget">${targets.map(([t]) => `<option>${t}</option>`).join("")}</select>
        <input id="iasof" type="date" value="${new Date().toISOString().slice(0, 10)}" title="asOfDate (opening balances)">
        <label><input type="checkbox" id="idry" checked> dry run</label>
        <label><input type="checkbox" id="ipartial"> partial (invoices)</label>
      </div>
      <p class="muted" id="icols">${targets[0][1]}</p>
      <textarea id="icsv" rows="10" style="width:100%" placeholder="Paste CSV here (first row = header)"></textarea>
      <div class="row" style="margin-top:10px"><button id="irun">Import</button></div>
      <pre id="iout" class="muted"></pre></div>`);
    qs("#itarget").onchange = () => { qs("#icols").textContent = targets.find(([t]) => t === val("#itarget"))[1]; };
    qs("#irun").onclick = async () => {
      const target = val("#itarget");
      const params = new URLSearchParams();
      if (qs("#idry").checked) params.set("dryRun", "true");
      if (qs("#ipartial").checked) params.set("partial", "true");
      if (target === "opening-balances") params.set("asOfDate", val("#iasof"));
      try {
        const res = await fetch(`/api/import/${target}?${params}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: qs("#icsv").value });
        qs("#iout").textContent = JSON.stringify(await res.json(), null, 2);
      } catch (e) { qs("#iout").textContent = e.message; }
    };
  }

  async function auditPage() {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const page = Number(params.get("page") || 1);
    const filters = ["action", "entityType", "q", "from", "to"].map((k) => [k, params.get(k) || ""]);
    const query = new URLSearchParams({ page: String(page), pageSize: "50" });
    for (const [k, v] of filters) if (v) query.set(k, v);
    const data = await api(`/api/audit-log?${query}`);
    shell(`<h1>Audit log</h1><div class="card">
      <div class="row">
        <input id="f-q" placeholder="search summary" value="${esc(params.get("q") || "")}">
        <select id="f-action"><option value="">any action</option>${["create","update","delete","pay","void","close","import","upload"].map((a) => `<option ${params.get("action") === a ? "selected" : ""}>${a}</option>`).join("")}</select>
        <input id="f-entityType" placeholder="entity type" value="${esc(params.get("entityType") || "")}">
        <input id="f-from" type="date" value="${esc(params.get("from") || "")}"><input id="f-to" type="date" value="${esc(params.get("to") || "")}">
        <button id="f-apply">Filter</button>
        <a href="/api/audit-log?${(() => { const q2 = new URLSearchParams(query); q2.set("format", "csv"); q2.delete("page"); q2.delete("pageSize"); return q2; })()}"><button class="ghost">Export CSV</button></a>
      </div>
      <table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Summary</th></tr></thead>
      <tbody>${data.rows.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.user_email || "")}</td><td>${esc(r.action)}</td>
        <td>${esc(r.entity_type)}${r.entity_id ? " #" + r.entity_id : ""}</td><td>${esc(r.summary)}</td></tr>`).join("")}</tbody></table>
      <div class="pager"><button class="ghost" id="prev" ${page <= 1 ? "disabled" : ""}>Prev</button>
        <span class="muted">page ${page} · ${data.total} rows</span>
        <button class="ghost" id="next" ${page * 50 >= data.total ? "disabled" : ""}>Next</button></div></div>`);
    const nav = (p) => {
      const q2 = new URLSearchParams();
      for (const id of ["q", "action", "entityType", "from", "to"]) { const v = val("#f-" + id); if (v) q2.set(id, v); }
      q2.set("page", String(p)); location.hash = "#/audit?" + q2;
    };
    qs("#f-apply").onclick = () => nav(1);
    qs("#prev").onclick = () => nav(page - 1);
    qs("#next").onclick = () => nav(page + 1);
  }

  async function settingsPage() {
    // A gated owner (MFA_REQUIRED) must still reach MFA setup: business API
    // calls may 403 here, so degrade to the MFA-only view instead of failing.
    let gated = false;
    let fx = { baseCurrency: me.baseCurrency, rates: [] };
    try { fx = await api("/api/settings/fx-rates"); } catch (e) { if (e.code === "MFA_REQUIRED") gated = true; else throw e; }
    const isAdmin = !gated && ["owner", "admin"].includes(me.role);
    let hooks = [];
    if (isAdmin) { try { hooks = await api("/api/webhooks"); } catch { hooks = []; } }
    shell(`<h1>Settings</h1>
      <div class="card"><h2>Two-factor authentication (TOTP)</h2><div id="mfa">
        ${me.totpEnabled
          ? `<p class="ok">MFA is enabled.</p><div class="row"><input id="dpass" type="password" placeholder="Password"><input id="dcode" placeholder="123456" maxlength="6"><button class="danger" id="mfaOff">Disable</button></div>`
          : `<p class="muted">${me.role === "owner" ? "Owners must enable MFA within 7 days of account creation." : "Protect your account with an authenticator app."}</p><button id="mfaSetup">Set up MFA</button>`}
        <div class="err" id="err"></div></div></div>
      <div class="card"><h2>FX rates (base: ${esc(fx.baseCurrency)})</h2>
        <div class="row"><input id="fxdate" type="date" value="${new Date().toISOString().slice(0, 10)}">
          <input id="fxfrom" placeholder="EUR" style="width:70px"><span>→ ${esc(fx.baseCurrency)}</span>
          <input id="fxrate" type="number" step="0.0001" placeholder="1.10" style="width:110px"><button id="fxadd">Save rate</button></div>
        <table><thead><tr><th>Date</th><th>From</th><th>To</th><th class="num">Rate</th><th>Source</th></tr></thead>
        <tbody>${fx.rates.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.fromCode)}</td><td>${esc(r.toCode)}</td><td class="num">${r.rate}</td><td>${esc(r.source)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">none</td></tr>`}</tbody></table></div>
      ${isAdmin ? `<div class="card"><h2>Webhooks</h2>
        <div class="row"><input id="whurl" placeholder="https://example.com/hook" style="flex:1">
          <input id="whevents" placeholder="invoice.paid,bill.paid" style="width:260px"><button id="whadd">Add</button></div>
        <div class="err" id="wherr"></div>
        <table><thead><tr><th>URL</th><th>Events</th><th>Active</th><th></th></tr></thead>
        <tbody>${hooks.map((w) => `<tr><td>${esc(w.url)}</td><td>${esc(w.events.join(", "))}</td><td>${w.is_active ? "yes" : "no"}</td>
          <td><button class="ghost" data-test="${w.id}">Test</button><button class="ghost" data-deliv="${w.id}">Deliveries</button><button class="danger" data-hdel="${w.id}">Delete</button></td></tr>`).join("")}</tbody></table>
        <pre id="whout" class="muted"></pre></div>` : ""}`);

    if (!me.totpEnabled && qs("#mfaSetup")) {
      qs("#mfaSetup").onclick = async () => {
        const s = await api("/api/auth/mfa/setup", { method: "POST" });
        qs("#mfa").innerHTML = `<p>Add this secret to your authenticator app (manual entry), then confirm with a code:</p>
          <code class="secret">${esc(s.secret)}</code>
          <p class="muted">${esc(s.otpauthUri)}</p>
          <div class="row"><input id="mfacode" placeholder="123456" maxlength="6"><button id="mfaConfirm">Enable</button></div>
          <div class="err" id="err"></div><div id="mfarecovery"></div>`;
        qs("#mfaConfirm").onclick = async () => {
          try {
            const r = await api("/api/auth/mfa/enable", { method: "POST", body: { code: val("#mfacode") } });
            me.totpEnabled = true;
            qs("#mfarecovery").innerHTML = `<p class="ok">MFA enabled. Save these one-time recovery codes — they are shown ONCE:</p>
              <ul class="recovery">${r.recoveryCodes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
          } catch (e) { showErr(e); }
        };
      };
    }
    if (me.totpEnabled && qs("#mfaOff")) {
      qs("#mfaOff").onclick = async () => {
        try { await api("/api/auth/mfa/disable", { method: "POST", body: { password: qs("#dpass").value, code: val("#dcode") } }); me.totpEnabled = false; route(); }
        catch (e) { showErr(e); }
      };
    }
    qs("#fxadd").onclick = async () => {
      try {
        await api("/api/settings/fx-rates", { method: "PUT", body: { rates: [{ date: val("#fxdate"), fromCode: val("#fxfrom").toUpperCase(), toCode: fx.baseCurrency, rate: Number(val("#fxrate")), source: "manual" }] } });
        route();
      } catch (e) { showErr(e); }
    };
    if (isAdmin && qs("#whadd")) {
      qs("#whadd").onclick = async () => {
        try {
          const r = await api("/api/webhooks", { method: "POST", body: { url: val("#whurl"), events: val("#whevents").split(",").map((s) => s.trim()).filter(Boolean), isActive: true } });
          alert("Webhook created. Signing secret (shown once): " + r.secret); route();
        } catch (e) { qs("#wherr").textContent = e.message; }
      };
      app.onclick = async (ev) => {
        const t = (attr) => ev.target.getAttribute && ev.target.getAttribute(attr);
        if (t("data-test")) qs("#whout").textContent = JSON.stringify(await api(`/api/webhooks/${t("data-test")}/test`, { method: "POST" }), null, 2);
        if (t("data-deliv")) qs("#whout").textContent = JSON.stringify(await api(`/api/webhooks/${t("data-deliv")}/deliveries`), null, 2);
        if (t("data-hdel")) { if (confirm("Delete webhook?")) { await api(`/api/webhooks/${t("data-hdel")}`, { method: "DELETE" }); route(); } }
      };
    }
  }

  /* ---------------- router ---------------- */
  async function loadMe() {
    try { me = await api("/api/auth/me"); } catch { me = null; }
  }
  async function route() {
    if (!me) await loadMe();
    if (!me) return loginPage();
    const hash = location.hash || "#/dashboard";
    try {
      if (hash.startsWith("#/customers")) return await partiesPage("customers");
      if (hash.startsWith("#/vendors")) return await partiesPage("vendors");
      if (hash.startsWith("#/invoices")) return await docsPage("invoices");
      if (hash.startsWith("#/bills")) return await docsPage("bills");
      if (hash.startsWith("#/reports")) return await reportsPage();
      if (hash.startsWith("#/budgets")) return await budgetsPage();
      if (hash.startsWith("#/import")) return await importPage();
      if (hash.startsWith("#/audit")) return await auditPage();
      if (hash.startsWith("#/settings")) return await settingsPage();
      return await dashboardPage();
    } catch (e) {
      if (e.code === "MFA_REQUIRED") {
        shell(`<div class="card"><h1>MFA required</h1><p>Your owner account has passed the 7-day grace period. <a href="#/settings">Enable MFA in Settings</a> to continue.</p></div>`);
        return;
      }
      if (e.status === 401) { me = null; return loginPage(); }
      shell(`<div class="card"><div class="err">${esc(e.message)}</div></div>`);
    }
  }
  window.addEventListener("hashchange", route);
  route();
})();
