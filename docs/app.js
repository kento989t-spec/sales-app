(() => {
  // ===== 暗号化ユーティリティ =====
  const SESSION_KEY = "sales_app_pw";
  const TASK_STATUS_KEY = "sales_app_task_status";

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

  // ===== タスクステータス（localStorage）=====
  function loadTaskStatus() {
    try {
      return JSON.parse(localStorage.getItem(TASK_STATUS_KEY) ?? "{}");
    } catch { return {}; }
  }

  function setTaskStatus(id, status) {
    const map = loadTaskStatus();
    map[id] = status;
    localStorage.setItem(TASK_STATUS_KEY, JSON.stringify(map));
  }

  function getTaskStatus(id) {
    return loadTaskStatus()[id] ?? "todo";
  }

  // ===== ユーティリティ =====
  function yen(n) {
    return "¥" + Math.abs(n).toLocaleString("ja-JP");
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function gapClass(n) {
    return n >= 0 ? "positive" : "negative";
  }

  function gapStr(n) {
    return (n >= 0 ? "+" : "▲") + yen(n);
  }

  // ===== GoCoo フィールド定数 =====
  const GOCOO_REPO = "kento989t-spec/sales-app";
  const F_YOMI        = "field_ed6f5306-135c-4105-a915-17e554dc5be2";
  const F_BILLING     = "field_d8fd26b2-a857-450b-9f93-9cd44d0bb811";
  const F_AMOUNT      = "field_76f2b2f7-af26-44bc-a4db-7817c1a07dcc";
  const F_NEXT_ACTION = "field_2b2fbca9-15f1-43b7-9ad6-516d48904c4a";
  const YOMI_OPTIONS  = { A: 120, B: 121, C: 122, D: 123 };

  // ===== GitHub PAT =====
  const PAT_KEY = "sales_app_github_pat";
  function savePat(pat) { if (pat) sessionStorage.setItem(PAT_KEY, pat); }
  function getPat() { return sessionStorage.getItem(PAT_KEY) ?? ""; }

  // ===== トースト =====
  function toast(msg, type = "info") {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "toast toast-" + type;
    el.style.opacity = "1";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.opacity = "0"; }, 3000);
  }

  // ===== GoCoo 更新（GitHub Actions 経由）=====
  async function triggerUpdate(dealId, fieldKey, fieldValue) {
    const pat = getPat();
    if (!pat) {
      toast("GitHub PATが未設定です。再ログインしてPATを入力してください", "error");
      return false;
    }
    toast("更新中...", "info");
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GOCOO_REPO}/actions/workflows/update-deal.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              deal_id: String(dealId),
              field_key: fieldKey,
              field_value: JSON.stringify(fieldValue),
            },
          }),
        }
      );
      if (res.status === 204) {
        toast("更新しました（GoCooへの反映は~60秒後）", "success");
        return true;
      } else {
        const body = await res.text();
        toast("更新失敗: " + res.status + " " + body, "error");
        return false;
      }
    } catch (e) {
      toast("通信エラー: " + e.message, "error");
      return false;
    }
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

    // 担当者フィルタ: all_deals（全月）から収集
    const source = DATA.all_deals ?? DATA.deals ?? [];
    const owners = [...new Set(source.map(d => d.owner).filter(Boolean))].sort();
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

  // ===== フィルタ適用（ダッシュボード用・今月分のみ）=====
  function filteredDeals(extraYomi = null) {
    const yomi = extraYomi !== null ? extraYomi : activeYomi;
    const source = DATA.deals ?? [];
    return source.filter(d => {
      if (activeOwner && d.owner !== activeOwner) return false;
      if (yomi && d.yomi !== yomi) return false;
      return true;
    });
  }

  // ===== サマリー再集計 =====
  function calcSummary() {
    const deals = filteredDeals("");
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
          <span>ヨミ: ${yen(v.yomi_weighted)} <small style="color:var(--text-sub)">(${yomiPct}%)</small></span>
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
  function yomiSelect(d) {
    const opts = ["A", "B", "C", "D"].map(v =>
      `<option value="${v}" ${d.yomi === v ? "selected" : ""}>${v}</option>`
    ).join("");
    return `<select class="yomi-select badge badge-${d.yomi}" data-deal-id="${d.id}" onchange="window._yomiChange(this, ${d.id})">${opts}</select>`;
  }

  function dealRow(d, showBillingMonth = false) {
    const cats = (d.categories || []).join(", ");
    const wonBadge = d.is_won ? `<span class="badge badge-won">受注</span> ` : "";
    const billingVal = d.billing_month ? d.billing_month.slice(0, 7) : "";
    const billingCell = showBillingMonth
      ? `<td><input type="month" class="billing-input" value="${billingVal}" data-deal-id="${d.id}" onchange="window._billingChange(this, ${d.id})"></td>`
      : "";
    const amountRaw = d.amount ?? 0;
    return `<tr>
      <td>${esc(d.company || d.name)}</td>
      <td><small>${esc(cats)}</small></td>
      <td>${yomiSelect(d)}</td>
      <td class="num"><input type="number" class="amount-input" value="${amountRaw}" data-deal-id="${d.id}" onchange="window._amountChange(this, ${d.id})"></td>
      <td class="num">${yen(d.weighted_amount)}</td>
      <td>${wonBadge}${esc(d.phase)}</td>
      ${billingCell}
      <td>${esc(d.owner)}</td>
      <td class="na-text"><input type="text" class="na-input" value="${esc(d.next_action)}" data-deal-id="${d.id}" onchange="window._naChange(this, ${d.id})"></td>
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
    const showAllMonths = document.getElementById("show-all-months").checked;

    // 全月表示ONなら all_deals、OFFなら今月分（deals）
    const source = showAllMonths
      ? (DATA.all_deals ?? DATA.deals ?? [])
      : (DATA.deals ?? []);

    const deals = source.filter(d => {
      if (activeOwner && d.owner !== activeOwner) return false;
      if (catFilter && !(d.categories || []).includes(catFilter)) return false;
      if (phaseFilter && !d.phase.includes(phaseFilter)) return false;
      return true;
    });

    const tbody = document.getElementById("deals-body-list");
    if (deals.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-sub);padding:24px">該当案件なし</td></tr>`;
    } else {
      tbody.innerHTML = deals.map(d => dealRow(d, true)).join("");
    }
  }

  // ===== タスク管理タブ =====
  const STATUS_LABELS = { todo: "未対応", doing: "対応中", done: "完了" };
  const STATUS_NEXT = { todo: "doing", doing: "done", done: "todo" };
  const STATUS_CLASS = { todo: "status-todo", doing: "status-doing", done: "status-done" };

  function taskStatusToggle(id) {
    const current = getTaskStatus(id);
    setTaskStatus(id, STATUS_NEXT[current]);
    renderTasks();
  }

  function renderStandingTasks() {
    const el = document.getElementById("task-cards-standing");
    const tasks = DATA.tasks?.standing ?? [];
    if (tasks.length === 0) {
      el.innerHTML = `<p class="task-empty">定常タスクなし</p>`;
      return;
    }
    el.innerHTML = tasks.map(t => {
      const status = getTaskStatus(t.id);
      return `<div class="task-card ${status === "done" ? "task-done" : ""}">
        <div class="task-card-main">
          <span class="task-label standing-label">定常</span>
          <span class="task-title">${esc(t.title)}</span>
        </div>
        <button class="status-toggle ${STATUS_CLASS[status]}" onclick="window._taskToggle('${esc(t.id)}')">
          ${STATUS_LABELS[status]}
        </button>
      </div>`;
    }).join("");
  }

  function renderNaTasks() {
    const el = document.getElementById("task-cards-na");
    const countEl = document.getElementById("na-count");
    const all = DATA.tasks?.next_action ?? [];
    const tasks = activeOwner
      ? all.filter(t => t.owner === activeOwner)
      : all;

    countEl.textContent = tasks.length > 0 ? `(${tasks.length}件)` : "";

    if (tasks.length === 0) {
      el.innerHTML = `<p class="task-empty">ネクストアクションなし</p>`;
      return;
    }
    el.innerHTML = tasks.map(t => {
      const status = getTaskStatus(t.id);
      return `<div class="task-card ${status === "done" ? "task-done" : ""}">
        <div class="task-card-main">
          <span class="task-label na-label">NA</span>
          <div class="task-card-body">
            <div class="task-title">${esc(t.next_action)}</div>
            <div class="task-meta">
              <span>${esc(t.company)}</span>
              <span class="badge badge-${t.yomi}">${esc(t.yomi || "—")}</span>
              <span class="phase-text">${esc(t.phase)}</span>
              ${t.owner ? `<span class="owner-chip">${esc(t.owner)}</span>` : ""}
            </div>
          </div>
        </div>
        <button class="status-toggle ${STATUS_CLASS[status]}" onclick="window._taskToggle('${esc(t.id)}')">
          ${STATUS_LABELS[status]}
        </button>
      </div>`;
    }).join("");
  }

  function renderSlackTasks() {
    const el = document.getElementById("task-cards-slack");
    const countEl = document.getElementById("slack-count");
    const all = DATA.tasks?.slack ?? [];
    const tasks = activeOwner
      ? all.filter(t => !t.owner || t.owner === activeOwner)
      : all;

    countEl.textContent = tasks.length > 0 ? `(${tasks.length}件)` : "";

    if (tasks.length === 0) {
      el.innerHTML = `<p class="task-empty">Slack議事録タスクなし${!all.length ? "（チャンネル未設定）" : ""}</p>`;
      return;
    }
    el.innerHTML = tasks.map(t => {
      const status = getTaskStatus(t.id);
      return `<div class="task-card ${status === "done" ? "task-done" : ""}">
        <div class="task-card-main">
          <span class="task-label slack-label">Slack</span>
          <div class="task-card-body">
            <div class="task-title">${esc(t.title)}</div>
            ${t.owner ? `<div class="task-meta"><span class="owner-chip">${esc(t.owner)}</span></div>` : ""}
          </div>
        </div>
        <button class="status-toggle ${STATUS_CLASS[status]}" onclick="window._taskToggle('${esc(t.id)}')">
          ${STATUS_LABELS[status]}
        </button>
      </div>`;
    }).join("");
  }

  function renderTasks() {
    renderStandingTasks();
    renderNaTasks();
    renderSlackTasks();
  }

  // グローバルハンドラ
  window._taskToggle = taskStatusToggle;

  window._yomiChange = async function(select, dealId) {
    const newYomi = select.value;
    const choiceId = YOMI_OPTIONS[newYomi];
    select.className = `yomi-select badge badge-${newYomi}`;
    select.disabled = true;
    const ok = await triggerUpdate(dealId, F_YOMI, choiceId);
    select.disabled = false;
    if (!ok) {
      // 失敗時は元の値に戻す（ローカルキャッシュを参照）
      const deal = (DATA.all_deals ?? DATA.deals ?? []).find(d => d.id === dealId);
      if (deal) {
        select.value = deal.yomi;
        select.className = `yomi-select badge badge-${deal.yomi}`;
      }
    }
  };

  window._amountChange = async function(input, dealId) {
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) return;
    input.disabled = true;
    const ok = await triggerUpdate(dealId, F_AMOUNT, val);
    input.disabled = false;
    if (!ok) {
      const deal = (DATA.all_deals ?? DATA.deals ?? []).find(d => d.id === dealId);
      if (deal) input.value = deal.amount ?? 0;
    }
  };

  window._naChange = async function(input, dealId) {
    const val = input.value;
    input.disabled = true;
    const ok = await triggerUpdate(dealId, F_NEXT_ACTION, val);
    input.disabled = false;
    if (!ok) {
      const deal = (DATA.all_deals ?? DATA.deals ?? []).find(d => d.id === dealId);
      if (deal) input.value = deal.next_action ?? "";
    }
  };

  window._billingChange = async function(input, dealId) {
    const newMonth = input.value; // "YYYY-MM"
    if (!newMonth) return;
    // GoCoo の計上月は月末日 (YYYY-MM-DD)
    const [y, m] = newMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).toISOString().slice(0, 10);
    input.disabled = true;
    const ok = await triggerUpdate(dealId, F_BILLING, lastDay);
    input.disabled = false;
    if (!ok) {
      const deal = (DATA.all_deals ?? DATA.deals ?? []).find(d => d.id === dealId);
      if (deal) input.value = deal.billing_month ? deal.billing_month.slice(0, 7) : "";
    }
  };

  // ===== 全レンダリング =====
  function renderAll() {
    renderSummary();
    renderProgress();
    renderDashboardDeals();
    renderDealsList();
    renderTasks();
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
    document.getElementById("show-all-months").addEventListener("change", renderDealsList);
  }

  // ===== 起動 =====
  async function main() {
    const authed = await checkAuth();

    if (!authed) {
      document.getElementById("pw-btn").addEventListener("click", async () => {
        const pw = document.getElementById("pw-input").value;
        const pat = document.getElementById("pat-input").value.trim();
        const errEl = document.getElementById("pw-error");
        errEl.classList.add("hidden");
        try {
          await loadData(pw);
          sessionStorage.setItem(SESSION_KEY, pw);
          savePat(pat);
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
    initPatButton();
    renderAll();
  }

  function initPatButton() {
    const btn = document.getElementById("pat-setting-btn");
    if (!btn) return;
    updatePatBtn();
    btn.addEventListener("click", () => {
      const current = getPat();
      const val = prompt("GitHub PAT を入力してください（編集機能に使用）:", current);
      if (val !== null) {
        savePat(val.trim());
        updatePatBtn();
        toast(val.trim() ? "PAT を保存しました" : "PAT をクリアしました", "success");
      }
    });
  }

  function updatePatBtn() {
    const btn = document.getElementById("pat-setting-btn");
    if (!btn) return;
    btn.style.background = getPat() ? "var(--success)" : "var(--warning)";
  }

  main();
})();
