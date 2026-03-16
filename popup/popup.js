const $ = id => document.getElementById(id);
let logsOpen = false;

document.addEventListener("DOMContentLoaded", () => {
  checkTabs();
  loadState();
  $("runBtn").addEventListener("click", onRun);
  $("logsToggle").addEventListener("click", toggleLogs);
  $("resetBtn").addEventListener("click", onReset);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "STATE_UPDATE") render(msg.state);
    if (msg.type === "LOG_ENTRY" && logsOpen) appendLog(msg.entry);
  });
});

// ── TAB CHECK ─────────────────────────────────────────────────────────────────
async function checkTabs() {
  const tabs = await chrome.tabs.query({});
  const patterns = {
    zepto:   /zeptonow\.com|zepto\.com/,
    blinkit: /blinkit\.com|grofers\.com/,
    swiggy:  /swiggy\.com/,
  };
  for (const [name, re] of Object.entries(patterns)) {
    const found = tabs.find(t => t.url && re.test(t.url));
    const pill = $(`pill-${name}`);
    const stat = $(`pstat-${name}`);
    if (pill && stat) {
      if (found) { pill.classList.add("open"); stat.textContent = "Open ✓"; }
      else { pill.classList.remove("open"); stat.textContent = "Not open"; }
    }
  }
}

function loadState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, res => {
    if (!chrome.runtime.lastError && res?.state?.status !== "idle") render(res.state);
  });
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
function onRun() {
  $("runBtn").disabled = true;
  $("spinner").style.display = "inline-block";
  $("btnLabel").textContent = "Agent Running…";
  $("emptyState").style.display = "none";
  $("results").style.display = "none";
  $("planSection").style.display = "block";
  setStatus("active", "🧠 Starting agent…");
  chrome.runtime.sendMessage({ type: "START_AGENT" }, res => {
    if (chrome.runtime.lastError) { setStatus("error", "❌ " + chrome.runtime.lastError.message); resetBtn(); }
  });
}

