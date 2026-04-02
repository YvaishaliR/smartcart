// mcp/server.js
// Run with: node mcp/server.js
// This is the MCP (Model Context Protocol) server for enhanced scraping
// It connects to Chrome via CDP (Chrome DevTools Protocol)
// Launch Chrome with: google-chrome --remote-debugging-port=9222

const http = require("http");

const TOOLS = [
  {
    name: "scrape_cart",
    description: "Scrape cart items from an already-open grocery browser tab",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["zepto", "blinkit", "swiggy"] },
      },
      required: ["platform"],
    },
  },
  {
    name: "search_product",
    description: "Search for a product on a grocery platform using existing session",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string" },
        query: { type: "string" },
      },
      required: ["platform", "query"],
    },
  },
  {
    name: "get_offers",
    description: "Get current offers and coupons from a grocery platform",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string" },
      },
      required: ["platform"],
    },
  },
];

const PLATFORM_URLS = {
  zepto: "zeptonow.com",
  blinkit: "blinkit.com",
  swiggy: "swiggy.com",
};

// ── CHROME CDP INTEGRATION ────────────────────────────────────────────────────
async function getCDPTargets() {
  try {
    const res = await fetch("http://localhost:9222/json");
    return await res.json();
  } catch {
    return [];
  }
}

async function findTab(platform) {
  const targets = await getCDPTargets();
  return targets.find(
    (t) => t.type === "page" && t.url.includes(PLATFORM_URLS[platform])
  );
}

async function evaluateInTab(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    let id = 1;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: id++,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.result?.result?.value !== undefined) {
          ws.close();
          resolve(msg.result.result.value);
        } else if (msg.result?.exceptionDetails) {
          ws.close();
          reject(new Error(msg.result.exceptionDetails.text));
        }
      } catch {}
    });
    ws.on("error", reject);
    setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout"));
    }, 10000);
  });
}

// ── SCRAPER EXPRESSIONS ───────────────────────────────────────────────────────
const SCRAPER_EXPRESSIONS = {
  zepto: `
(function() {
  const items = [];
  const selectors = ['[data-testid="cart-item"]', '[class*="CartItem"]', '[class*="cart-item"]'];
  let nodes = [];
  for (const sel of selectors) {
    nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) break;
  }
  nodes.forEach(node => {
    const name = node.querySelector('[class*="name"],[class*="Name"],h3,h4')?.textContent?.trim();
    const priceText = node.querySelector('[class*="price"],[class*="Price"]')?.textContent;
    const priceMatch = priceText?.match(/[\\d,]+\\.?\\d*/);
    const price = priceMatch ? parseFloat(priceMatch[0].replace(',', '')) : null;
    const qty = parseInt(node.querySelector('[class*="quantity"],[class*="qty"],input[type="number"]')?.value || '1');
    if (name && price) items.push({ name, price, qty, platform: 'zepto' });
  });
  return JSON.stringify(items);
})()
`,

  blinkit: `
(function() {
  const items = [];
  const selectors = ['[class*="CartItem"]', '[class*="cart-item"]', '[data-testid="cart-product"]'];
  let nodes = [];
  for (const sel of selectors) {
    nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) break;
  }
  nodes.forEach(node => {
    const name = node.querySelector('[class*="ProductName"],[class*="product-name"],h3,h4')?.textContent?.trim();
    const priceText = node.querySelector('[class*="Price"],[class*="price"]')?.textContent;
    const priceMatch = priceText?.match(/[\\d,]+\\.?\\d*/);
    const price = priceMatch ? parseFloat(priceMatch[0].replace(',', '')) : null;
    const qty = parseInt(node.querySelector('[class*="Quantity"],[class*="quantity"]')?.textContent || '1');
    if (name && price) items.push({ name, price, qty, platform: 'blinkit' });
  });
  return JSON.stringify(items);
})()
`,

  swiggy: `
(function() {
  const items = [];
  const selectors = ['[class*="cart-item"]', '[class*="CartItem"]', '[class*="itemInfo"]'];
  let nodes = [];
  for (const sel of selectors) {
    nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) break;
  }
  nodes.forEach(node => {
    const name = node.querySelector('[class*="name"],[class*="Name"],h4')?.textContent?.trim();
    const priceText = node.querySelector('[class*="price"],[class*="Price"]')?.textContent;
    const priceMatch = priceText?.match(/[\\d,]+\\.?\\d*/);
    const price = priceMatch ? parseFloat(priceMatch[0].replace(',', '')) : null;
    if (name && price) items.push({ name, price, qty: 1, platform: 'swiggy' });
  });
  return JSON.stringify(items);
})()
`,
};

