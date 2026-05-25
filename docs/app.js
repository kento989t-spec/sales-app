(() => {
  // ===== 暗号化ユーティリティ =====
  const SESSION_KEY = "sales_app_pw";

  function fromHex(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return arr;
  }

  async function deriveKey(password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  async function decryptData(encrypted, password) {
    const salt = fromHex(encrypted.salt);
    const iv = fromHex(encrypted.iv);
    const ciphertext = fromHex(encrypted.ciphertext);
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function checkAuth() {
    return !!sessionStorage.getItem(SESSION_KEY);
  }

  function getSavedPassword() {
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  }

  // ===== ユーティリティ =====
  function yen(n) {
    return "¥" + Math.abs(n).toLocaleString("ja-JP");
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fmt(n, prefix = "") {
    return prefix + yen(n);
  }

  function gapClass(n) {
    return n >= 0 ? "positive" : "negative";
  }

  function gapStr(n) {
    return (n >= 0 ? "+" : "▲") + yen(n);
  }

  // ===== メインデータ =====
  let DATA = null;
  let activeYomi = "";
  let activeOwner = "";

  async function loadData(password = "") {
    const res = await fetch("data/sales-data.json?_=" + Date.now());
    const raw = await res.json();
    if (raw.encrypted) {
      DATA = await decryptData(raw, password);
    } else {
      DATA = raw;
    }
  }

  // ===== ヘッダー =====
  function renderHeader() {
    document.getElementById("month-label").textContent =
      DATA.month.replace("-", "年") + "月";
    const d = new Date(DATA.generated_at);
    document.getElementById("updated-at").textContent =
      "最終更新: " + d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

    // 担当者フィルタ
    const owners = [...new Set(DATA.deals.map(d => d.owner).filter(Boolean))].sort();
    const sel = document.getElementById("owner-filter");
    owners.forEach(o => {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = "担当: " + o;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      activeOwner = sel.value;
      renderAll();
    });
  }

  // ===== フィルタ適用 =====
  function filteredDeals(extraYomi = null) {
    const yomi = extraYomi !== null ? extraYomi : activeYomi;
    return DATA.deals.filter(d => {
      if (activeOwner && d.owner !== activeOwner) return false;
      if (yomi && d.yomi !== yomi) return false;
      return true;
    });
  }

  // ===== サマリー再集計（担当者フィルタ対応）=====
  function calcSummary() {
    const deals = filteredDeals("");
    const coeffs = DATA.yomi_coefficients;
    const summary = {};
    for (const cat of DATA.categories) {
      const target = activeOwner ? 0 : (DATA.targets[cat] ?? 0);
      const catDeals = deals.filter(d => d.categories?.includes(cat));
      const yomi_weighted = catDeals.reduce((s, d) => s + d.weighted_amount, 0);
      const actual = catDeals.filter(d => d.is_won).reduce((s, d) => s + d.amount, 0);
      summary[cat] = { target, yomi_weighted, actual, gap: yomi_weighted - target };
    }
    const total = {
      target: activeOwner ? 0 : DATA.categories.reduce((s, c) => s + (DATA.targets[c] ?? 0), 0),
      yomi_weighted: Object.values(summary).reduce((s, v) => s + v.yomi_weighted, 0),
      actual: Object.values(summary).reduce((s, v) => s + v.actual, 0),
    };
    total.gap = total.yomi_weighted - total.target;
    return { summary, total };
  }

  // ===== サマリーテーブル =====
  function renderSummary() {
    const { summary, total } = calcSummary();
    const tbody = document.getElementById("summary-body");
    tbody.innerHTML = DATA.categories.map(cat => {
      const v = summary[cat];
      const achieved = v.target > 0 && v.yomi_weighted >= v.target;
      return `<tr>
        <td>${esc(cat)}</td>
        <td>${yen(v.target)}</td>
        <td class="${achieved ? "achieved" : ""}">${yen(v.yomi_weighted)}</td>
        <td>${yen(v.actual)}</td>
        <td class="${gapClass(v.gap)}">${gapStr(v.gap)}</td>
      </tr>`;
    }).join("");

    const tfoot = document.getElementById("summary-foot");
    const achieved = total.target > 0 && total.yomi_weighted >= total.target;
    tfoot.innerHTML = `<tr>
      <td>合計</td>
      <td>${yen(total.target)}</td>
      <td class="${achieved ? "achieved" : ""}">${yen(total.yomi_weighted)}</td>
      <td>${yen(total.actual)}</td>
      <td class="${gapClass(total.gap)}">${gapStr(total.gap)}</td>
    </tr>`;
  }

  // ===== 進捗バー =====
  function renderProgress() {
    const { summary } = calcSummary();
    const el = document.getElementById("progress-bars");
    el.innerHTML = DATA.categories.map(cat => {
      const v = summary[cat];
      const yomiPct = v.target > 0 ? Math.min(100, Math.round(v.yomi_weighted / v.target * 100)) : 0;
      const actualPct = v.target > 0 ? Math.min(100, Math.round(v.actual / v.target * 100)) : 0;
      return `<div class="progress-card">
        <h3>${esc(cat)}</h3>
        <div class="progress-nums">
          <span>読み: ${yen(v.yomi_weighted)} <small style="color:var(--text-sub)">(${yomiPct}%)</small></span>
          <span style="color:var(--text-sub)">目標: ${yen(v.target)}</span>
        </div>
        <div class="progress-bar-wrap" style="margin-bottom:6px">
          <div class="progress-bar bar-yomi" style="width:${yomiPct}%"></div>
        </div>
        <div class="progress-nums">
          <span>実績: ${yen(v.actual)} <small style="color:var(--text-sub)">(${actualPct}%)</small></span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar bar-actual" style="width:${actualPct}%"></div>
        </div>
      </div>`;
    }).join("");
  }

  // ===== 案件行 =====
  function dealRow(d, showBillingMonth = false) {
    const cats = (d.categories || []).join(", ");
    const wonBadge = d.is_won ? `<span class="badge badge-won">受注</span> ` : "";
    const billingCell = showBillingMonth
      ? `<td>${d.billing_month ? d.billing_month.slice(0, 7) : ""}</td>`
      : "";
    return `<tr>
      <td>${esc(d.company || d.name)}</td>
      <td><small>${esc(cats)}</small></td>
      <td><span class="badge badge-${d.yomi}">${esc(d.yomi)}</span></td>
      <td class="num">${yen(d.amount)}</td>
      <td class="num">${yen(d.weighted_amount)}</td>
      <td>${wonBadge}${esc(d.phase)}</td>
      ${billingCell}
      <td>${esc(d.owner)}</td>
      <td class="na-text">${esc(d.next_action)}</td>
    </tr>`;
  }

  // ===== ダッシュボード内案件リスト =====
  function renderDashboardDeals() {
    const deals = filteredDeals(activeYomi);
    const tbody = document.getElementById("deals-body-dashboard");
    if (deals.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-sub);padding:24px">該当案件なし</td></tr>`;
    } else {
      tbody.innerHTML = deals.map(d => dealRow(d, false)).join("");
    }
  }

  // ===== 案件一覧タブ =====
  function renderDealsList() {
    const catFilter = document.getElementById("cat-filter").value;
    const phaseFilter = document.getElementById("phase-filter").value;
    const deals = filteredDeals("").filter(d => {
      if (catFilter && !(d.categories || []).includes(catFilter)) return false;
      if (phaseFilter && !d.phase.startsWith(phaseFilter)) return false;
      return true;
    });
    const tbody = document.getElementById("deals-body-list");
    if (deals.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-sub);padding:24px">該当案件なし</td></tr>`;
    } else {
      tbody.innerHTML = deals.map(d => dealRow(d, true)).join("");
    }
  }

  function renderAll() {
    renderSummary();
    renderProgress();
    renderDashboardDeals();
    renderDealsList();
  }

  // ===== タブ切替 =====
  function initTabs() {
    document.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
      });
    });
  }

  // ===== ヨミフィルタ =====
  function initYomiFilter() {
    document.querySelectorAll(".yomi-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".yomi-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activeYomi = btn.dataset.yomi;
        renderDashboardDeals();
      });
    });
  }

  // ===== 案件一覧フィルタ =====
  function initDealsFilter() {
    document.getElementById("cat-filter").addEventListener("change", renderDealsList);
    document.getElementById("phase-filter").addEventListener("change", renderDealsList);
  }

  // ===== 起動 =====
  async function main() {
    const authed = await checkAuth();

    if (!authed) {
      document.getElementById("pw-btn").addEventListener("click", async () => {
        const pw = document.getElementById("pw-input").value;
        const errEl = document.getElementById("pw-error");
        errEl.classList.add("hidden");
        try {
          await loadData(pw);
          sessionStorage.setItem(SESSION_KEY, pw);
          document.getElementById("auth-gate").classList.add("hidden");
          document.getElementById("app").classList.remove("hidden");
          initApp();
        } catch (_) {
          errEl.textContent = "パスワードが違います";
          errEl.classList.remove("hidden");
        }
      });
      document.getElementById("pw-input").addEventListener("keydown", e => {
        if (e.key === "Enter") document.getElementById("pw-btn").click();
      });
    } else {
      try {
        await loadData(getSavedPassword());
        document.getElementById("auth-gate").classList.add("hidden");
        document.getElementById("app").classList.remove("hidden");
        initApp();
      } catch (_) {
        // トークン切れ → 再認証
        sessionStorage.removeItem(SESSION_KEY);
        document.getElementById("pw-error").textContent = "セッションが切れました。再度ログインしてください";
        document.getElementById("pw-error").classList.remove("hidden");
      }
    }
  }

  function initApp() {
    renderHeader();
    initTabs();
    initYomiFilter();
    initDealsFilter();
    renderAll();
  }

  main();
})();