function onReset() {
  chrome.runtime.sendMessage({ type: "RESET_AGENT" });
  $("emptyState").style.display = "block";
  $("results").style.display = "none";
  $("planSection").style.display = "none";
  $("logsPanel").innerHTML = "";
  resetBtn();
  setStatus("", "Ready — click Run Agent");
  checkTabs();
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render(state) {
  if (!state) return;
  const elapsed = state.startTime ? ((Date.now() - state.startTime) / 1000).toFixed(1) : "—";
  const STATUS = {
    idle:      { dot: "",       txt: "Ready — click Run Agent" },
    planning:  { dot: "active", txt: "🧠 Planning…" },
    scraping:  { dot: "active", txt: "🛒 Reading your Zepto cart…" },
    searching: { dot: "active", txt: "🔄 Searching prices on Blinkit & Swiggy…" },
    comparing: { dot: "active", txt: "🧮 Comparing with AI…" },
    done:      { dot: "done",   txt: `✅ Done in ${elapsed}s — ${state.llmProvider}` },
    error:     { dot: "error",  txt: "❌ " + (state.error || "Error") },
  };
  const s = STATUS[state.status] || STATUS.idle;
  setStatus(s.dot, s.txt);

  if (state.plan?.length) renderPlan(state.plan);

  if (state.status === "done" && state.comparison) {
    renderResults(state);
    resetBtn("🔄 Run Again");
  } else if (state.status === "error") {
    resetBtn("⚡ Retry");
    showError(state.error);
  }
}

function renderPlan(steps) {
  const ICONS = { pending:"○", active:"◉", done:"✓", error:"✗" };
  $("planSteps").innerHTML = steps.map(s => `
    <div class="plan-step ${s.status}">
      <span class="si">${ICONS[s.status]||"○"}</span>
      <span class="sd">${esc(s.desc)}</span>
      <span class="st ${s.status}">${s.status}</span>
    </div>`).join("");
}

// ── RESULTS ───────────────────────────────────────────────────────────────────
function renderResults(state) {
  const { comparison, zeptoCart } = state;
  $("emptyState").style.display = "none";
  $("planSection").style.display = "none";
  $("results").style.display = "block";

  // Guardrail
  if (comparison.guardrailIssues?.length) {
    $("gbox").style.display = "flex";
    $("gtxt").textContent = comparison.guardrailIssues.join(" • ");
  }

  // Summary (if LLM provided one)
  if (comparison.summary) {
    $("summaryCard").style.display = "block";
    $("summaryText").textContent = comparison.summary;
  }

  // Winner
  const rec = comparison.recommendation || {};
  const bp = rec.bestPlatform || "";
  $("wName").textContent = cap(bp);
  $("wName").className = "wn " + bp;
  $("wReason").textContent = rec.reason || "";
  $("wSave").textContent = rec.totalSavings > 0 ? `Save ₹${rec.totalSavings}` : "Best available";
  $("wConf").textContent = `Confidence: ${rec.confidence || "—"}`;

  // Platform totals
  const totals = comparison.platformTotals || {};
  for (const p of ["zepto", "blinkit", "swiggy"]) {
    const d = totals[p] || {};
    $(`pt-${p}`).textContent = d.subtotal > 0 ? `₹${d.subtotal}` : "—";
    $(`pc-${p}`).classList.toggle("winner", p === bp);
    const info = [];
    if (d.itemsFound > 0) info.push(`${d.itemsFound}/${zeptoCart?.length || "?"} items`);
    if (d.itemsMissing > 0) info.push(`${d.itemsMissing} missing`);
    $(`po-${p}`).textContent = info.join(" · ");
  }

  // Item table
  const rows = comparison.itemComparison || [];
  $("tbody").innerHTML = rows.map(row => {
    const prices = ["zepto","blinkit","swiggy"].map(p => row[p]?.price).filter(Boolean);
    const min = prices.length ? Math.min(...prices) : null;
    const cells = ["zepto","blinkit","swiggy"].map(p => {
      const d = row[p];
      if (!d?.available || !d.price) {
        const why = d?.reason || "N/A";
        return `<td class="pc na" title="${esc(why)}">—</td>`;
      }
      const isBest = d.price === min;
      return `<td class="pc${isBest?" best":""}" title="${esc(d.name||"")}">₹${d.price}${isBest?" ★":""}</td>`;
    }).join("");
    const qtyBadge = row.qty > 1 ? `<span class="qty">×${row.qty}</span>` : "";
    return `<tr><td class="iname" title="${esc(row.item)}">${esc(row.item.slice(0,26))}${row.item.length>26?"…":""}${qtyBadge}</td>${cells}</tr>`;
  }).join("");

  // Alternatives / not found
  const alts = (comparison.alternatives || []).filter(a => a.notAvailableOn?.length > 0);
  if (alts.length) {
    $("altSec").style.display = "block";
    $("altList").innerHTML = alts.map(a => `
      <div class="alt">
        <span class="alt-name">${esc(a.originalItem)}</span>
        <span class="alt-miss">Not on: ${a.notAvailableOn.join(", ")}</span>
        ${a.alternatives?.length ? a.alternatives.map(x => `<span class="alt-sug">→ "${esc(x.name)}" on ${x.platform}</span>`).join("") : ""}
      </div>`).join("");
  }

  // Split strategy
  const split = comparison.splitStrategy;
  if (split?.possible && split.savings > 0) {
    $("splitCard").style.display = "block";
    $("splitDesc").textContent = split.desc;
    $("splitSave").textContent = `Max item-level savings: ₹${split.savings}`;
  }

  $("fstat").textContent = `${zeptoCart?.length || 0} items from Zepto · LLM: ${state.llmProvider}`;
}

// ── LOGS ──────────────────────────────────────────────────────────────────────
function toggleLogs() {
  logsOpen = !logsOpen;
  $("logsPanel").classList.toggle("open", logsOpen);
  $("logsArrow").textContent = logsOpen ? "▲" : "▼";
  if (logsOpen) {
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, res => {
      if (res?.logs) { $("logsPanel").innerHTML = ""; res.logs.forEach(appendLog); }
    });
  }
}

function appendLog(e) {
  const p = $("logsPanel");
  if (!p || !logsOpen) return;
  const d = document.createElement("div");
  d.className = `le ${e.level}`;
  d.innerHTML = `<span class="lt">${new Date(e.ts).toLocaleTimeString("en",{hour12:false})}</span>${esc(e.msg)}`;
  p.appendChild(d);
  p.scrollTop = p.scrollHeight;
}

// ── UTILS ──────────────────────────────────────────────────────────────────────
function setStatus(dot, txt) {
  $("statusDot").className = "sdot" + (dot ? " " + dot : "");
  $("statusText").innerHTML = txt;
}
function resetBtn(label = "⚡ Run Price Agent") {
  $("runBtn").disabled = false;
  $("spinner").style.display = "none";
  $("btnLabel").textContent = label;
}
function showError(msg) {
  $("emptyState").style.display = "block";
  $("emptyState").innerHTML = `<div class="eicon">⚠️</div><div class="emsg err">${esc(msg)}</div>
    <div class="ehint"><b>Quick fixes:</b><br>
    • On Zepto: open your cart (tap 🛒 icon)<br>
    • Make sure you're on zepto.com — URL check<br>
    • Add at least 1 item to Zepto cart<br>
    • Keep Blinkit &amp; Swiggy open in other tabs</div>`;
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
