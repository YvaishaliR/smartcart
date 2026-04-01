// SmartCart AI v4 — Background Agent
// Flow: Scrape Zepto cart panel → Search each item on Blinkit & Swiggy → Compare

let S = {
  status: "idle",
  zeptoCart: [],
  prices: { zepto: {}, blinkit: {}, swiggy: {} },
  offers: { zepto: [], blinkit: [], swiggy: [] },
  comparison: null,
  plan: [],
  logs: [],
  startTime: null,
  error: null,
  llmProvider: "none",
  tabsFound: {},
  debug: {},  // extra debug info shown in UI
};

// ── LOGGING ───────────────────────────────────────────────────────────────────
function log(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  S.logs.push(entry);
  if (S.logs.length > 500) S.logs.shift();
  if (level === "error") console.error("[SmartCart]", msg);
  else if (level === "warn") console.warn("[SmartCart]", msg);
  else console.log("[SmartCart]", msg);
  try { chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }); } catch {}
}
function bcastState() { try { chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: S }); } catch {} }
function setPlan(id, status) {
  const s = S.plan.find(p => p.id === id);
  if (s) { s.status = status; bcastState(); }
}

// ── MESSAGES ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  // Proxy fetch: allow content scripts to request cross-origin resources
  if (msg.type === 'PROXY_FETCH') {
    (async () => {
      try {
        const opts = { method: msg.method || 'GET', headers: msg.headers || {}, credentials: 'include' };
        if (msg.body) opts.body = msg.body;
        const r = await fetch(msg.url, opts);
        const text = await r.text();
        let body = text;
        try { body = JSON.parse(text); } catch {}
        sendResponse({ ok: r.ok, status: r.status, statusText: r.statusText, body });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // keep channel open for async response
  }
  if (msg.type === 'NET_LOG') {
    try {
      S.debug = S.debug || {};
      S.debug.networkLogs = S.debug.networkLogs || [];
      S.debug.networkLogs.push({ ts: Date.now(), entry: msg.entry });
      if (S.debug.networkLogs.length > 200) S.debug.networkLogs.shift();
      log('info', `NET_LOG ${msg.entry.type} ${msg.entry.method||''} ${msg.entry.url||''} ${msg.entry.status||msg.entry.error||''}`);
      sendResponse({ ok: true });
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
    return true;
  }
  if (msg.type === "START_AGENT") {
    runAgent().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "GET_STATE")   { sendResponse({ state: S }); return true; }
  if (msg.type === "RESET_AGENT") { resetState(); bcastState(); sendResponse({ ok: true }); return true; }
  if (msg.type === "GET_LOGS")    { sendResponse({ logs: S.logs }); return true; }
});

function resetState() {
  S = { status:"idle", zeptoCart:[], prices:{zepto:{},blinkit:{},swiggy:{}},
        offers:{zepto:[],blinkit:[],swiggy:[]}, comparison:null, plan:[], logs:[],
        startTime:null, error:null, llmProvider:"none", tabsFound:{}, debug:{} };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function runAgent() {
  resetState();
  S.startTime = Date.now();
  S.status = "planning";
  S.plan = [
    { id:1, status:"active",  desc:"🧠 Plan strategy" },
    { id:2, status:"pending", desc:"🔍 Find open grocery tabs" },
    { id:3, status:"pending", desc:"🛒 Scrape Zepto cart panel" },
    { id:4, status:"pending", desc:"🔄 Search items on Blinkit" },
    { id:5, status:"pending", desc:"🔄 Search items on Swiggy" },
    { id:6, status:"pending", desc:"🧮 Compare & recommend" },
    { id:7, status:"pending", desc:"🛡️ Guardrail checks" },
  ];
  bcastState();
  log("info", "🚀 Agent v5 started");

  try {
    // 1. Plan
    await llm("Reply OK", { fallback: "OK", max: 5 });
    setPlan(1, "done");

    // 2. Tabs
    setPlan(2, "active");
    await detectTabs();
    log("info", `Tabs found: ${JSON.stringify(S.tabsFound)}`);
    if (!S.tabsFound.zepto) throw new Error("No Zepto tab found. Open zepto.com in a tab first.");
    setPlan(2, "done");

    // 3. Scrape Zepto cart
    setPlan(3, "active");
    S.status = "scraping";
    bcastState();

    log("info", "Scraping Zepto cart...");
    const zRes = await msgTab(S.tabsFound.zepto, { type: "SCRAPE_ZEPTO_CART" }, 11000);
    S.zeptoCart = zRes?.items || [];
    S.offers.zepto = zRes?.offers || [];
    S.debug.zeptoUrl = zRes?.url || "";
    S.debug.zeptoRaw = S.zeptoCart.length;

    for (const item of S.zeptoCart) {
      // FIX: Store UNIT price only. Some cart scrapers return the line total (price * qty).
      // Divide by qty here so the totals calc (price * qty) doesn't double-count.
      const unitPrice = (item.qty && item.qty > 1 && item.price > 0)
        ? Math.round((item.price / item.qty) * 100) / 100
        : item.price;
      S.prices.zepto[item.name] = { price: unitPrice, name: item.name, inStock: true, img: item.img, qty: item.qty };
    }

    log("info", `Zepto: ${S.zeptoCart.length} items — [${S.zeptoCart.map(i=>i.name).slice(0,5).join(" | ")}]`);

    if (S.zeptoCart.length === 0) {
      throw new Error(
        "Zepto cart appears empty.\n\nMake sure:\n" +
        "• You're on zepto.com (not app)\n" +
        "• Cart panel is OPEN (click the cart icon 🛒 in top-right)\n" +
        "• You have items in cart\n\n" +
        "Check browser console for [SmartCart] debug logs."
      );
    }
    setPlan(3, "done");

    // 4. Search Blinkit
    setPlan(4, "active");
    S.status = "searching";
    bcastState();
    await searchOnPlatform("blinkit");
    setPlan(4, "done");

    // 5. Search Swiggy
    setPlan(5, "active");
    bcastState();
    await searchOnPlatform("swiggy");
    setPlan(5, "done");

    // 6. Compare
    setPlan(6, "active");
    S.status = "comparing";
    bcastState();
    S.comparison = buildComparison();

    // Try LLM enhancement
    try {
      const llmRes = await llm(buildPrompt(), { max: 800 });
      const parsed = parseJSON(llmRes);
      if (parsed?.recommendation?.bestPlatform) {
        S.comparison.recommendation = { ...S.comparison.recommendation, ...parsed.recommendation };
        if (parsed.summary) S.comparison.summary = parsed.summary;
        S.comparison.llmEnhanced = true;
        log("info", `LLM enhanced ✓ (${S.llmProvider})`);
      }
    } catch {}

    log("info", `Best: ${S.comparison.recommendation?.bestPlatform} | Save ₹${S.comparison.recommendation?.totalSavings}`);
    setPlan(6, "done");

    // 7. Guardrails
    setPlan(7, "active");
    const issues = guardrails();
    S.comparison.guardrailPassed = issues.length === 0;
    S.comparison.guardrailIssues = issues;
    if (issues.length) log("warn", `Guardrail: ${issues.join("|")}`);
    setPlan(7, "done");

    S.status = "done";
    log("info", `✅ Done in ${((Date.now()-S.startTime)/1000).toFixed(1)}s | LLM: ${S.llmProvider}`);
    bcastState();

  } catch (err) {
    S.status = "error";
    S.error = err.message;
    log("error", err.message);
    bcastState();
  }
}

// ── SEARCH ON PLATFORM ────────────────────────────────────────────────────────
async function searchOnPlatform(platform) {
  if (!S.tabsFound[platform]) {
    log("warn", `No ${platform} tab — skipping`);
    for (const item of S.zeptoCart) {
      S.prices[platform][item.name] = { price: null, noTab: true };
    }
    return;
  }

  for (const item of S.zeptoCart) {
    // FIX: Append unit to search query so platforms return correct size variant first.
    // e.g. "Taj Mahal Tea 250g" instead of "Taj Mahal Tea | Rich and Flavourful Chai"
    // This helps both the API ranking AND our variant picker.
    const searchQuery = item.unit
      ? `${item.name.split("|")[0].trim()} ${item.unit}`  // strip after | and add unit
      : item.name.split("|")[0].trim();                    // at minimum strip the | junk
    log("info", `${platform}: searching "${searchQuery}"`);
    const res = await msgTab(S.tabsFound[platform], { type: "SEARCH_ITEM", query: searchQuery }, 11000);
    if (res === null) {
      log("warn", `${platform}: SEARCH_ITEM message to tab ${S.tabsFound[platform]} timed out or failed`);
    } else if (res && res.success === false) {
      log("warn", `${platform}: SEARCH_ITEM handler returned error: ${res.error || 'unknown'}`);
    }
    const results = res?.results || [];

    if (results.length > 0) {
      const best = await pickBest(item.name, results);
      // FIX: Guard null return from pickBest — spreading null gives {} with no price field
      if (best && best.price > 0) {
        // Store result with explicit inStock flag — used by UI to show out-of-stock warning
        S.prices[platform][item.name] = {
          ...best,
          searchedFor: item.name,
          inStock: best.inStock !== false,  // preserve inStock from scraper
        };
        const stockWarn = best.inStock === false ? " ⚠️ OUT OF STOCK" : "";
        log("info", `  → "${best.name}" ₹${best.price} ${best.unit ? "("+best.unit+")" : ""}${stockWarn}`);
      } else {
        S.prices[platform][item.name] = { price: null, notFound: true, name: null };
        log("warn", `  → pickBest returned no valid result on ${platform}`);
      }
    } else {
      // Try with a shorter/simplified query (first 3 meaningful words)
      // Use first 3 words of the cleaned name (already stripped of | content)
      const shortQuery = searchQuery.split(" ").filter(w => w.length > 1).slice(0, 3).join(" ");
      if (shortQuery !== item.name) {
        log("info", `  Retry with short query: "${shortQuery}"`);
        const res2 = await msgTab(S.tabsFound[platform], { type: "SEARCH_ITEM", query: shortQuery }, 11000);
        const results2 = res2?.results || [];
        if (results2.length > 0) {
          const best2 = await pickBest(item.name, results2);
          // FIX: Same null guard for short query path
          if (best2 && best2.price > 0) {
            S.prices[platform][item.name] = {
              ...best2,
              searchedFor: item.name,
              usedShortQuery: shortQuery,
              inStock: best2.inStock !== false,
            };
            const stockWarn2 = best2.inStock === false ? " ⚠️ OUT OF STOCK" : "";
            log("info", `  → "${best2.name}" ₹${best2.price} (short query match)${stockWarn2}`);
          } else {
            S.prices[platform][item.name] = { price: null, notFound: true, name: null };
            log("warn", `  → short query pickBest returned no valid result on ${platform}`);
          }
        } else {
          S.prices[platform][item.name] = { price: null, notFound: true, name: null };
          log("warn", `  → not found on ${platform}`);
        }
      } else {
        S.prices[platform][item.name] = { price: null, notFound: true, name: null };
        log("warn", `  → not found on ${platform}`);
      }
    }
    await sleep(300);
  }
}

// ── TAB DETECTION ─────────────────────────────────────────────────────────────
const TAB_PATTERNS = {
  zepto:   /zeptonow\.com|zepto\.com/,
  blinkit: /blinkit\.com|blinkit\.in|grofers\.com/,
  swiggy:  /swiggy\.com|swiggy\.in/,
};

async function detectTabs() {
  const all = await chrome.tabs.query({});
  S.tabsFound = {};
  for (const tab of all) {
    if (!tab.url || !tab.id) continue;
    for (const [platform, re] of Object.entries(TAB_PATTERNS)) {
      if (re.test(tab.url) && !S.tabsFound[platform]) {
        S.tabsFound[platform] = tab.id;
        try {
          // Clear the guard flag first so the script re-registers its message listener.
          // Critical when the service worker restarts and loses its context.
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => { delete window.__smartcartV7; }
          });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/scraper.js"] });
        } catch (e) { log("warn", `Script inject failed for ${platform}: ${e?.message}`); }
        // Give the content script a moment to register its message handler
        await sleep(800);
        // Ping the tab to ensure the content script is actually running and responsive
        try {
          const ping = await msgTab(tab.id, { type: "PING" }, 3000);
          if (!ping || ping.platform !== platform) {
            log("warn", `Tab ${tab.id} (${tab.url}) did not respond correctly to PING for ${platform}`);
            // don't register this tab as found if it didn't respond correctly
            delete S.tabsFound[platform];
          } else {
            log("info", `Content script active on ${platform} tab ${tab.id} (${tab.url})`);
            S.debug[platform] = { url: tab.url };
          }
        } catch (e) {
          log("warn", `Ping failed for tab ${tab.id}: ${e?.message || e}`);
          delete S.tabsFound[platform];
        }
        await sleep(500);
        break;
      }
    }
  }
}

// ── TAB MSG ────────────────────────────────────────────────────────────────────
function msgTab(tabId, message, timeout = 10000) {
  return new Promise(resolve => {
    const t = setTimeout(() => { log("warn", `Tab ${tabId} msg timeout`); resolve(null); }, timeout);
    try {
      chrome.tabs.sendMessage(tabId, message, res => {
        clearTimeout(t);
        if (chrome.runtime.lastError) {
          log("warn", `Tab msg err: ${chrome.runtime.lastError.message}`);
          resolve(null);
        } else resolve(res);
      });
    } catch (e) { clearTimeout(t); resolve(null); }
  });
}

// ── BEST MATCH ────────────────────────────────────────────────────────────────
async function pickBest(target, candidates) {
  if (!candidates || candidates.length === 0) return null;

  // ── STEP 0: Extract target unit from the search query ─────────────────────
  // e.g. "Godrej Fab 850 ml" → targetQty=850, targetUnit="ml"
  const unitRe = /(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm)/i;
  const targetUnitMatch = target.match(unitRe);
  const targetQty = targetUnitMatch ? parseFloat(targetUnitMatch[1]) : null;
  const rawUnit = targetUnitMatch ? targetUnitMatch[2].toLowerCase() : null;
  const targetUnit = rawUnit === 'ltr' || rawUnit === 'litre' ? 'l' : rawUnit === 'gm' ? 'g' : rawUnit;

  // ── STEP 1: If we have a target unit, filter to size-compatible candidates ─
  // A candidate is compatible if:
  //   a) it has no unit info (unknown size — keep it)
  //   b) its unit matches and size is within 50% of target
  // This removes wildly wrong sizes like 4 ltr when we want 850 ml
  let pool = candidates;
  if (targetQty && targetUnit) {
    const sizeFiltered = candidates.filter(c => {
      const cUnit = (c.unit || "").toLowerCase();
      if (!cUnit) return true; // no unit info, keep
      const m = cUnit.match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm)/i);
      if (!m) return true; // can't parse unit, keep
      const cQty = parseFloat(m[1]);
      const cU = m[2].toLowerCase() === 'ltr' || m[2].toLowerCase() === 'litre' ? 'l'
                : m[2].toLowerCase() === 'gm' ? 'g' : m[2].toLowerCase();
      if (cU !== targetUnit) return false; // different unit type (ml vs g) — exclude
      // Within 60% of target size
      return Math.abs(cQty - targetQty) / targetQty <= 0.6;
    });
    // Only use filtered pool if it has results — otherwise fall back to all candidates
    if (sizeFiltered.length > 0) {
      pool = sizeFiltered;
      log("info", `  Size filter: ${candidates.length} → ${pool.length} candidates for "${target}"`);
    }
  }

  // ── STEP 2: Fuzzy name match within size-filtered pool ────────────────────
  const cleanTarget = target.split("|")[0].replace(unitRe, "").trim(); // strip unit from name match
  const idx = pool.findIndex(c => fuzzy(c.name, cleanTarget));
  if (idx >= 0) return pool[idx];

  // ── STEP 3: LLM pick from filtered pool ──────────────────────────────────
  try {
    const r = await llm(
      `Target: "${cleanTarget}"\nOptions:\n${pool.slice(0,5).map((c,i)=>`${i}. ${c.name} ${c.unit} ₹${c.price}`).join("\n")}\nReturn JSON only: {"i":<number>} or {"i":-1} if no match`,
      { max: 20, fallback: '{"i":0}' }
    );
    const p = parseJSON(r);
    if (p?.i >= 0 && p.i < pool.length) return pool[p.i];
  } catch {}

  // ── STEP 4: Cheapest in-stock from filtered pool ──────────────────────────
  return pool.filter(c => c.inStock !== false).sort((a,b) => a.price - b.price)[0] || pool[0];
}

