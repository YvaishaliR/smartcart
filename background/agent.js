// BlinkLess — Background Agent
// Flow: Scrape Zepto cart panel → Search each item on Blinkit & Swiggy → Compare
importScripts("config.js");

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
  debug: {},
};

// ── LOGGING ───────────────────────────────────────────────────────────────────
function log(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  S.logs.push(entry);
  if (S.logs.length > 500) S.logs.shift();
  if (level === "error") console.error("[BlinkLess]", msg);
  else if (level === "warn") console.warn("[BlinkLess]", msg);
  else console.log("[BlinkLess]", msg);
  try { chrome.runtime.sendMessage({ type: "LOG_ENTRY", entry }); } catch {}
}
function bcastState() { try { chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: S }); } catch {} }
function setPlan(id, status) {
  const s = S.plan.find(p => p.id === id);
  if (s) { s.status = status; bcastState(); }
}

// ── MESSAGES ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
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
    return true;
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
  log("info", "🚀 Agent started");

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
        "Check browser console for [BlinkLess] debug logs."
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

    // 6. Compare — math first, LLM only adds summary text
    setPlan(6, "active");
    S.status = "comparing";
    bcastState();
    S.comparison = buildComparison(); // ← this does the real math, never overridden

    // LLM only writes a friendly summary — it CANNOT change bestPlatform or savings
    try {
      const llmRes = await llm(buildPrompt(), { max: 200 });
      const parsed = parseJSON(llmRes);
      if (parsed?.summary) {
        S.comparison.summary = parsed.summary;         // ✅ only take summary text
        S.comparison.llmEnhanced = true;
        log("info", `LLM summary added ✓ (${S.llmProvider})`);
      }
      // ❌ never do: S.comparison.recommendation = { ...parsed.recommendation }
    } catch (e) {
      log("warn", `LLM summary failed: ${e.message}`);
    }

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
    const searchQuery = item.unit
      ? `${item.name.split("|")[0].trim()} ${item.unit}`
      : item.name.split("|")[0].trim();
    log("info", `${platform}: searching "${searchQuery}"`);
    const res = await msgTab(S.tabsFound[platform], { type: "SEARCH_ITEM", query: searchQuery }, 11000);
    if (res?.results?.length > 0) {
      log("info", `  RAW ${platform} results (${res.results.length}): ${JSON.stringify(res.results.slice(0,4).map(r=>({n:r.name?.slice(0,20),u:r.unit,p:r.price})))}`);
    }
    if (res === null) {
      log("warn", `${platform}: SEARCH_ITEM timed out for tab ${S.tabsFound[platform]}`);
    } else if (res && res.success === false) {
      log("warn", `${platform}: SEARCH_ITEM error: ${res.error || 'unknown'}`);
    }
    const results = res?.results || [];

    if (results.length > 0) {
      const best = await pickBest(searchQuery, results);
      if (best && best.price > 0) {
        S.prices[platform][item.name] = {
          ...best,
          searchedFor: item.name,
          inStock: best.inStock !== false,
        };
        const stockWarn = best.inStock === false ? " ⚠️ OUT OF STOCK" : "";
        log("info", `  → "${best.name}" ₹${best.price} ${best.unit ? "("+best.unit+")" : ""}${stockWarn}`);
      } else {
        S.prices[platform][item.name] = { price: null, notFound: true, name: null };
        log("warn", `  → pickBest returned no valid result on ${platform}`);
      }
    } else {
      const shortQuery = searchQuery.split(" ").filter(w => w.length > 1).slice(0, 3).join(" ");
      if (shortQuery !== item.name) {
        log("info", `  Retry with short query: "${shortQuery}"`);
        const res2 = await msgTab(S.tabsFound[platform], { type: "SEARCH_ITEM", query: shortQuery }, 11000);
        const results2 = res2?.results || [];
        if (results2.length > 0) {
          const best2 = await pickBest(searchQuery, results2);
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
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => { delete window.__smartcartV7; }
          });
        } catch (e) { log("warn", `Guard clear failed for ${platform}: ${e?.message}`); }

        await sleep(150);

        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/scraper.js"] });
          log("info", `Injected scraper into ${platform} tab ${tab.id}`);
        } catch (e) {
          log("warn", `Inject failed for ${platform}: ${e?.message}`);
          delete S.tabsFound[platform];
          break;
        }

        await sleep(1000);

        try {
          const ping = await msgTab(tab.id, { type: "PING" }, 4000);
          if (!ping || ping.platform !== platform) {
            log("warn", `PING failed for ${platform} tab ${tab.id} — got: ${JSON.stringify(ping)}`);
            delete S.tabsFound[platform];
          } else {
            log("info", `✓ ${platform} tab ${tab.id} confirmed active`);
            S.debug[platform] = { url: tab.url };
          }
        } catch (e) {
          log("warn", `Ping error for ${platform}: ${e?.message}`);
          delete S.tabsFound[platform];
        }
        await sleep(200);
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
function normalizeUnit(u) {
  if (!u) return null;
  const s = u.toLowerCase().trim();
  if (s === 'ltr' || s === 'litre' || s === 'liter') return 'l';
  if (s === 'gm' || s === 'gram' || s === 'grams') return 'g';
  return s;
}