// ── TOOL HANDLERS ─────────────────────────────────────────────────────────────
async function handleScrapeCart(params) {
  const { platform } = params;
  const target = await findTab(platform);
  if (!target) {
    return { items: [], error: `No ${platform} tab found. Please open ${platform} in Chrome.` };
  }

  try {
    const raw = await evaluateInTab(target, SCRAPER_EXPRESSIONS[platform]);
    const items = JSON.parse(raw);
    return { items, platform, tabUrl: target.url };
  } catch (e) {
    return { items: [], error: e.message, platform };
  }
}

async function handleSearchProduct(params) {
  const { platform, query } = params;
  const target = await findTab(platform);
  if (!target) return { results: [], error: `No ${platform} tab open` };

  const searchExpr = `
(async function() {
  const apis = {
    zepto: 'https://api.zeptonow.com/api/v3/search?query=${encodeURIComponent(query)}&page_size=5',
    blinkit: 'https://blinkit.com/v2/products/search?q=${encodeURIComponent(query)}&size=5',
    swiggy: 'https://www.swiggy.com/mapi/instamart/search?query=${encodeURIComponent(query)}'
  };
  try {
    const res = await fetch(apis['${platform}'], { credentials: 'include' });
    const data = await res.json();
    const products = data?.data?.products || data?.products || data?.results || [];
    return JSON.stringify(products.slice(0, 5).map(p => ({
      name: p.name || p.product_name || p.title,
      price: p.price || p.selling_price || p.mrp,
      mrp: p.mrp || p.max_price,
      inStock: p.in_stock !== false,
    })));
  } catch(e) {
    return JSON.stringify([]);
  }
})()
  `;

  try {
    const raw = await evaluateInTab(target, searchExpr);
    return { results: JSON.parse(raw), platform };
  } catch (e) {
    return { results: [], error: e.message };
  }
}

async function handleGetOffers(params) {
  const { platform } = params;
  const target = await findTab(platform);
  if (!target) return { offers: [] };

  const expr = `
(function() {
  const offers = [];
  document.querySelectorAll('[class*="offer"],[class*="Offer"],[class*="coupon"],[class*="promo"],[class*="discount"]')
    .forEach(el => {
      const text = el.textContent.trim();
      if (text.length > 3 && text.length < 200) offers.push(text);
    });
  return JSON.stringify([...new Set(offers)].slice(0, 5));
})()
  `;

  try {
    const raw = await evaluateInTab(target, expr);
    return { offers: JSON.parse(raw), platform };
  } catch {
    return { offers: [], platform };
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === "/tools" && req.method === "GET") {
    res.end(JSON.stringify({ tools: TOOLS, version: "1.0.0", name: "BlinkLess MCP" }));
    return;
  }

  if (req.url === "/tools/call" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { name, params } = JSON.parse(body);
        let result;

        if (name === "scrape_cart") result = await handleScrapeCart(params);
        else if (name === "search_product") result = await handleSearchProduct(params);
        else if (name === "get_offers") result = await handleGetOffers(params);
        else result = { error: `Unknown tool: ${name}` };

        res.end(JSON.stringify({ result }));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === "/health") {
    const targets = await getCDPTargets();
    res.end(JSON.stringify({
      status: "ok",
      chromeTabs: targets.length,
      groceryTabsOpen: {
        zepto: targets.some(t => t.url?.includes("zeptonow")),
        blinkit: targets.some(t => t.url?.includes("blinkit")),
        swiggy: targets.some(t => t.url?.includes("swiggy")),
      }
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(3333, () => {
  console.log("✅ BlinkLess MCP Server running on http://localhost:3333");
  console.log("📡 Connecting to Chrome CDP at http://localhost:9222");
  console.log("\nAvailable tools:", TOOLS.map(t => t.name).join(", "));
  console.log("\nTo start Chrome with CDP:");
  console.log('  Mac: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222');
  console.log('  Linux: google-chrome --remote-debugging-port=9222');
  console.log('  Windows: chrome.exe --remote-debugging-port=9222');
});