// ── LLM ───────────────────────────────────────────────────────────────────────
async function llm(prompt, opts = {}) {
  const max = opts.max || 600;

  // Chrome Gemini Nano (free, on-device)
  try {
    if (self.ai?.languageModel) {
      const cap = await self.ai.languageModel.capabilities();
      if (cap?.available !== "no") {
        const sess = await self.ai.languageModel.create({ systemPrompt: "Grocery price comparison AI for India. Return only JSON when asked." });
        const out = await sess.prompt(prompt);
        sess.destroy();
        S.llmProvider = "Chrome Gemini Nano";
        return out;
      }
    }
  } catch {}

  // OpenRouter free
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "HTTP-Referer": "chrome-extension://smartcart" },
      body: JSON.stringify({
        model: "google/gemma-3-4b-it:free",
        max_tokens: max,
        messages: [
          { role: "system", content: "Grocery price comparison AI for India. Return only JSON when asked." },
          { role: "user", content: prompt }
        ]
      })
    });
    if (r.ok) {
      const d = await r.json();
      const t = d?.choices?.[0]?.message?.content;
      if (t) { S.llmProvider = "OpenRouter Gemma 3"; return t; }
    }
  } catch {}

  S.llmProvider = "Rule-based";
  return opts.fallback || "OK";
}

