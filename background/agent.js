// BlinkLess — Background Agent (v8 — LLM-driven Agentic Loop)
// The LLM now: (1) creates the execution plan, (2) picks the best platform/split,
// (3) adapts when items are missing (retry with a new query or skip).
// Math is used to feed structured data IN to the LLM, never to override it.
importScripts("config.js");

let S = {
  status: "idle",
  zeptoCart: [],
  prices: { zepto: {}, blinkit: {}, swiggy: {} },
  offers: { zepto: [], blinkit: [], swiggy: [] },
  comparison: null,
  plan: [],
  agentThoughts: [],   // ← LLM reasoning trace shown in popup
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
function setPlan(id, status, desc) {
  const s = S.plan.find(p => p.id === id);
  if (s) { s.status = status; if (desc) s.desc = desc; bcastState(); }
}
function addThought(thought) {
  S.agentThoughts.push({ ts: Date.now(), thought });
  bcastState();
  log("info", `🤔 ${thought}`);
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
        offers:{zepto:[],blinkit:[],swiggy:[]}, comparison:null, plan:[], agentThoughts:[],
        logs:[], startTime:null, error:null, llmProvider:"none", tabsFound:{}, debug:{} };
}

// ── MAIN AGENTIC LOOP ─────────────────────────────────────────────────────────
async function runAgent() {
  resetState();
  S.startTime = Date.now();
  S.status = "planning";
  S.plan = [
    { id:1, status:"active",  desc:"🧠 LLM creating execution plan" },
    { id:2, status:"pending", desc:"🔍 Detecting open grocery tabs" },
    { id:3, status:"pending", desc:"🛒 Scraping Zepto cart" },
    { id:4, status:"pending", desc:"🔄 Searching competitor platforms" },
    { id:5, status:"pending", desc:"🧮 LLM optimizing cart allocation" },
    { id:6, status:"pending", desc:"🛡️ Guardrail checks" },
  ];
  bcastState();
  log("info", "🚀 Agent v8 started");

  try {
    // ── STEP 1: LLM creates the plan ─────────────────────────────────────────
    // LLM decides which platforms to query and in what order given available tabs.
    // This is REAL planning — the LLM can decide to skip a platform or add steps.
    setPlan(1, "active");
    await detectTabs();
    log("info", `Tabs found: ${JSON.stringify(S.tabsFound)}`);

    if (!S.tabsFound.zepto) throw new Error("No Zepto tab found. Open zepto.com in a tab first.");

    const availablePlatforms = Object.keys(S.tabsFound).filter(p => p !== "zepto");
    const planPrompt = `You are an autonomous grocery price comparison agent.
Available browser tabs: ${JSON.stringify(S.tabsFound)}
Zepto tab is open (source cart). Competitor tabs open: ${availablePlatforms.join(", ") || "none"}.

Create an execution plan. Decide:
1. Which platforms to search (only ones with open tabs)
2. Order of operations
3. Whether a split-cart strategy is worth evaluating (yes if 2+ competitors open)

Return JSON only:
{
  "platforms_to_search": ["blinkit", "swiggy"],
  "search_order": ["blinkit", "swiggy"],
  "evaluate_split_cart": true,
  "reasoning": "one sentence explaining the plan"
}`;

    const planRes = await llm(planPrompt, { max: 200, fallback: JSON.stringify({ platforms_to_search: availablePlatforms, search_order: availablePlatforms, evaluate_split_cart: availablePlatforms.length >= 2, reasoning: "Search all available platforms." }) });
    const agentPlan = parseJSON(planRes) || { platforms_to_search: availablePlatforms, search_order: availablePlatforms, evaluate_split_cart: false, reasoning: "Default plan." };

    addThought(`Plan: ${agentPlan.reasoning}`);
    addThought(`Will search: ${agentPlan.search_order.join(", ")} | Split-cart eval: ${agentPlan.evaluate_split_cart}`);

    // Update step 4 desc with the actual plan
    setPlan(4, "pending", `🔄 Searching: ${agentPlan.search_order.join(", ")}`);
    setPlan(1, "done");

    // ── STEP 2: Tabs already detected above ──────────────────────────────────
    setPlan(2, "done");

    // ── STEP 3: Scrape Zepto cart ─────────────────────────────────────────────
    setPlan(3, "active");
    S.status = "scraping";
    bcastState();

    const zRes = await msgTab(S.tabsFound.zepto, { type: "SCRAPE_ZEPTO_CART" }, 11000);
    S.zeptoCart = zRes?.items || [];
    S.offers.zepto = zRes?.offers || [];
    S.debug.zeptoUrl = zRes?.url || "";

    for (const item of S.zeptoCart) {
      const unitPrice = (item.qty && item.qty > 1 && item.price > 0)
        ? Math.round((item.price / item.qty) * 100) / 100
        : item.price;
      S.prices.zepto[item.name] = { price: unitPrice, name: item.name, inStock: true, img: item.img, qty: item.qty };
    }

    if (S.zeptoCart.length === 0) {
      throw new Error(
        "Zepto cart appears empty.\n\nMake sure:\n" +
        "• You're on zepto.com (not app)\n" +
        "• Cart panel is OPEN (click the cart icon 🛒 in top-right)\n" +
        "• You have items in cart"
      );
    }

    log("info", `Zepto: ${S.zeptoCart.length} items — [${S.zeptoCart.map(i=>i.name).slice(0,5).join(" | ")}]`);
    addThought(`Cart has ${S.zeptoCart.length} items. Starting search on ${agentPlan.search_order.length} platform(s).`);
    setPlan(3, "done");

    // ── STEP 4: Search platforms (in LLM-decided order) ──────────────────────
    setPlan(4, "active");
    S.status = "searching";
    bcastState();

    for (const platform of agentPlan.search_order) {
      if (!S.tabsFound[platform]) {
        log("warn", `${platform} in plan but no tab — skipping`);
        addThought(`Skipping ${platform} — no open tab found.`);
        continue;
      }
      await searchOnPlatform(platform);
    }
    setPlan(4, "done");

    // ── STEP 5: LLM decides the optimal strategy ─────────────────────────────
    // This is the core agent decision. LLM receives structured price data and
    // decides: best single platform OR split cart, with reasoning.
    setPlan(5, "active");
    S.status = "comparing";
    bcastState();

    const priceMatrix = buildPriceMatrix();
    const decisionPrompt = buildDecisionPrompt(priceMatrix, agentPlan.evaluate_split_cart);

    addThought("Evaluating platform totals and split-cart combinations...");

    const decisionRes = await llm(decisionPrompt, { max: 600, fallback: null });
    const decision = parseJSON(decisionRes);

    if (decision && decision.best_platform) {
      S.comparison = buildComparisonFromDecision(decision, priceMatrix);
      addThought(`Decision: ${decision.reasoning}`);
      if (decision.split_strategy?.use_split) {
        addThought(`Split cart: Buy ${decision.split_strategy.items_on_primary?.length || 0} items on ${decision.split_strategy.primary}, ${decision.split_strategy.items_on_secondary?.length || 0} items on ${decision.split_strategy.secondary}.`);
      }
      log("info", `LLM decision: ${decision.best_platform} | savings ₹${decision.savings_vs_zepto || 0}`);
    } else {
      // Fallback to rule-based if LLM fails
      log("warn", "LLM decision failed — falling back to rule-based comparison");
      addThought("LLM unavailable — using rule-based math fallback.");
      S.comparison = buildRuleBasedComparison();
    }

    setPlan(5, "done");

    // ── STEP 6: Guardrails ────────────────────────────────────────────────────
    setPlan(6, "active");
    const issues = guardrails();
    S.comparison.guardrailPassed = issues.length === 0;
    S.comparison.guardrailIssues = issues;
    if (issues.length) {
      log("warn", `Guardrail: ${issues.join("|")}`);
      addThought(`⚠️ Guardrail flag: ${issues.join("; ")}`);
    }
    setPlan(6, "done");

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

// ── BUILD PRICE MATRIX ────────────────────────────────────────────────────────
// Structured data fed to the LLM for decision-making
function buildPriceMatrix() {
  const platforms = ["zepto", "blinkit", "swiggy"];
  const items = S.zeptoCart;
  const matrix = {};

  for (const item of items) {
    matrix[item.name] = { qty: item.qty || 1 };
    for (const p of platforms) {
      const d = S.prices[p][item.name];
      if (d?.price && d.price > 0) {
        matrix[item.name][p] = {
          price: d.price,
          inStock: d.inStock !== false,
          matchedName: d.name || item.name,
        };
      } else {
        matrix[item.name][p] = { available: false, reason: d?.noTab ? "tab_not_open" : d?.notFound ? "not_found" : "unknown" };
      }
    }
  }

  const totals = {};
  for (const p of platforms) {
    let sum = 0, found = 0, missing = 0;
    for (const item of items) {
      const d = S.prices[p][item.name];
      if (d?.price > 0 && d?.inStock !== false) {
        sum += d.price * (item.qty || 1);
        found++;
      } else {
        missing++;
      }
    }
    totals[p] = { subtotal: Math.round(sum * 100) / 100, itemsFound: found, itemsMissing: missing };
  }

  return { items: matrix, totals, itemCount: items.length };
}

// ── LLM DECISION PROMPT ───────────────────────────────────────────────────────
function buildDecisionPrompt(priceMatrix, evaluateSplit) {
  return `You are an autonomous grocery optimization agent. Given price data across platforms, decide the cheapest purchase strategy.

PRICE DATA:
${JSON.stringify(priceMatrix, null, 2)}

PLATFORM TOTALS (items found × price × qty):
${JSON.stringify(priceMatrix.totals, null, 2)}

INSTRUCTIONS:
- Choose the best single platform (most items found at lowest cost).
- If evaluate_split is true, also check if buying different items from different platforms saves money. Only recommend split if the savings are meaningful (>₹20 after accounting for 2 delivery fees of ~₹30 each).
- If an item is missing on the best platform, note it.
- Do NOT invent prices. Only use the numbers above.

evaluate_split: ${evaluateSplit}

Return JSON only (no markdown, no explanation outside JSON):
{
  "best_platform": "blinkit",
  "total_on_best": 318,
  "savings_vs_zepto": 24,
  "items_missing_on_best": ["Amul Butter 100g"],
  "reasoning": "Blinkit is ₹24 cheaper than Zepto for this cart and has all items in stock.",
  "summary": "Buy from Blinkit and save ₹24. All 8 items available.",
  "split_strategy": {
    "use_split": false,
    "primary": null,
    "secondary": null,
    "items_on_primary": [],
    "items_on_secondary": [],
    "split_total": null,
    "split_savings_vs_best_single": 0,
    "split_reasoning": "Split saves less than ₹20 after delivery fees."
  }
}`;
}

// ── BUILD COMPARISON FROM LLM DECISION ───────────────────────────────────────
function buildComparisonFromDecision(decision, priceMatrix) {
  const platforms = ["zepto", "blinkit", "swiggy"];
  const items = S.zeptoCart;

  const itemRows = items.map(item => {
    const row = { item: item.name, qty: item.qty || 1 };
    for (const p of platforms) {
      const d = S.prices[p][item.name];
      if (d?.price && d.price > 0) {
        row[p] = { price: d.price, available: true, inStock: d.inStock !== false, unit: d.unit || "" };
      } else {
        row[p] = { available: false, inStock: false };
      }
    }
    // Mark which platform is cheapest per item
    const avail = platforms.filter(p => row[p]?.price > 0 && row[p]?.inStock);
    if (avail.length > 0) {
      row.cheapest = avail.reduce((a, b) => (row[a].price <= row[b].price ? a : b));
    }
    const allPrices = avail.map(p => row[p].price).filter(Boolean);
    row.savings = allPrices.length > 1 ? Math.round(Math.max(...allPrices) - Math.min(...allPrices)) : 0;
    return row;
  });

  const split = decision.split_strategy;

  return {
    recommendation: {
      bestPlatform: decision.best_platform,
      reason: decision.reasoning,
      totalSavings: decision.savings_vs_zepto || 0,
      totalOnBest: decision.total_on_best,
      itemsMissingOnBest: decision.items_missing_on_best || [],
      confidence: priceMatrix.totals[decision.best_platform]?.itemsFound >= Math.ceil(items.length * 0.7) ? "high" : "medium",
    },
    summary: decision.summary || decision.reasoning,
    itemComparison: itemRows,
    platformTotals: priceMatrix.totals,
    splitStrategy: {
      possible: split?.use_split || false,
      primary: split?.primary,
      secondary: split?.secondary,
      itemsOnPrimary: split?.items_on_primary || [],
      itemsOnSecondary: split?.items_on_secondary || [],
      splitTotal: split?.split_total,
      splitSavings: split?.split_savings_vs_best_single || 0,
      desc: split?.use_split
        ? `Split: ${split.items_on_primary?.length} items on ${cap(split.primary)}, ${split.items_on_secondary?.length} on ${cap(split.secondary)}. Extra savings: ₹${split.split_savings_vs_best_single}`
        : `Buy all from ${cap(decision.best_platform)}`,
      splitReasoning: split?.split_reasoning,
      savings: split?.split_savings_vs_best_single || 0,
    },
    llmEnhanced: true,
    llmProvider: S.llmProvider,
    agentThoughts: S.agentThoughts,
  };
}

// ── RULE-BASED FALLBACK (used only if LLM is completely unavailable) ──────────
function buildRuleBasedComparison() {
  const platforms = ["zepto", "blinkit", "swiggy"];
  const items = S.zeptoCart;

  const itemRows = items.map(item => {
    const row = { item: item.name, qty: item.qty || 1 };
    let minPrice = Infinity, cheapest = null;
    for (const p of platforms) {
      const d = S.prices[p][item.name];
      if (d?.price && d.price > 0) {
        const inStock = d.inStock !== false;
        row[p] = { price: d.price, name: d.name, available: true, inStock, unit: d.unit || "" };
        if (inStock && d.price < minPrice) { minPrice = d.price; cheapest = p; }
      } else {
        row[p] = { available: false, inStock: false };
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
      if (d?.price > 0 && d?.inStock !== false) { sum += d.price * (item.qty || 1); found++; }
      else { missing++; }
    }
    totals[p] = { subtotal: Math.round(sum*100)/100, itemsFound: found, itemsMissing: missing };
  }

  const ranked = platforms.filter(p => totals[p].itemsFound > 0)
    .sort((a,b) => totals[b].itemsFound !== totals[a].itemsFound
      ? totals[b].itemsFound - totals[a].itemsFound
      : totals[a].subtotal - totals[b].subtotal);

  const best = ranked[0] || "zepto";
  const second = ranked.find(p => p !== best);
  const savings = second ? Math.max(0, Math.round((totals[second]?.subtotal || 0) - (totals[best]?.subtotal || 0))) : 0;

  return {
    recommendation: {
      bestPlatform: best,
      reason: savings > 0 ? `${cap(best)} saves ₹${savings} vs ${cap(second||"others")}` : `${cap(best)} has best coverage`,
      totalSavings: savings,
      confidence: totals[best]?.itemsFound >= Math.ceil(items.length * 0.7) ? "high" : "medium",
    },
    summary: savings > 0 ? `Buy from ${cap(best)} and save ₹${savings}.` : `${cap(best)} has the best availability for your cart.`,
    itemComparison: itemRows,
    platformTotals: totals,
    splitStrategy: { possible: false, desc: `Buy all from ${cap(best)}`, savings: 0 },
    llmEnhanced: false,
  };
}

// ── SEARCH ON PLATFORM (with LLM-driven retry for missing items) ──────────────
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
    if (res === null) log("warn", `${platform}: SEARCH_ITEM timed out`);
    else if (res?.success === false) log("warn", `${platform}: error: ${res.error || 'unknown'}`);

    const results = res?.results || [];

    if (results.length > 0) {
      const best = await pickBest(searchQuery, results);
      if (best && best.price > 0) {
        S.prices[platform][item.name] = { ...best, searchedFor: item.name, inStock: best.inStock !== false };
        log("info", `  → "${best.name}" ₹${best.price}${best.inStock === false ? " ⚠️ OOS" : ""}`);
      } else {
        // LLM decides: should we retry with a simplified query?
        const retryQuery = await llmDecideRetry(item.name, platform, results);
        if (retryQuery) {
          log("info", `  LLM retry query: "${retryQuery}"`);
          const res2 = await msgTab(S.tabsFound[platform], { type: "SEARCH_ITEM", query: retryQuery }, 11000);
          const results2 = res2?.results || [];
          const best2 = results2.length > 0 ? await pickBest(retryQuery, results2) : null;
          S.prices[platform][item.name] = best2?.price > 0
            ? { ...best2, searchedFor: item.name, usedRetryQuery: retryQuery, inStock: best2.inStock !== false }
            : { price: null, notFound: true };
          log("info", best2?.price > 0 ? `  → Retry hit: "${best2.name}" ₹${best2.price}` : `  → Not found after retry`);
        } else {
          S.prices[platform][item.name] = { price: null, notFound: true };
          log("warn", `  → pickBest returned nothing on ${platform}`);
        }
      }
    } else {
      // No results at all — try short query
      const shortQuery = searchQuery.split(" ").filter(w => w.length > 1).slice(0, 3).join(" ");
      if (shortQuery !== searchQuery) {
        log("info", `  Retry with short query: "${shortQuery}"`);
        const res2 = await msgTab(S.tabsFound[platform], { type: "SEARCH_ITEM", query: shortQuery }, 11000);
        const results2 = res2?.results || [];
        if (results2.length > 0) {
          const best2 = await pickBest(searchQuery, results2);
          S.prices[platform][item.name] = best2?.price > 0
            ? { ...best2, searchedFor: item.name, usedShortQuery: shortQuery, inStock: best2.inStock !== false }
            : { price: null, notFound: true };
          log("info", best2?.price > 0 ? `  → "${best2.name}" ₹${best2.price} (short query)` : `  → Not found`);
        } else {
          S.prices[platform][item.name] = { price: null, notFound: true };
          log("warn", `  → not found on ${platform}`);
        }
      } else {
        S.prices[platform][item.name] = { price: null, notFound: true };
        log("warn", `  → not found on ${platform}`);
      }
    }
    await sleep(300);
  }
}

// LLM decides if a failed search should be retried with a different query.
// Returns a new query string, or null to skip.
async function llmDecideRetry(itemName, platform, badResults) {
  try {
    const prompt = `You are a grocery search agent. Item "${itemName}" returned bad results on ${platform}.
Bad results (first 3): ${JSON.stringify(badResults.slice(0,3).map(r=>({n:r.name?.slice(0,30),p:r.price})))}

Should we retry with a simpler query? If yes, return a shorter, more generic search query.
Return JSON only: {"retry": true, "query": "amul milk 500ml"} or {"retry": false, "query": null}`;

    const res = await llm(prompt, { max: 60, fallback: '{"retry":false,"query":null}' });
    const parsed = parseJSON(res);
    return (parsed?.retry && parsed?.query) ? parsed.query : null;
  } catch {
    return null;
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
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { delete window.__smartcartV7; } });
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
            log("warn", `PING failed for ${platform} — got: ${JSON.stringify(ping)}`);
            delete S.tabsFound[platform];
          } else {
            log("info", `✓ ${platform} tab ${tab.id} confirmed`);
            S.debug[platform] = { url: tab.url };
          }
        } catch (e) { log("warn", `Ping error for ${platform}: ${e?.message}`); delete S.tabsFound[platform]; }
        await sleep(200);
        break;
      }
    }
  }
}

// ── TAB MSG ───────────────────────────────────────────────────────────────────
function msgTab(tabId, message, timeout = 10000) {
  return new Promise(resolve => {
    const t = setTimeout(() => { log("warn", `Tab ${tabId} msg timeout`); resolve(null); }, timeout);
    try {
      chrome.tabs.sendMessage(tabId, message, res => {
        clearTimeout(t);
        if (chrome.runtime.lastError) { log("warn", `Tab msg err: ${chrome.runtime.lastError.message}`); resolve(null); }
        else resolve(res);
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

  const targetIsMultipack = /\d+\s*x\s*\d+|pack\s*of\s*\d+|\d+\s*pack/i.test(target);
  if (!targetIsMultipack) {
    const noMultipacks = candidates.filter(c => !/\d+\s*x\s*\d+|pack\s*of\s*\d+|\d+\s*pack/i.test(c.unit || ""));
    if (noMultipacks.length > 0) {
      candidates = noMultipacks;
      log("info", `  Multipack filter: removed ${pool.length - noMultipacks.length} multipacks`);
    }
  }

  if (targetQty && targetUnit) {
    const sizeFiltered = candidates.filter(c => {
      const m = (c.unit || "").toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm|liter|gram)/i);
      if (!m) return false;
      const cQty = parseFloat(m[1]);
      const cUnit = normalizeUnit(m[2]);
      let tQty = targetQty, tUnit = targetUnit, cQtyNorm = cQty, cUnitNorm = cUnit;
      if (tUnit === 'kg' && cUnitNorm === 'g') { tQty *= 1000; tUnit = 'g'; }
      if (tUnit === 'g' && cUnitNorm === 'kg') { cQtyNorm *= 1000; cUnitNorm = 'g'; }
      if (tUnit === 'l' && cUnitNorm === 'ml') { tQty *= 1000; tUnit = 'ml'; }
      if (tUnit === 'ml' && cUnitNorm === 'l') { cQtyNorm *= 1000; cUnitNorm = 'ml'; }
      if (tUnit !== cUnitNorm) return false;
      return Math.abs(cQtyNorm - tQty) / tQty <= 0.50;
    });
    if (sizeFiltered.length > 0) {
      log("info", `  Size filter: ${candidates.length}→${sizeFiltered.length}`);
      pool = sizeFiltered;
    } else {
      const sameUnit = candidates.filter(c => {
        const m = (c.unit || "").match(/(\d+(?:\.\d+)?)\s*(ml|g|kg|l|ltr|litre|gm|liter|gram)/i);
        if (!m) return false;
        const cUnit = normalizeUnit(m[2]);
        const tUnit = targetUnit;
        return cUnit === tUnit || (tUnit === 'l' && cUnit === 'ml') || (tUnit === 'ml' && cUnit === 'l') || (tUnit === 'kg' && cUnit === 'g') || (tUnit === 'g' && cUnit === 'kg');
      });
      if (sameUnit.length > 0) {
        const closest = sameUnit.sort((a, b) => {
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
      } else {
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
      return nameMatch || exactSize[0];
    }
  }

  const idx = pool.findIndex(c => fuzzy(c.name, cleanTarget));
  if (idx >= 0) return pool[idx];

  // LLM picks best index match
  try {
    const llmOpts = pool.slice(0,5).map((c,i)=> `${i}. ${c.name} ${c.unit} Rs${c.price}`).join('\n');
    const r = await llm(
      `Target: "${cleanTarget}"\nOptions:\n${llmOpts}\nReturn JSON only: {"i":<number>} or {"i":-1} if no match`,
      { max: 20, fallback: '{"i":0}' }
    );
    const p = parseJSON(r);
    if (p?.i >= 0 && p.i < pool.length) return pool[p.i];
  } catch {}

  return pool.filter(c => c.inStock !== false)[0] || pool[0];
}

// ── LLM ───────────────────────────────────────────────────────────────────────
async function llm(prompt, opts = {}) {
  const max = opts.max || 600;

  // 1. Groq (free, fast)
  try {
    const key = typeof CONFIG !== "undefined" && CONFIG.GROQ_API_KEY;
    if (!key) throw new Error("No Groq key");
    log("info", "Trying Groq...");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: max,
        messages: [
          { role: "system", content: "Grocery price comparison AI for India. Return only JSON when asked, no markdown, no explanation." },
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
  } catch (e) { log("warn", `Groq fetch failed: ${e.message}`); }

  // 2. Claude Haiku
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
  } catch (e) { log("warn", `Claude fetch failed: ${e.message}`); }

  // 3. Chrome Gemini Nano (on-device)
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

  // 4. Rule-based fallback
  log("warn", "All LLMs failed — using rule-based fallback");
  S.llmProvider = "Rule-based";
  return opts.fallback || "OK";
}

// ── GUARDRAILS ─────────────────────────────────────────────────────────────────
function guardrails() {
  const issues = [];
  const valid = ["zepto","blinkit","swiggy"];
  const best = S.comparison?.recommendation?.bestPlatform?.toLowerCase();
  if (best && !valid.includes(best)) issues.push(`Invalid platform: ${best}`);
  const totals = S.comparison?.platformTotals || {};
  const prices = Object.values(totals).map(t=>t?.subtotal).filter(v=>v>0);
  if (prices.length >= 2) {
    const [mn, mx] = [Math.min(...prices), Math.max(...prices)];
    if (mx > 0 && (mx - mn) / mx > 0.75) issues.push(`Large price gap ₹${Math.round(mn)} vs ₹${Math.round(mx)} — verify manually`);
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
  const VARIANT_WORDS = new Set(["american","masala","classic","original","sour","spicy","salted","sweet","tangy","plain","regular","lite","extra","double","triple","mint","lemon","lime","chilli","chili","pepper","garlic","onion","cream","cheese","butter","chocolate","vanilla","strawberry","mango","intense","repair","damage","dry","oily","sensitive","skincare","front","top","matic","toned","full","skimmed","standardised","standardized","pasteurised","pasteurized","floral","pine","power","plus","ultra","premium","natural"]);
  const targetVariants = wb.filter(w => VARIANT_WORDS.has(w));
  for (const tv of targetVariants) { if (!wa.includes(tv)) return false; }
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