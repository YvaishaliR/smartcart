// mcp/mcp-client.js
// MCP (Model Context Protocol) integration for scraping context
// This exposes a local MCP server that the agent can query

export class MCPClient {
  constructor() {
    this.serverUrl = "http://localhost:3333"; // Local MCP server
    this.connected = false;
    this.tools = [];
  }

  async connect() {
    try {
      const res = await fetch(`${this.serverUrl}/tools`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      this.tools = data.tools || [];
      this.connected = true;
      console.log("[MCP] Connected, tools:", this.tools.map((t) => t.name));
      return true;
    } catch {
      console.warn("[MCP] Server not running, using fallback scrapers");
      this.connected = false;
      return false;
    }
  }

  async callTool(name, params) {
    if (!this.connected) return null;
    try {
      const res = await fetch(`${this.serverUrl}/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, params }),
      });
      return await res.json();
    } catch (e) {
      console.error("[MCP] Tool call failed:", e.message);
      return null;
    }
  }

  async scrapeCart(platform, tabContext) {
    return this.callTool("scrape_cart", { platform, tabContext });
  }

  async searchProduct(platform, query, sessionCookies) {
    return this.callTool("search_product", { platform, query, sessionCookies });
  }
}

// ── MCP SERVER (run separately with: node mcp/server.js) ─────────────────────
// Save this as mcp/server.js and run: node mcp/server.js
export const MCP_SERVER_CODE = `
const http = require("http");
const { chromium } = require("playwright"); // npm i playwright

const TOOLS = [
  {
    name: "scrape_cart",
    description: "Scrape cart items from an already-open grocery tab using Playwright",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["zepto", "blinkit", "swiggy"] },
        tabContext: { type: "object" },
      },
      required: ["platform"],
    },
  },
  {
    name: "search_product",
    description: "Search for a product on a grocery platform",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string" },
        query: { type: "string" },
      },
      required: ["platform", "query"],
    },
  },
];

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/tools" && req.method === "GET") {
    res.end(JSON.stringify({ tools: TOOLS }));
    return;
  }

  if (req.url === "/tools/call" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { name, params } = JSON.parse(body);
        let result = null;

        if (name === "scrape_cart") {
          result = await scrapeCartPlaywright(params.platform);
        } else if (name === "search_product") {
          result = await searchProductPlaywright(params.platform, params.query);
        }

        res.end(JSON.stringify({ result }));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.end(JSON.stringify({ error: "Not found" }));
});

async function scrapeCartPlaywright(platform) {
  const browser = await chromium.connectOverCDP("http://localhost:9222"); // Chrome debug port
  const contexts = browser.contexts();
  // Find existing tab for platform
  const platformUrls = {
    zepto: "zeptonow.com",
    blinkit: "blinkit.com",
    swiggy: "swiggy.com",
  };
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (page.url().includes(platformUrls[platform])) {
        // Evaluate scraper in existing page
        const items = await page.evaluate(() => {
          // This runs in the page context — same as content script
          const nodes = document.querySelectorAll('[class*="cart"],[class*="Cart"]');
          // ... scraping logic ...
          return [];
        });
        return { items, platform };
      }
    }
  }
  return { items: [], error: "Tab not found" };
}

async function searchProductPlaywright(platform, query) {
  // Similar implementation
  return { results: [] };
}

server.listen(3333, () => console.log("MCP Server running on :3333"));
`;