// ── BUILD COMPARISON ──────────────────────────────────────────────────────────
function buildComparison() {
  const platforms = ["zepto", "blinkit", "swiggy"];
  const items = S.zeptoCart;

  const itemRows = items.map(item => {
    const row = { item: item.name, qty: item.qty || 1 };
    let minPrice = Infinity, cheapest = null;
    for (const p of platforms) {
      const d = S.prices[p][item.name];
      if (d?.price && d.price > 0) {
        const inStock = d.inStock !== false;
        row[p] = {
          price: d.price,
          name: d.name,
          available: true,
          inStock,
          unit: d.unit || "",
          // Out of stock items still shown but flagged — don't count toward cheapest
          outOfStock: !inStock,
        };
        // Only count in-stock items for cheapest calculation
        if (inStock && d.price < minPrice) { minPrice = d.price; cheapest = p; }
      } else {
        const reason = d?.noTab ? "Tab not open" : d?.notFound ? "Not found" : "N/A";
        row[p] = { available: false, inStock: false, reason };
      }
    }
    row.cheapest = cheapest;
    const avail = platforms.map(p => row[p]?.price).filter(Boolean);
    row.savings = avail.length > 1 ? Math.round(Math.max(...avail) - Math.min(...avail)) : 0;
    return row;
  });

  const totals = {};
  for (const p of platforms) {
    let sum = 0, found = 0, missing = 0;
    for (const item of items) {
      const d = S.prices[p][item.name];
      if (d?.price > 0 && d?.inStock !== false) {
        sum += d.price * (item.qty || 1); found++;
      } else if (d?.price > 0 && d?.inStock === false) {
        // Out of stock — count as missing for total purposes
        missing++;
      } else {
        missing++;
      }
    }
    totals[p] = { subtotal: Math.round(sum*100)/100, itemsFound: found, itemsMissing: missing, offers: S.offers[p] || [] };
  }

  const ranked = platforms.filter(p => totals[p].itemsFound > 0)
    .sort((a,b) => {
      if (totals[b].itemsFound !== totals[a].itemsFound) return totals[b].itemsFound - totals[a].itemsFound;
      return totals[a].subtotal - totals[b].subtotal;
    });

  const best = ranked[0] || "zepto";
  const second = ranked.find(p => p !== best);
  const savings = second ? Math.max(0, Math.round((totals[second]?.subtotal || 0) - (totals[best]?.subtotal || 0))) : 0;

  return {
    recommendation: {
      bestPlatform: best,
      reason: savings > 0
        ? `${cap(best)} saves ₹${savings} vs ${cap(second||"others")}`
        : `${cap(best)} has best item coverage (${totals[best]?.itemsFound}/${items.length} found)`,
      totalSavings: savings,
      confidence: totals[best]?.itemsFound >= Math.ceil(items.length * 0.7) ? "high" : "medium",
    },
    itemComparison: itemRows,
    platformTotals: totals,
    alternatives: [],
    splitStrategy: {
      possible: false,
      desc: `Buy from ${cap(best)}`,
      savings: 0,
    },
  };
}

