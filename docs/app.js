(() => {
  // ===== 暗号化ユーティリティ =====
  const SESSION_KEY       = "sales_app_pw";
  const TASK_STATUS_KEY   = "sales_app_task_status";
  const CUSTOM_TASKS_KEY  = "sales_app_custom_tasks";
  const COMMENTS_KEY      = "sales_app_task_comments";
  const TASK_DATES_KEY    = "sales_app_task_dates";

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

  // ===== 楽観的更新 + ペンディング管理（localStorage）=====
  const PENDING_KEY = "sales_app_pending";
  const PENDING_TTL = 90 * 60 * 1000; // 90分: Actions完了 + hourly fetch を余裕で待てる

  function loadPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}"); }
    catch { return {}; }
  }

  function setPending(dealId, field, value) {
    const obj = loadPending();
    obj[`${dealId}:${field}`] = { dealId, field, value, ts: Date.now() };
    localStorage.setItem(PENDING_KEY, JSON.stringify(obj));
  }

  function clearPending(dealId, field) {
    const obj = loadPending();
    delete obj[`${dealId}:${field}`];
    localStorage.setItem(PENDING_KEY, JSON.stringify(obj));
  }

  // DATA ロード直後に呼ぶ: ペンディング中の変更をデータに上書き適用
  function applyPending() {
    if (!DATA) return;
    const now = Date.now();
    const obj = loadPending();
    const valid = Object.values(obj).filter(p => now - p.ts < PENDING_TTL);
    // 期限切れを削除
    const cleaned = {};
    valid.forEach(p => { cleaned[`${p.dealId}:${p.field}`] = p; });
    localStorage.setItem(PENDING_KEY, JSON.stringify(cleaned));

    for (const { dealId, field, value } of valid) {
      for (const arr of [DATA.deals, DATA.all_deals]) {
        const deal = (arr ?? []).find(d => d.id === dealId);
        if (!deal) continue;
        deal[field] = value;
        // ヨミor金額が変わったら加重額を再計算
        if (field === "yomi" || field === "amount") {
          const coeff = (DATA.yomi_coefficients ?? {})[deal.yomi] ?? 0;
          deal.weighted_amount = Math.round(deal.amount * coeff);
        }
        if (field === "phase") {
          deal.is_won = String(value).includes("CS-");
        }
      }
    }
  }

  // 楽観的更新: DATA を即時更新してサマリー/進捗/案件リストを再描画
  function optimisticUpdate(dealId, field, value) {
    for (const arr of [DATA.deals, DATA.all_deals]) {
      const deal = (arr ?? []).find(d => d.id === dealId);
      if (!deal) continue;
      deal[field] = value;
      if (field === "yomi" || field === "amount") {
        const coeff = (DATA.yomi_coefficients ?? {})[deal.yomi] ?? 0;
        deal.weighted_amount = Math.round(deal.amount * coeff);
      }
      if (field === "phase") {
        deal.is_won = String(value).includes("CS-");
      }
    }
    setPending(dealId, field, value);
    renderSummary();
    renderProgress();
    renderDashboardDeals();
    renderDealsList();
  }

  function revertUpdate(dealId, field, origValue) {
    for (const arr of [DATA.deals, DATA.all_deals]) {
      const deal = (arr ?? []).find(d => d.id === dealId);
      if (!deal) continue;
      deal[field] = origValue;
      if (field === "yomi" || field === "amount") {
        const coeff = (DATA.yomi_coefficients ?? {})[deal.yomi] ?? 0;
        deal.weighted_amount = Math.round(deal.amount * coeff);
      }
      if (field === "phase") {
        deal.is_won = String(origValue).includes("CS-");
      }
    }
    clearPending(dealId, field);
    renderSummary();
    renderProgress();
    renderDashboardDeals();
    renderDealsList();
  }

  // ===== 共有ストア（project-dashboard API）=====
  // API URLは api-config.json から動的取得。Mac Mini 再起動時に LaunchAgent が自動更新してpushする。
  let SALES_API = "";

  async function resolveSalesApi() {
    // キャッシュを確認（5分有効）
    const cached = localStorage.getItem("sales_api_url");
    const cachedTs = parseInt(localStorage.getItem("sales_api_url_ts") ?? "0", 10);
    if (cached && Date.now() - cachedTs < 5 * 60 * 1000) {
      SALES_API = cached;
      return;
    }
    try {
      const res = await fetch("api-config.json?_=" + Date.now());
      const cfg = await res.json();
      if (cfg.apiUrl) {
        SALES_API = cfg.apiUrl;
        localStorage.setItem("sales_api_url", SALES_API);
        localStorage.setItem("sales_api_url_ts", String(Date.now()));
      }
    } catch (e) {
      // フォールバック: キャッシュを使う（期限切れでも）
      if (cached) SALES_API = cached;
      console.warn("api-config.json fetch failed, using cached URL:", SALES_API, e);
    }
  }

  // メモリ上の共有状態（初期化時に API から一括取得、更新時に API へ書き込み）
  let sharedState = {
    taskStatus: {},
    customTasks: {},
    comments: {},
    taskDates: {},
    taskOwners: {},
    pat: "",
  };

  async function apiFetchKey(key) {
    if (!SALES_API) return null;
    try {
      const res = await fetch(`${SALES_API}/api/sales/store?key=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.value ?? null;
    } catch { return null; }
  }

  async function apiSaveKey(key, value) {
    if (!SALES_API) return;
    try {
      await fetch(`${SALES_API}/api/sales/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    } catch (e) {
      console.warn("apiSaveKey failed:", key, e);
    }
  }

  async function loadSharedState() {
    await resolveSalesApi();
    try {
      const [taskStatus, customTasks, comments, taskDates, taskOwners, config] = await Promise.all([
        apiFetchKey("task_status"),
        apiFetchKey("custom_tasks"),
        apiFetchKey("comments"),
        apiFetchKey("task_dates"),
        apiFetchKey("task_owners"),
        SALES_API
          ? fetch(`${SALES_API}/api/sales/config`).then(r => r.ok ? r.json() : { pat: "" }).catch(() => ({ pat: "" }))
          : Promise.resolve({ pat: "" }),
      ]);
      sharedState.taskStatus  = taskStatus  ?? {};
      sharedState.customTasks = customTasks ?? {};
      sharedState.comments    = comments    ?? {};
      sharedState.taskDates   = taskDates   ?? {};
      sharedState.taskOwners  = taskOwners  ?? {};
      // PAT: ローカルオーバーライドがあればそちら優先
      const override = localStorage.getItem("sales_app_pat_override");
      sharedState.pat = override || config.pat || "";
    } catch (e) {
      console.warn("loadSharedState failed, using empty state:", e);
    }
  }

  // ===== タスクステータス（sharedState）=====
  function getTaskStatus(id) {
    const s = sharedState.taskStatus[id] ?? "todo";
    return s === "skipped" ? "cancelled" : s;
  }

  function setTaskStatus(id, status) {
    sharedState.taskStatus[id] = status;
    apiSaveKey("task_status", sharedState.taskStatus);
  }

  // ===== カスタムタスク（sharedState）=====
  function loadCustomTasks() {
    return sharedState.customTasks;
  }

  function saveCustomTask(company, title) {
    const id = `custom-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    sharedState.customTasks[id] = { id, company, title, created_at: new Date().toISOString() };
    apiSaveKey("custom_tasks", sharedState.customTasks);
  }

  function deleteCustomTask(id) {
    delete sharedState.customTasks[id];
    apiSaveKey("custom_tasks", sharedState.customTasks);
    delete sharedState.comments[id];
    apiSaveKey("comments", sharedState.comments);
  }

  // ===== コメント（sharedState）=====
  function getComments(taskId) { return sharedState.comments[taskId] ?? []; }

  function addComment(taskId, text) {
    if (!sharedState.comments[taskId]) sharedState.comments[taskId] = [];
    sharedState.comments[taskId].push({ text, ts: Date.now() });
    apiSaveKey("comments", sharedState.comments);
  }

  // ===== タスク日付（sharedState）=====
  function getTaskDue(id) { return sharedState.taskDates[id] ?? ""; }

  function setTaskDue(id, date) {
    sharedState.taskDates[id] = date;
    apiSaveKey("task_dates", sharedState.taskDates);
  }

  function getTaskOwner(id) { return sharedState.taskOwners[id] ?? ""; }

  function setTaskOwner(id, owner) {
    if (owner) sharedState.taskOwners[id] = owner;
    else delete sharedState.taskOwners[id];
    apiSaveKey("task_owners", sharedState.taskOwners);
  }

  // コメントパネルが開いているタスクID（再描画後に復元）
  const openComments = new Set();

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
  const F_CATEGORIES  = "field_00c5a3dc-ea3e-4a19-84b2-d50dd44dcad0";
  const F_PATH        = "path_id";
  const F_OWNER       = "field_8fbb7b46-95c0-4268-833a-f65e9a8d09da";
  const YOMI_OPTIONS  = { A: 120, B: 121, C: 122, D: 123 };
  // GoCoo path step IDs (from /custom-objects/5/paths)
  const PATH_ID = { 商談中: 5, 保留: 19, 失注: 20, 受注: 12 };
  const PATH_PHASE_FROM_ID = {
    5:  "【FS-02】初回商談実施済",
    12: "【CS-01】本番初期設定・キックオフ",
    19: "ペンディング",
    20: "失注",
  };
  const CAT_OPTIONS   = [
    { id: 258, name: "CoPASS" },
    { id: 259, name: "CoPASS BPO" },
    { id: 257, name: "Partner Boost" },
    { id: 332, name: "Partner startup" },
    { id: 333, name: "BPO(開拓以外）" },
  ];

  // ===== GitHub PAT =====
  // PAT は sharedState.pat（サーバー共有）を使用。
  // ユーザーが独自 PAT を使いたい場合は localStorage の sales_app_pat_override に保存し優先される。
  const PAT_KEY = "sales_app_pat_override";
  function savePat(pat) {
    if (pat) {
      localStorage.setItem(PAT_KEY, pat);
      sharedState.pat = pat;
    } else {
      localStorage.removeItem(PAT_KEY);
      // オーバーライドを消したら再度サーバー値を使う（既に sharedState.pat にサーバー値が入っている）
    }
  }
  function getPat() { return sharedState.pat ?? ""; }

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
  let OWNER_OPTIONS = []; // { id: number, name: string }[]

  function initOwnerOptions() {
    if (DATA.users?.length > 0) {
      OWNER_OPTIONS = DATA.users;
    } else {
      const map = new Map();
      for (const d of DATA.all_deals ?? []) {
        if (d.owner_id != null && d.owner) map.set(d.owner_id, d.owner);
      }
      OWNER_OPTIONS = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([id, name]) => ({ id, name }));
    }
  }

  async function loadData(password = "") {
    const res = await fetch("data/sales-data.json?_=" + Date.now());
    const raw = await res.json();
    if (raw.encrypted) {
      DATA = await decryptData(raw, password);
    } else {
      DATA = raw;
    }
    applyPending(); // ペンディング中の変更をデータに上書き
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

  // ===== ソート =====
  let sortField = "updated_at";
  let sortDir = "desc";

  function sortDeals(arr) {
    return [...arr].sort((a, b) => {
      let va = a[sortField] ?? "", vb = b[sortField] ?? "";
      if (sortField === "amount") { va = a.amount ?? 0; vb = b.amount ?? 0; }
      const cmp = typeof va === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "ja");
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  function initSortHeaders() {
    document.querySelectorAll("th.sortable").forEach(th => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (sortField === field) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortField = field;
          sortDir = field === "updated_at" ? "desc" : "asc";
        }
        updateSortIcons();
        renderDealsList();
      });
    });
    updateSortIcons();
  }

  function updateSortIcons() {
    document.querySelectorAll("th.sortable").forEach(th => {
      const icon = th.querySelector(".sort-icon");
      if (!icon) return;
      if (th.dataset.sort === sortField) {
        icon.textContent = sortDir === "asc" ? " ▲" : " ▼";
      } else {
        icon.textContent = "";
      }
    });
  }

  // ===== 案件行 =====
  function yomiSelect(d) {
    const empty = !d.yomi;
    const placeholder = empty ? `<option value="" selected>—</option>` : "";
    const opts = ["A", "B", "C", "D"].map(v =>
      `<option value="${v}" ${d.yomi === v ? "selected" : ""}>${v}</option>`
    ).join("");
    const cls = empty ? "yomi-select badge badge-none" : `yomi-select badge badge-${d.yomi}`;
    return `<select class="${cls}" data-deal-id="${d.id}" onchange="window._yomiChange(this, ${d.id})">${placeholder}${opts}</select>`;
  }

  function deriveStatus(phase) {
    if (!phase) return "商談中";
    if (String(phase).includes("CS-")) return "受注";
    if (phase === "ペンディング") return "保留";
    if (phase === "失注") return "失注";
    return "商談中";
  }

  function statusSelect(d) {
    const current = deriveStatus(d.phase);
    const opts = Object.keys(PATH_ID).map(v =>
      `<option value="${v}" ${current === v ? "selected" : ""}>${v}</option>`
    ).join("");
    return `<select class="status-deal-select status-deal-${current}" data-deal-id="${d.id}" onchange="window._statusChange(this, ${d.id})">${opts}</select>`;
  }

  function ownerSelect(d) {
    const opts = OWNER_OPTIONS.map(u =>
      `<option value="${u.id}" data-name="${esc(u.name)}" ${d.owner_id === u.id ? "selected" : ""}>${esc(u.name)}</option>`
    ).join("");
    return `<select class="owner-deal-select" data-deal-id="${d.id}" onchange="window._ownerChange(this, ${d.id})">${opts}</select>`;
  }

  function catDropdown(d) {
    const current = d.categories || [];
    const tags = current.length > 0
      ? current.map(c => `<span class="cat-tag">${esc(c)}</span>`).join("")
      : `<span class="cat-placeholder">—</span>`;
    const checkboxes = CAT_OPTIONS.map(opt =>
      `<label class="cat-check"><input type="checkbox" value="${opt.id}" data-name="${esc(opt.name)}" ${current.includes(opt.name) ? "checked" : ""}> ${esc(opt.name)}</label>`
    ).join("");
    return `<div class="cat-dropdown-wrap" data-deal-id="${d.id}">
      <div class="cat-tags" onclick="window._catToggleDropdown(this)">${tags}</div>
      <div class="cat-dropdown hidden">
        ${checkboxes}
        <button class="cat-save-btn" onclick="window._catSave(this, ${d.id})">更新</button>
      </div>
    </div>`;
  }

  function dealRow(d, showBillingMonth = false) {
    const wonBadge = d.is_won ? `<span class="badge badge-won">受注</span> ` : "";
    const billingVal = d.billing_month ? d.billing_month.slice(0, 7) : "";
    const billingCell = showBillingMonth
      ? `<td><input type="month" class="billing-input" value="${billingVal}" data-deal-id="${d.id}" onchange="window._billingChange(this, ${d.id})"></td>`
      : "";
    const updatedCell = showBillingMonth
      ? `<td class="updated-cell">${d.updated_at ? d.updated_at.slice(0, 10) : ""}</td>`
      : "";
    const amountRaw = d.amount ?? 0;
    return `<tr>
      <td>${esc(d.company || d.name)}</td>
      <td>${catDropdown(d)}</td>
      <td>${yomiSelect(d)}</td>
      <td class="num"><input type="number" class="amount-input" value="${amountRaw}" data-deal-id="${d.id}" onchange="window._amountChange(this, ${d.id})"></td>
      <td class="num">${yen(d.weighted_amount)}</td>
      <td>${wonBadge}${statusSelect(d)}</td>
      ${billingCell}
      <td>${ownerSelect(d)}</td>
      ${updatedCell}
    </tr>`;
  }

  // ===== ダッシュボード内案件リスト =====
  function renderDashboardDeals() {
    const deals = filteredDeals(activeYomi);
    const tbody = document.getElementById("deals-body-dashboard");
    if (deals.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-sub);padding:24px">該当案件なし</td></tr>`;
    } else {
      tbody.innerHTML = deals.map(d => dealRow(d, false)).join("");
    }
  }

  // ===== 案件一覧タブ =====
  function renderDealsList() {
    const catFilter          = document.getElementById("cat-filter").value;
    const phaseFilter        = document.getElementById("phase-filter").value;
    const billingMonthFilter = document.getElementById("billing-month-filter")?.value ?? "";
    const showAllMonths      = document.getElementById("show-all-months").checked || !!billingMonthFilter;

    // 全月表示ONなら all_deals、OFFなら今月分（deals）
    const source = showAllMonths
      ? (DATA.all_deals ?? DATA.deals ?? [])
      : (DATA.deals ?? []);

    const deals = source.filter(d => {
      if (activeOwner && d.owner !== activeOwner) return false;
      if (catFilter && !(d.categories || []).includes(catFilter)) return false;
      if (phaseFilter && !d.phase.includes(phaseFilter)) return false;
      if (billingMonthFilter && !d.billing_month?.startsWith(billingMonthFilter)) return false;
      return true;
    });

    const sorted = sortDeals(deals);
    const tbody = document.getElementById("deals-body-list");
    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-sub);padding:24px">該当案件なし</td></tr>`;
    } else {
      tbody.innerHTML = sorted.map(d => dealRow(d, true)).join("");
    }
  }

  // ===== タスク管理タブ（会社別ビュー）=====
  const STATUSES = {
    todo:      { label: "未対応", cls: "status-todo",      active: true  },
    doing:     { label: "対応中", cls: "status-doing",     active: true  },
    done:      { label: "完了",   cls: "status-done",      active: false },
    cancelled: { label: "中止",   cls: "status-cancelled", active: false },
  };
  const STANDING_TITLES = ["次回打ち合わせの準備", "本日のお礼メールの送付", "次回打ち合わせ日程の調整"];

  function taskCard(id, labelClass, labelText, title, meta = "", deletable = false, defaultDue = "") {
    const status = getTaskStatus(id);
    const st = STATUSES[status] ?? STATUSES.todo;
    const opts = Object.entries(STATUSES).map(([v, s]) =>
      `<option value="${v}" ${status === v ? "selected" : ""}>${s.label}</option>`
    ).join("");

    const due = getTaskDue(id) || defaultDue;
    const dueClass = due && due < new Date().toISOString().slice(0, 10) ? "due-overdue" : "";
    const taskOwnerVal = getTaskOwner(id);
    const ownerOpts = `<option value="">担当: -</option>` +
      OWNER_OPTIONS.map(u => `<option value="${esc(u.name)}" ${taskOwnerVal === u.name ? "selected" : ""}>${esc(u.name)}</option>`).join("");
    const taskOwnerRow = `<div class="task-owner-row"><select class="task-owner-select" data-task-id="${esc(id)}" onchange="window._setTaskOwner('${esc(id)}',this.value)">${ownerOpts}</select></div>`;
    const comments = getComments(id);
    const isOpen = openComments.has(id);
    const commentListHtml = comments.length > 0
      ? comments.map(c => {
          const d = new Date(c.ts);
          const t = d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `<div class="comment-item"><span class="comment-text">${esc(c.text)}</span><span class="comment-ts">${t}</span></div>`;
        }).join("")
      : `<p class="no-comments">コメントなし</p>`;
    const commentCount = comments.length > 0 ? `<span class="comment-count">${comments.length}</span>` : "";
    const deleteBtn = deletable
      ? `<button class="task-delete-btn" onclick="window._deleteTask('${esc(id)}')" title="削除">✕</button>` : "";

    return `<div class="task-card ${st.active ? "" : "task-inactive"}">
      <div class="task-card-top">
        <div class="task-card-main">
          <span class="task-label ${labelClass}">${labelText}</span>
          <div class="task-card-body">
            <div class="task-title">${esc(title)}</div>
            <div class="task-due-row">
              <input type="date" class="task-due-input ${dueClass}" value="${esc(due)}" data-task-id="${esc(id)}"
                onchange="window._setTaskDue('${esc(id)}',this.value)">
            </div>
            ${taskOwnerRow}
            ${meta ? `<div class="task-meta">${meta}</div>` : ""}
          </div>
        </div>
        <div class="task-card-right">
          <button class="comment-btn ${isOpen ? "comment-btn-open" : ""}" onclick="window._toggleComments('${esc(id)}')" title="コメント">💬${commentCount}</button>
          ${deleteBtn}
          <select class="status-select ${st.cls}" data-task-id="${esc(id)}" onchange="window._taskStatusChange(this)">${opts}</select>
        </div>
      </div>
      <div class="task-comment-panel ${isOpen ? "" : "hidden"}">
        <div class="comment-list">${commentListHtml}</div>
        <div class="comment-input-row">
          <input type="text" class="comment-input" placeholder="コメントを追加..." data-task-id="${esc(id)}"
            onkeydown="if(event.key==='Enter')window._submitComment('${esc(id)}',this)">
          <button class="comment-submit" onclick="window._submitComment('${esc(id)}',this.previousElementSibling)">送信</button>
        </div>
      </div>
    </div>`;
  }

  let activeTaskYomi  = "";
  let activeTaskMonth = "";
  let activeTaskDue   = "";

  function initTaskFilters() {
    const yomiFil  = document.getElementById("task-yomi-filter");
    const monthFil = document.getElementById("task-month-filter");
    if (!yomiFil || !monthFil) return;

    // 計上月の選択肢を all_deals から生成
    const months = [...new Set(
      (DATA.all_deals ?? []).map(d => d.billing_month ? d.billing_month.slice(0, 7) : "").filter(Boolean)
    )].sort().reverse();
    months.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = "計上月: " + m.replace("-", "年") + "月";
      monthFil.appendChild(opt);
    });

    yomiFil.addEventListener("change",  () => { activeTaskYomi  = yomiFil.value;  renderTasks(); });
    monthFil.addEventListener("change", () => { activeTaskMonth = monthFil.value; renderTasks(); });

    const dueFil = document.getElementById("task-due-filter");
    if (dueFil) dueFil.addEventListener("change", () => { activeTaskDue = dueFil.value; renderTasks(); });
  }

  function renderTasks() {
    const el = document.getElementById("task-companies");
    if (!el) return;

    const slackAll  = DATA.tasks?.slack          ?? [];
    const naAll     = DATA.tasks?.next_action    ?? [];
    const dealComps = DATA.tasks?.deal_companies ?? [];

    const slack = activeOwner ? slackAll.filter(t => !t.owner || t.owner === activeOwner) : slackAll;
    const na    = activeOwner ? naAll.filter(t => t.owner === activeOwner) : naAll;
    const dcs   = activeOwner ? dealComps.filter(dc => !dc.owner || dc.owner === activeOwner) : dealComps;

    const companies = new Map();
    const meetingsByCompany = new Map();

    // 管理対象全会社を起点にセクションを生成（updated_atも保持）
    const companyUpdatedAt = new Map();
    for (const dc of dcs) {
      const key = dc.company ?? "（会社不明）";
      if (!companies.has(key)) companies.set(key, { slack: [], na: [], custom: [], owner: dc.owner });
      if (dc.updated_at) companyUpdatedAt.set(key, dc.updated_at);
    }
    for (const t of slack) {
      const key = t.company ?? "（会社不明）";
      if (!companies.has(key)) companies.set(key, { slack: [], na: [], custom: [], owner: t.owner });
      companies.get(key).slack.push(t);
      if (!meetingsByCompany.has(key)) meetingsByCompany.set(key, new Set());
      meetingsByCompany.get(key).add(t.source_ts);
    }
    for (const t of na) {
      const key = t.company ?? "（会社不明）";
      if (!companies.has(key)) companies.set(key, { slack: [], na: [], custom: [], owner: t.owner });
      companies.get(key).na.push(t);
    }
    // カスタムタスク（新規会社セクションも生成）
    for (const t of Object.values(loadCustomTasks())) {
      const key = t.company ?? "（会社不明）";
      if (!companies.has(key)) companies.set(key, { slack: [], na: [], custom: [], owner: null });
      companies.get(key).custom.push(t);
    }

    if (companies.size === 0) {
      el.innerHTML = `<p class="task-empty" style="padding:24px">タスクなし</p>`;
      return;
    }

    const allDeals = DATA.all_deals ?? DATA.deals ?? [];

    // 計上月・ヨミフィルタ: 会社に紐づく案件でマッチング
    function companyMatchesFilter(company) {
      if (!activeTaskYomi && !activeTaskMonth) return true;
      const deal = allDeals.find(d => (d.company || d.name) === company);
      if (!deal) return !activeTaskYomi && !activeTaskMonth; // 案件なし会社はフィルタ時除外
      if (activeTaskYomi  && deal.yomi !== activeTaskYomi)                          return false;
      if (activeTaskMonth && !deal.billing_month?.startsWith(activeTaskMonth))      return false;
      return true;
    }

    // updated_at 降順でソート
    const sortedCompanies = [...companies.entries()].sort(([a], [b]) => {
      const ua = companyUpdatedAt.get(a) ?? "";
      const ub = companyUpdatedAt.get(b) ?? "";
      return ub.localeCompare(ua);
    });

    let html = "";
    for (const [company, { slack: sTasks, na: naTasks, custom: cTasks, owner }] of sortedCompanies) {
      if (!companyMatchesFilter(company)) continue;
      const meetingTsList = meetingsByCompany.get(company) ?? new Set();
      const updatedAt = companyUpdatedAt.get(company) ?? "";
      const updatedLabel = updatedAt
        ? `<span class="company-updated-at">GoCoo更新: ${updatedAt.slice(0, 10)}</span>` : "";
      const ownerChip = owner ? `<span class="owner-chip">${esc(owner)}</span>` : "";

      // 案件情報バー
      const deal = allDeals.find(d => (d.company || d.name) === company);
      let dealInfoBar = "";
      if (deal) {
        const catTags = (deal.categories || [])
          .filter(c => c !== "未分類")
          .map(c => `<span class="cat-tag">${esc(c)}</span>`).join(" ");
        dealInfoBar = `<div class="deal-info-bar">
          <span class="badge badge-${deal.yomi}">${esc(deal.yomi || "—")}</span>
          ${catTags}
          <span class="deal-amount">${yen(deal.amount)}</span>
        </div>`;
      }

      // タスクカードを active / inactive に振り分け
      const activeTasks = [];
      const inactiveTasks = [];

      function classify(card, id) {
        if (activeTaskDue) {
          const due = getTaskDue(id);
          const today = new Date().toISOString().slice(0, 10);
          let matches = false;
          if (activeTaskDue === "overdue") {
            matches = !!due && due < today;
          } else if (activeTaskDue === "today") {
            matches = due === today;
          } else if (activeTaskDue === "week") {
            const weekEnd = new Date();
            weekEnd.setDate(weekEnd.getDate() + 7);
            const weekEndStr = weekEnd.toISOString().slice(0, 10);
            matches = !!due && due >= today && due <= weekEndStr;
          } else if (activeTaskDue === "none") {
            matches = !due;
          }
          if (!matches) return;
        }
        const s = STATUSES[getTaskStatus(id)] ?? STATUSES.todo;
        (s.active ? activeTasks : inactiveTasks).push(card);
      }

      for (const t of sTasks) {
        classify(taskCard(t.id, "slack-label", "NA", t.title), t.id);
      }
      for (const t of naTasks) {
        classify(
          taskCard(t.id, "na-label", "GoCoo", t.next_action,
            `<span class="badge badge-${t.yomi}">${esc(t.yomi || "—")}</span><span class="phase-text">${esc(t.phase)}</span>`),
          t.id
        );
      }
      for (const ts of meetingTsList) {
        const meetingDate = new Date(parseFloat(ts) * 1000).toISOString().slice(0, 10);
        for (let i = 0; i < STANDING_TITLES.length; i++) {
          const id = `standing-${company}-${ts}-${i}`;
          classify(taskCard(id, "standing-label", "定常", STANDING_TITLES[i], "", false, meetingDate), id);
        }
      }
      // Slack議事録がない会社にも定常タスクを追加（全管理対象で定常を持てるように）
      if (meetingTsList.size === 0) {
        for (let i = 0; i < STANDING_TITLES.length; i++) {
          const id = `standing-${company}-base-${i}`;
          classify(taskCard(id, "standing-label", "定常", STANDING_TITLES[i], "", false, ""), id);
        }
      }
      for (const t of (cTasks ?? [])) {
        classify(taskCard(t.id, "custom-label", "追加", t.title, "", true), t.id);
      }

      const completedSection = inactiveTasks.length > 0
        ? `<details class="completed-section">
            <summary>対応済み (${inactiveTasks.length}件)</summary>
            <div class="completed-cards">${inactiveTasks.join("")}</div>
          </details>` : "";

      html += `<section class="company-task-group">
        <div class="company-task-header">
          <span class="company-task-name">${esc(company)}</span>
          ${ownerChip}
          ${updatedLabel}
        </div>
        ${dealInfoBar}
        <div class="task-cards">${activeTasks.join("") || '<p class="task-empty" style="padding:8px 12px">アクティブなタスクなし</p>'}</div>
        ${completedSection}
        <div class="add-task-row">
          <input type="text" class="add-task-input" placeholder="+ タスクを追加..."
            onkeydown="if(event.key==='Enter'&&this.value.trim())window._addCustomTask('${esc(company)}',this)">
          <button class="add-task-btn" onclick="window._addCustomTask('${esc(company)}',this.previousElementSibling)">追加</button>
        </div>
      </section>`;
    }

    el.innerHTML = html;
  }

  // グローバルハンドラ
  window._toggleComments = function(taskId) {
    if (openComments.has(taskId)) openComments.delete(taskId);
    else openComments.add(taskId);
    renderTasks();
  };

  window._submitComment = function(taskId, input) {
    const text = input.value.trim();
    if (!text) return;
    addComment(taskId, text);
    openComments.add(taskId);
    renderTasks();
  };

  window._addCustomTask = function(company, input) {
    const title = input.value.trim();
    if (!title) return;
    saveCustomTask(company, title);
    input.value = "";
    renderTasks();
  };

  window._addNewCompanyTask = function() {
    const company = document.getElementById("new-task-company").value.trim();
    const title   = document.getElementById("new-task-title").value.trim();
    if (!company || !title) { toast("会社名とタスク内容を入力してください", "error"); return; }
    saveCustomTask(company, title);
    document.getElementById("new-task-company").value = "";
    document.getElementById("new-task-title").value = "";
    renderTasks();
  };

  window._setTaskOwner = function(taskId, owner) {
    setTaskOwner(taskId, owner);
  };

  window._ownerChange = async function(select, dealId) {
    const newOwnerId = parseInt(select.value, 10);
    const opt = select.options[select.selectedIndex];
    const newOwnerName = opt?.dataset?.name ?? opt?.textContent ?? "";

    const origDeal = [...(DATA.all_deals ?? []), ...(DATA.deals ?? [])].find(d => d.id === dealId);
    const origOwnerId = origDeal?.owner_id ?? null;
    const origOwnerName = origDeal?.owner ?? "";

    // 楽観的更新
    for (const arr of [DATA.deals, DATA.all_deals]) {
      const d = (arr ?? []).find(d => d.id === dealId);
      if (d) { d.owner = newOwnerName; d.owner_id = newOwnerId; }
    }
    setPending(dealId, "owner", newOwnerName);
    setPending(dealId, "owner_id", newOwnerId);
    renderDashboardDeals();
    renderDealsList();

    const ok = await triggerUpdate(dealId, F_OWNER, newOwnerId);
    if (!ok) {
      for (const arr of [DATA.deals, DATA.all_deals]) {
        const d = (arr ?? []).find(d => d.id === dealId);
        if (d) { d.owner = origOwnerName; d.owner_id = origOwnerId; }
      }
      clearPending(dealId, "owner");
      clearPending(dealId, "owner_id");
      renderDashboardDeals();
      renderDealsList();
    }
  };

  window._setTaskDue = function(taskId, date) {
    setTaskDue(taskId, date);
    // 期限切れクラスのみ即時更新（再描画なし）
    const input = document.querySelector(`.task-due-input[data-task-id="${taskId}"]`);
    if (input) {
      const today = new Date().toISOString().slice(0, 10);
      input.classList.toggle("due-overdue", !!date && date < today);
    }
  };

  window._deleteTask = function(taskId) {
    deleteCustomTask(taskId);
    openComments.delete(taskId);
    renderTasks();
  };

  window._statusChange = async function(select, dealId) {
    const newStatus = select.value;
    const newPathId = PATH_ID[newStatus] ?? PATH_ID["商談中"];
    const newPhase  = PATH_PHASE_FROM_ID[newPathId] ?? "";

    const deal = [...(DATA.all_deals ?? []), ...(DATA.deals ?? [])].find(d => d.id === dealId);
    const origPhase = deal?.phase ?? "";

    select.disabled = true;
    optimisticUpdate(dealId, "phase", newPhase);
    select.className = `status-deal-select status-deal-${newStatus}`;

    const ok = await triggerUpdate(dealId, F_PATH, newPathId);
    select.disabled = false;
    if (!ok) {
      revertUpdate(dealId, "phase", origPhase);
      select.value = deriveStatus(origPhase);
      select.className = `status-deal-select status-deal-${deriveStatus(origPhase)}`;
    }
  };

  window._taskStatusChange = function(select) {
    setTaskStatus(select.dataset.taskId, select.value);
    renderTasks();
  };

  window._catToggleDropdown = function(el) {
    document.querySelectorAll(".cat-dropdown:not(.hidden)").forEach(d => {
      if (!el.parentElement.contains(d)) d.classList.add("hidden");
    });
    el.nextElementSibling.classList.toggle("hidden");
  };

  window._catSave = async function(btn, dealId) {
    const wrap = btn.closest(".cat-dropdown-wrap");
    const checked = [...wrap.querySelectorAll("input[type=checkbox]:checked")];
    const ids = checked.map(cb => parseInt(cb.value, 10));
    btn.disabled = true;
    const ok = await triggerUpdate(dealId, F_CATEGORIES, ids);
    btn.disabled = false;
    if (ok) {
      const names = checked.map(cb => cb.dataset.name);
      wrap.querySelector(".cat-tags").innerHTML = names.length > 0
        ? names.map(n => `<span class="cat-tag">${esc(n)}</span>`).join("")
        : `<span class="cat-placeholder">—</span>`;
      wrap.querySelector(".cat-dropdown").classList.add("hidden");
      const update = d => { if (d.id === dealId) d.categories = names; };
      (DATA.all_deals ?? []).forEach(update);
      (DATA.deals ?? []).forEach(update);
    }
  };

  window._yomiChange = async function(select, dealId) {
    const newYomi = select.value;
    if (!newYomi) return;
    const origYomi = (DATA.all_deals ?? DATA.deals ?? []).find(d => d.id === dealId)?.yomi ?? "";
    const choiceId = YOMI_OPTIONS[newYomi];

    // 楽観的更新: DATA + サマリー即時反映
    optimisticUpdate(dealId, "yomi", newYomi);
    select.className = `yomi-select badge badge-${newYomi}`;
    select.disabled = true;

    const ok = await triggerUpdate(dealId, F_YOMI, choiceId);
    select.disabled = false;
    if (!ok) {
      revertUpdate(dealId, "yomi", origYomi);
      select.value = origYomi || "";
      select.className = `yomi-select badge badge-${origYomi || "none"}`;
    }
    // 成功時はペンディングをそのまま保持（hourly fetchがGoCooの更新を拾うまで保護）
  };

  window._amountChange = async function(input, dealId) {
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) return;
    const origAmount = (DATA.all_deals ?? DATA.deals ?? []).find(d => d.id === dealId)?.amount ?? 0;

    optimisticUpdate(dealId, "amount", val);
    input.disabled = true;

    const ok = await triggerUpdate(dealId, F_AMOUNT, val);
    input.disabled = false;
    if (!ok) {
      revertUpdate(dealId, "amount", origAmount);
      input.value = origAmount;
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
    document.getElementById("billing-month-filter")?.addEventListener("change", renderDealsList);
  }

  function initBillingMonthFilter() {
    const sel = document.getElementById("billing-month-filter");
    if (!sel) return;
    const months = [...new Set(
      (DATA.all_deals ?? []).map(d => d.billing_month ? d.billing_month.slice(0, 7) : "").filter(Boolean)
    )].sort().reverse();
    months.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m.replace("-", "年") + "月";
      sel.appendChild(opt);
    });
  }

  // ===== 起動 =====
  async function main() {
    // 共有ストアをバックグラウンドで取得（認証と並行）
    const sharedStatePromise = loadSharedState();
    const authed = await checkAuth();

    if (!authed) {
      document.getElementById("pw-btn").addEventListener("click", async () => {
        const pw = document.getElementById("pw-input").value;
        const errEl = document.getElementById("pw-error");
        errEl.classList.add("hidden");
        try {
          await Promise.all([loadData(pw), sharedStatePromise]);
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
        await Promise.all([loadData(getSavedPassword()), sharedStatePromise]);
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

  function initRefreshButton() {
    const btn = document.getElementById("refresh-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "⏳";
      try {
        await Promise.all([loadData(getSavedPassword()), loadSharedState()]);
        renderAll();
        toast("データを更新しました", "success");
      } catch {
        toast("更新に失敗しました", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "🔄";
      }
    });
  }

  function initApp() {
    initOwnerOptions();
    renderHeader();
    initTabs();
    initYomiFilter();
    initDealsFilter();
    initBillingMonthFilter();
    initSortHeaders();
    initPatButton();
    initRefreshButton();
    initTaskFilters();
    document.addEventListener("click", e => {
      if (!e.target.closest(".cat-dropdown-wrap")) {
        document.querySelectorAll(".cat-dropdown:not(.hidden)").forEach(d => d.classList.add("hidden"));
      }
    });
    renderAll();
  }

  function initPatButton() {
    const btn = document.getElementById("pat-setting-btn");
    if (!btn) return;
    updatePatBtn();
    btn.addEventListener("click", () => {
      const current = getPat();
      const isOverride = !!localStorage.getItem(PAT_KEY);
      const sourceNote = isOverride ? "（ローカル上書き中）" : "（サーバー共有）";
      const label = current
        ? `現在のPAT: ${current.slice(0, 8)}...${sourceNote}\n\n独自PATを入力（空欄にするとサーバー共有PATに戻る）:`
        : "GitHub PAT を入力してください（空欄にするとサーバー共有PATを使用）:";
      const val = prompt(label, current);
      if (val !== null) {
        const trimmed = val.trim();
        savePat(trimmed);
        updatePatBtn();
        if (trimmed) {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(trimmed).then(() => {
              toast("PAT を保存しました（クリップボードにコピー済み）", "success");
            }).catch(() => {
              toast("PAT を保存しました", "success");
            });
          } else {
            toast("PAT を保存しました", "success");
          }
        } else {
          toast("PAT をクリアしました", "success");
        }
      }
    });
  }

  function updatePatBtn() {
    const btn = document.getElementById("pat-setting-btn");
    if (!btn) return;
    const hasPat = !!getPat();
    btn.style.background = hasPat ? "var(--success)" : "var(--warning)";
    btn.title = hasPat ? "PAT設定済み（クリックして変更）" : "PAT未設定（クリックして設定）";
  }

  main();
})();
