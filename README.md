# 🛒 SmartCart AI — Grocery Price Comparison Agent
### Hackathon Prototype | Agentic AI Chrome Extension

> **Autonomously** compares your grocery cart across Zepto, Blinkit & Swiggy Instamart using an LLM-powered agent loop — all using your **existing browser sessions** (no login needed).

---

## 🧠 How It Works (Agent Loop)

```
Plan → Act → Observe → Adapt
  ↓
1. LLM plans the comparison strategy
2. Scrapes your open tabs using DOM + session cookies
3. Searches for missing items on other platforms
4. LLM compares prices, offers, and generates recommendation
5. Guardrails validate the output → LLM corrects if needed
6. Shows winner with item-by-item breakdown + alternatives
```

---

## ✅ Hackathon Criteria Met

| Criterion | Implementation |
|-----------|---------------|
| **Autonomy** | End-to-end: detects tabs → scrapes → searches → compares → recommends |
| **Independent Decision Making** | Plan→Act→Observe→Adapt loop in `background/agent.js` |
| **LLM-powered Reasoning** | Claude (free via browser) picks best matches, compares, explains |
| **Guardrails** | Price sanity checks, platform validation, LLM self-correction |
| **MCP Integration** | Local MCP server via Chrome CDP for advanced scraping |
| **Evaluations** | `utils/eval.js` — 6 automated test cases |
| **Observability** | Structured logs, traces, real-time log panel in UI |

---

## 🚀 Setup (2 mins)

### 1. Load the Extension
```
1. Open Chrome → chrome://extensions
2. Enable "Developer Mode" (top right)
3. Click "Load unpacked"
4. Select this folder: smartcart-extension/
```

### 2. Open Grocery Sites
```
- Tab 1: https://www.zeptonow.com (add items to cart)
- Tab 2: https://blinkit.com
- Tab 3: https://www.swiggy.com/instamart
```
Make sure you're **logged in** on all three — the agent uses your sessions!

### 3. Optional: MCP Server (Extra Credit)
For enhanced scraping via Chrome DevTools Protocol:
```bash
# Start Chrome with remote debugging
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug

# In another terminal
cd mcp/
node server.js
```

### 4. Run Evaluations
```bash
node utils/eval.js
# or for verbose output:
node utils/eval.js --verbose
```

---

## 🆓 Free LLM Strategy (No API Keys)

The agent tries LLMs in this order:
1. **Anthropic Claude** (via `api.anthropic.com`) — if you have access
2. **Chrome Built-in AI / Gemini Nano** — Chrome 127+, fully on-device, 100% free
3. **OpenRouter free tier** — `google/gemma-3-4b-it:free` model
4. **Rule-based fallback** — deterministic comparison if all LLMs fail

> For hackathon demo: Chrome's built-in AI (`window.ai.languageModel`) works offline, is completely free, and requires no API keys. Enable it at: `chrome://flags/#optimization-guide-on-device-model`

---

## 📁 Project Structure

```
smartcart-extension/
├── manifest.json           # Chrome Extension manifest v3
├── background/
│   ├── agent.js            # 🧠 Main agent loop (Plan→Act→Observe→Adapt)
│   ├── llm.js              # 🤖 Free LLM client (Claude/Gemini/fallback)
│   ├── guardrails.js       # 🛡️ Safety & sanity checks
│   └── logger.js           # 📊 Observability & tracing
├── content/
│   └── scraper.js          # 🔍 DOM scraper (runs in grocery tabs)
├── popup/
│   ├── popup.html          # 🎨 Beautiful UI
│   └── popup.js            # UI controller
├── mcp/
│   ├── server.js           # 📡 MCP server (Node.js, optional)
│   └── mcp-client.js       # MCP client for the extension
└── utils/
    └── eval.js             # 🧪 Evaluation & test suite
```

---

## 🛡️ Guardrail Checks

1. **Platform validation** — Recommendation must be Zepto/Blinkit/Swiggy
2. **Price sanity** — >50% gap between platforms triggers re-verification
3. **Data availability** — Recommended platform must have actual scraped data
4. **Confidence threshold** — Low-confidence recommendations are flagged
5. **Price range** — Per-item prices checked for obvious errors (₹1–₹50,000)
6. **LLM self-correction** — If guardrails fail, LLM is asked to revise

---

## 🔍 Observability

- Real-time structured logs in extension popup
- Chrome DevTools: `background service worker → console`
- All logs persisted to `chrome.storage.local` (last 200 entries)
- MCP server logs to terminal

---

## ⚡ Edge Cases Handled

- ❌ No grocery tabs open → clear error message with instructions
- ❌ Cart is empty → detected and reported
- ❌ Item unavailable on platform → searched via API, alternatives suggested
- ❌ LLM fails → waterfall fallback (3 LLMs + rule-based)
- ❌ Scraping fails → multiple selector strategies + Redux store fallback
- ❌ Bad LLM output → guardrails catch + LLM self-corrects
- ❌ Suspicious prices → flagged with warning in UI
- ✅ Split order strategy — suggests buying from 2 platforms for max savings