function buildPrompt() {
  const rows = S.zeptoCart.slice(0,10).map(item => {
    const z = S.prices.zepto[item.name];
    const b = S.prices.blinkit[item.name];
    const sw = S.prices.swiggy[item.name];
    return `${item.name}: Zepto=₹${z?.price||"N/A"} | Blinkit=₹${b?.price||"N/A"}(${b?.name||"?"}) | Swiggy=₹${sw?.price||"N/A"}(${sw?.name||"?"})`;
  }).join("\n");

  return `Grocery price comparison for Indian user. Items:\n${rows}\n\nReturn JSON only (no markdown):\n{"recommendation":{"bestPlatform":"blinkit","reason":"one sentence","totalSavings":45,"confidence":"high"},"summary":"2 sentence summary"}`;
}

// ── GUARDRAILS ─────────────────────────────────────────────────────────────────
function guardrails() {
  const issues = [];
  const valid = ["zepto","blinkit","swiggy"];
  const best = S.comparison?.recommendation?.bestPlatform?.toLowerCase();
  if (best && !valid.includes(best)) issues.push(`Invalid platform: ${best}`);
  const totals = S.comparison?.platformTotals || {};
  const prices = Object.values(totals).map(t=>t?.subtotal).filter(v=>v>0);
  if (prices.length>=2) {
    const [mn,mx] = [Math.min(...prices),Math.max(...prices)];
    if (mx>0&&(mx-mn)/mx>0.75) issues.push(`Large gap ₹${Math.round(mn)} vs ₹${Math.round(mx)}`);
  }
  return issues;
}

// ── UTILS ──────────────────────────────────────────────────────────────────────
function fuzzy(a,b) {
  if(!a||!b) return false;
  const c = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,"").trim();
  const ca=c(String(a)), cb=c(String(b));
  if(ca===cb||ca.includes(cb)||cb.includes(ca)) return true;
  const wa=ca.split(" ").filter(w=>w.length>2);
  const wb=cb.split(" ").filter(w=>w.length>2);
  return wa.length>0 && wa.filter(w=>wb.includes(w)).length/Math.max(wa.length,wb.length)>=0.5;
}
function parseJSON(t) {
  try { const c=(t||"").replace(/```json\n?/gi,"").replace(/```/g,"").trim(); const m=c.match(/\{[\s\S]*\}/); return m?JSON.parse(m[0]):null; }
  catch { return null; }
}
function cap(s) { return s?s.charAt(0).toUpperCase()+s.slice(1):""; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }