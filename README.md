# 🛒 BlinkLess — Grocery Price Comparison Agent
### Hackathon Prototype | Agentic AI Chrome Extension

> **Autonomously** compares your grocery cart across Zepto, Blinkit & Swiggy Instamart using an LLM-powered agent loop — all using your **existing browser sessions** (no login needed).

---

## 🧠 How It Works (Agent Loop)

```
Plan → Act → Observe → Adapt
  ↓
1. LLM plans the comparison strategy
2. Scrapes your Zepto cart using DOM + session cookies
3. Searches for each item on Blinkit & Swiggy
4. LLM compares prices and generates a recommendation
5. Guardrails validate the output
6. Shows winner with item-by-item breakdown + savings
```

---

## ✅ Hackathon Criteria Met

| Criterion | Implementation |
|-----------|---------------|
| **Autonomy** | End-to-end: detects tabs → scrapes → searches → compares → recommends |
| **Independent Decision Making** | Plan→Act→Observe→Adapt loop in `agent.js` |
| **LLM-powered Reasoning** | Groq LLM picks best matches, compares prices, explains recommendation |
| **Guardrails** | Price sanity checks, platform validation |
| **Observability** | Structured logs, real-time agent trace panel in UI |

---

## 🚀 Setup (2 mins)

### 1. Load the Extension
```
1. Open Chrome → chrome://extensions
2. Enable "Developer Mode" (top right)
3. Click "Load unpacked"
4. Select the project folder
```

### 2. Open Grocery Sites
```
- Tab 1: https://www.zeptonow.com  → add items to cart, then open the cart panel (click 🛒)
- Tab 2: https://blinkit.com
- Tab 3: https://www.swiggy.com/instamart
```

Make sure you're **logged in** on all three — the agent uses your existing sessions.

### 3. Run the Agent
Click **⚡ Run Price Agent** in the extension popup.

---

## 🤖 LLM

The agent uses **Groq** for fast inference. It is used for:
- Picking the best product match from search results
- Comparing platform totals and generating a recommendation
- Producing a human-readable summary of the decision

If the LLM call fails, the agent falls back to a deterministic rule-based comparison.

---

## 📁 Project Structure

```
blinkless/
├── manifest.json        # Chrome Extension manifest v3
├── agent.js             # 🧠 Main agent loop (Plan→Act→Observe→Adapt)
├── scraper.js           # 🔍 DOM scraper injected into grocery tabs
├── popup.html           # 🎨 Extension popup UI
└── popup.js             # UI controller
```

---

## 🛡️ Guardrail Checks

1. **Platform validation** — Recommendation must be Zepto, Blinkit, or Swiggy
2. **Price sanity** — Large gaps between platform totals are flagged in the UI
3. **Data availability** — Recommended platform must have actual scraped data

---

## 🔍 Observability

- Real-time structured logs in the extension popup (Agent Trace panel)
- Chrome DevTools: `background service worker → console` for raw logs
- All logs stored in memory during the session

---

## ⚡ Edge Cases Handled

- ❌ No grocery tabs open → clear error with setup instructions
- ❌ Cart is empty → detected and reported
- ❌ Item not found on a platform → retried with shorter query, marked as missing
- ❌ LLM fails → falls back to rule-based comparison
- ❌ Scraping fails → multiple selector strategies + Redux store fallback
- ❌ Suspicious prices → flagged with a warning in UI
- ✅ Size-aware matching — unit (ml, g, kg) included in search query for accurate variant selection