async function pickBest(target, candidates) {
  if (!candidates || candidates.length === 0) return null;

  const unitRe = /(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm|liter|gram)/i;
  const targetUnitMatch = target.match(unitRe);
  const targetQty = targetUnitMatch ? parseFloat(targetUnitMatch[1]) : null;
  const targetUnit = targetUnitMatch ? normalizeUnit(targetUnitMatch[2]) : null;

  let pool = candidates;

// FIX: exclude multipacks (2 x 100g, 5 x 125g etc.) when target is a single unit
const targetIsMultipack = /\d+\s*x\s*\d+|pack\s*of\s*\d+|\d+\s*pack/i.test(target);
if (!targetIsMultipack) {
  const noMultipacks = candidates.filter(c => 
    !/\d+\s*x\s*\d+|pack\s*of\s*\d+|\d+\s*pack/i.test(c.unit || "")
  );
  if (noMultipacks.length > 0) {
    candidates = noMultipacks;  // only filter out if alternatives exist
    log("info", `  Multipack filter: removed ${pool.length - noMultipacks.length} multipacks`);
  }
}
  log("info", `  pickBest: target="${target}" targetQty=${targetQty} targetUnit=${targetUnit} candidates=${candidates.length}`);
  if (targetQty && targetUnit) {
    const sizeFiltered = candidates.filter(c => {
      const cUnitRaw = (c.unit || "").toLowerCase();
      if (!cUnitRaw) return false;
      const m = cUnitRaw.match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm|liter|gram)/i);
      if (!m) return false;
      const cQty = parseFloat(m[1]);
      const cUnit = normalizeUnit(m[2]);
      let tQty = targetQty, tUnit = targetUnit, cQtyNorm = cQty, cUnitNorm = cUnit;
      if (tUnit === 'kg' && cUnitNorm === 'g') { tQty = tQty * 1000; tUnit = 'g'; }
      if (tUnit === 'g' && cUnitNorm === 'kg') { cQtyNorm = cQtyNorm * 1000; cUnitNorm = 'g'; }
      if (tUnit === 'l' && cUnitNorm === 'ml') { tQty = tQty * 1000; tUnit = 'ml'; }
      if (tUnit === 'ml' && cUnitNorm === 'l') { cQtyNorm = cQtyNorm * 1000; cUnitNorm = 'ml'; }
      if (tUnit !== cUnitNorm) return false;
      return Math.abs(cQtyNorm - tQty) / tQty <= 0.50;
    });
    if (sizeFiltered.length > 0) {
      log("info", `  Size filter: ${candidates.length}→${sizeFiltered.length} for "${target}" (${targetQty}${targetUnit})`);
      pool = sizeFiltered;
    } else {
      log("warn", `  No exact size match for "${target}" (${targetQty}${targetUnit}) — picking closest from: [${candidates.map(c=>c.unit||'?').join(", ")}]`);
      const sameUnitCandidates = candidates.filter(c => {
        const m = (c.unit || "").match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm|liter|gram)/i);
        if (!m) return false;
        const cUnit = normalizeUnit(m[2]);
        let tUnit = targetUnit;
        if (tUnit === 'l' && cUnit === 'ml') return true;
        if (tUnit === 'ml' && cUnit === 'l') return true;
        if (tUnit === 'kg' && cUnit === 'g') return true;
        if (tUnit === 'g' && cUnit === 'kg') return true;
        return cUnit === tUnit;
      });
      if (sameUnitCandidates.length > 0) {
        const closest = sameUnitCandidates.sort((a, b) => {
          const getQty = c => {
            const m = (c.unit||"").match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm)/i);
            if (!m) return 999999;
            let q = parseFloat(m[1]);
            const u = normalizeUnit(m[2]);
            if (targetUnit === 'ml' && u === 'l') q *= 1000;
            if (targetUnit === 'l' && u === 'ml') q /= 1000;
            if (targetUnit === 'g' && u === 'kg') q *= 1000;
            if (targetUnit === 'kg' && u === 'g') q /= 1000;
            return q;
          };
          return Math.abs(getQty(a) - targetQty) - Math.abs(getQty(b) - targetQty);
        });
        pool = [closest[0]];
        log("info", `  Closest size fallback: ${closest[0].unit} ${closest[0].name?.slice(0,20)}`);
      } else {
        log("warn", `  No same-unit candidates — marking as not found`);
        return null;
      }
    }
  }

  const cleanTarget = target.split("|")[0].replace(unitRe, "").trim();

  if (targetQty && targetUnit) {
    const exactSize = pool.filter(c => {
      const m = (c.unit || "").match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm|liter|gram)/i);
      if (!m) return false;
      let cQty = parseFloat(m[1]), cUnit = normalizeUnit(m[2]);
      let tQty = targetQty, tUnit = targetUnit;
      if (tUnit === 'kg' && cUnit === 'g') { tQty *= 1000; tUnit = 'g'; }
      if (tUnit === 'g' && cUnit === 'kg') { cQty *= 1000; cUnit = 'g'; }
      if (tUnit === 'l' && cUnit === 'ml') { tQty *= 1000; tUnit = 'ml'; }
      if (tUnit === 'ml' && cUnit === 'l') { cQty *= 1000; cUnit = 'ml'; }
      return tUnit === cUnit && Math.abs(cQty - tQty) / tQty <= 0.10;
    });
    if (exactSize.length === 1) return exactSize[0];
    if (exactSize.length > 1) {
      const nameMatch = exactSize.find(c => fuzzy(c.name, cleanTarget));
      if (nameMatch) return nameMatch;
      return exactSize[0];
    }
  }

  const idx = pool.findIndex(c => fuzzy(c.name, cleanTarget));
  if (idx >= 0) return pool[idx];

  // LLM pick for product matching (this is fine — it's just choosing an index, not changing prices)
  try {
    const llmOpts = pool.slice(0,5).map((c,i)=> i+'. '+c.name+' '+c.unit+' Rs'+c.price).join('\n');
    const r = await llm(
      'Target: "' + cleanTarget + '"\nOptions:\n' + llmOpts + '\nReturn JSON only: {"i":<number>} or {"i":-1} if no match',
      { max: 20, fallback: '{"i":0}' }
    );
    const p = parseJSON(r);
    if (p?.i >= 0 && p.i < pool.length) return pool[p.i];
  } catch {}

  if (targetQty && targetUnit) {
    const sorted = pool
      .filter(c => c.inStock !== false)
      .map(c => {
        const m = (c.unit || "").match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm)/i);
        const qty = m ? parseFloat(m[1]) : 0;
        return { c, score: Math.abs(qty - targetQty) };
      })
      .sort((a, b) => a.score - b.score);
    if (sorted.length > 0) return sorted[0].c;
  }
  return pool.filter(c => c.inStock !== false)[0] || pool[0];
}

// ── LLM ───────────────────────────────────────────────────────────────────────
async function llm(prompt, opts = {}) {
  const max = opts.max || 600;

  // 1. Groq (free, fast) ─────────────────────────────────────────────────────
  try {
    const key = typeof CONFIG !== "undefined" && CONFIG.GROQ_API_KEY;  // ← must match config.js
    if (!key) throw new Error("No Groq key");
    log("info", "Trying Groq...");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`           // ← backticks, not quotes
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: max,
        messages: [
          { role: "system", content: "Grocery price comparison AI for India. Return only JSON when asked, no markdown." },
          { role: "user", content: prompt }
        ]
      })
    });
    if (r.ok) {
      const d = await r.json();
      const t = d?.choices?.[0]?.message?.content;
      if (t) { S.llmProvider = "Groq Llama"; log("info", "Groq success ✓"); return t; }
    } else {
      const errText = await r.text();
      log("warn", `Groq error ${r.status}: ${errText.slice(0, 120)}`);
    }
  } catch (e) {
    log("warn", `Groq fetch failed: ${e.message}`);
  }

  // 2. Claude (if you top up credits) ───────────────────────────────────────
  try {
    const key = typeof CONFIG !== "undefined" && CONFIG.ANTHROPIC_API_KEY;
    if (key) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: max,
          system: "You are a grocery price comparison AI for India. Return only JSON when asked, no markdown, no explanation.",
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const t = d?.content?.[0]?.text;
        if (t) { S.llmProvider = "Claude Haiku"; return t; }
      } else {
        const errText = await r.text();
        log("warn", `Claude API error ${r.status}: ${errText.slice(0, 100)}`);
      }
    }
  } catch (e) {
    log("warn", `Claude fetch failed: ${e.message}`);
  }

  // 3. Chrome Gemini Nano (on-device, no key needed) ─────────────────────────
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

  // 4. Rule-based fallback ───────────────────────────────────────────────────
  log("warn", "All LLMs failed — using rule-based fallback");
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
          outOfStock: !inStock,
        };
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

// LLM is only asked for a friendly summary — the winner is already decided by math above
function buildPrompt() {
  const best = S.comparison.recommendation.bestPlatform;
  const savings = S.comparison.recommendation.totalSavings;
  const totals = S.comparison.platformTotals;

  const rows = S.zeptoCart.slice(0,10).map(item => {
    const z = S.prices.zepto[item.name];
    const b = S.prices.blinkit[item.name];
    const sw = S.prices.swiggy[item.name];
    return `${item.name}: Zepto=₹${z?.price||"N/A"} | Blinkit=₹${b?.price||"N/A"} | Swiggy=₹${sw?.price||"N/A"}`;
  }).join("\n");

  return `Grocery cart prices (India):\n${rows}\n\nZepto total: ₹${totals.zepto?.subtotal||"N/A"}\nBlinkit total: ₹${totals.blinkit?.subtotal||"N/A"}\nSwiggy total: ₹${totals.swiggy?.subtotal||"N/A"}\n\nThe cheapest platform is ${cap(best)}${savings > 0 ? `, saving ₹${savings}` : ""}. Write a short 1-2 sentence friendly summary for the user confirming this.\n\nReturn JSON only, no markdown: {"summary":"..."}`;
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
function fuzzy(a, b) {
  if (!a || !b) return false;
  const clean = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const ca = clean(String(a)), cb = clean(String(b));
  if (ca === cb) return true;
  if (ca.includes(cb) || cb.includes(ca)) return true;

  const wa = ca.split(" ").filter(w => w.length > 2);
  const wb = cb.split(" ").filter(w => w.length > 2);
  if (wa.length === 0) return false;

  const VARIANT_WORDS = new Set([
    "american", "masala", "classic", "original", "sour", "spicy", "salted",
    "sweet", "tangy", "plain", "regular", "lite", "extra", "double", "triple",
    "mint", "lemon", "lime", "chilli", "chili", "pepper", "garlic", "onion",
    "cream", "cheese", "butter", "chocolate", "vanilla", "strawberry", "mango",
    "intense", "repair", "damage", "dry", "oily", "sensitive", "skincare",
    "front", "top", "matic", "toned", "full", "skimmed",
    "standardised", "standardized", "pasteurised", "pasteurized",
    "floral", "pine", "power", "plus", "ultra", "premium", "natural"
  ]);

  const targetVariants = wb.filter(w => VARIANT_WORDS.has(w));
  for (const tv of targetVariants) {
    if (!wa.includes(tv)) return false;
  }

  const overlap = wa.filter(w => wb.includes(w)).length;
  return overlap / Math.max(wa.length, wb.length) >= 0.5;
}

function parseJSON(t) {
  try {
    const c = (t||"").replace(/```json\n?/gi,"").replace(/```/g,"").trim();
    const m = c.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }