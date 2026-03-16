// SmartCart AI v7 — Content Script
// NO obfuscated class names. Uses only:
//   - data-testid attributes (stable, set by devs intentionally)
//   - DOM structure / position
//   - Text content patterns (₹ price, image alt)
//   - Inline styles for color detection

(function () {
  if (window.__smartcartV7) return;
  window.__smartcartV7 = true;

  const PLATFORM = (() => {
    const h = location.hostname;
    if (h.includes("zeptonow") || h.includes("zepto")) return "zepto";
    if (h.includes("blinkit") || h.includes("grofers")) return "blinkit";
    if (h.includes("swiggy")) return "swiggy";
    return "unknown";
  })();

  function toNum(t) {
    if (!t) return null;
    const m = String(t).replace(/,/g, "").match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  // ── ZEPTO CART SCRAPER ─────────────────────────────────────────────────────
  function scrapeZeptoCart() {
    console.log("[SmartCart v7] Scraping Zepto cart...");

    // The qty stepper is the most reliable anchor — Zepto always uses data-testid on it
    // From actual HTML: data-testid="undefined-cart-qty"
    // The "-" button: data-testid="undefined-minus-btn"
    // The "+" button: data-testid="undefined-plus-btn"
    const qtyEls = [
      ...document.querySelectorAll('[data-testid$="-cart-qty"]'),   // ends with -cart-qty
      ...document.querySelectorAll('[data-testid*="cart-qty"]'),     // contains cart-qty
      ...document.querySelectorAll('[data-testid*="cart_qty"]'),
    ];

    // Deduplicate
    const uniqueQtyEls = [...new Map(qtyEls.map(el => [el, el])).values()];
    console.log("[SmartCart] qty elements found:", uniqueQtyEls.length);

    if (uniqueQtyEls.length === 0) {
      // Last resort: find stepper buttons by aria-label
      const minusBtns = document.querySelectorAll('button[aria-label="Remove"], button[aria-label="Decrease"], button[aria-label="minus"]');
      console.log("[SmartCart] minus buttons:", minusBtns.length);
      if (minusBtns.length > 0) {
        return extractItemsFromButtons([...minusBtns]);
      }
      console.log("[SmartCart] No qty elements, trying store...");
      return scrapeFromStore();
    }

    const items = [];
    for (const qtyEl of uniqueQtyEls) {
      const item = extractItemFromQtyAnchor(qtyEl);
      if (item && !items.find(i => i.name === item.name)) {
        items.push(item);
        console.log("[SmartCart] ✓", item.name, "₹" + item.price, "qty:" + item.qty);
      }
    }

    if (items.length === 0) {
      console.log("[SmartCart] Parse failed, trying store...");
      return scrapeFromStore();
    }
    return items;
  }

  // Walk UP from the qty element to find the item card boundary,
  // then extract name, price, unit from within it
  function extractItemFromQtyAnchor(qtyEl) {
    // Walk up to find the item card — it's the ancestor that contains exactly
    // one qty element AND has an image
    let card = qtyEl.parentElement;
    for (let i = 0; i < 10; i++) {
      if (!card) break;
      const hasImg = !!card.querySelector("img");
      const qtyCount = card.querySelectorAll('[data-testid*="cart-qty"]').length;
      const hasMinus = !!card.querySelector('[aria-label="Remove"], [aria-label="Decrease"], [aria-label="minus"], [data-testid*="minus"]');
      // Good card: has image, exactly 1 qty indicator, and +/- buttons
      if (hasImg && qtyCount === 1 && hasMinus) {
        return parseItemCard(card, qtyEl);
      }
      card = card.parentElement;
    }
    // If we couldn't find a nice boundary, use a 3-level-up ancestor
    let fallback = qtyEl;
    for (let i = 0; i < 4; i++) fallback = fallback?.parentElement;
    return fallback ? parseItemCard(fallback, qtyEl) : null;
  }

  function extractItemsFromButtons(minusBtns) {
    return minusBtns.map(btn => {
      let card = btn.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!card) break;
        if (card.querySelector("img") && /₹/.test(card.textContent)) {
          return parseItemCard(card, null);
        }
        card = card.parentElement;
      }
      return null;
    }).filter(Boolean);
  }

  function parseItemCard(card, qtyEl) {
    // ── QUANTITY ──────────────────────────────────────────────────────────────
    // From actual HTML: <p data-testid="undefined-cart-qty">1</p>
    const qty = parseInt(
      (qtyEl || card.querySelector('[data-testid*="cart-qty"]'))?.textContent?.trim()
    ) || 1;

    // ── NAME ──────────────────────────────────────────────────────────────────
    // Strategy: find the longest text node that isn't a price, unit, or button label
    let name = null;

    // Try img alt (sometimes has product name)
    const imgAlt = card.querySelector("img")?.alt?.trim();
    if (imgAlt && imgAlt.length > 5 && !imgAlt.match(/\.(jpeg|jpg|png|webp)/i)) {
      name = imgAlt;
    }

    // Collect all leaf text nodes and pick the best one
    if (!name) {
      const texts = [];
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.textContent.trim();
        if (
          t.length > 4 &&
          !t.match(/^₹/) &&                          // not a price
          !t.match(/^\d+$/) &&                        // not just a number
          !t.match(/^(Add|Remove|Cancel|Free|Delivery|Saved|Out of stock|pc|ml|g|kg|L)$/i) &&
          !t.match(/^\d+\s*(pc|ml|g|kg|L|pack)/i)    // not a unit like "200 ml"
        ) {
          texts.push({ text: t, len: t.length });
        }
      }
      // Longest text is almost always the product name
      if (texts.length > 0) {
        name = texts.sort((a, b) => b.len - a.len)[0].text;
      }
    }

    // ── PRICE ─────────────────────────────────────────────────────────────────
    // From actual HTML:
    //   Selling price: <p style="color: black;">₹181</p>   ← we want this
    //   MRP:           <p style="color: rgb(162, 170, 186);">₹210</p>  ← skip
    //
    // Strategy: find all ₹ text nodes, skip ones that are:
    //   - grey/muted color (MRP)
    //   - have text-decoration: line-through (strikethrough)
    //   - are inside a "savings" / "you save" context

    let price = null;
    let mrp = null;

    // Get all elements containing ₹
    const allEls = [...card.querySelectorAll("*")].filter(el =>
      el.children.length === 0 && /₹\s*\d+/.test(el.textContent)
    );

    for (const el of allEls) {
      const val = toNum(el.textContent);
      if (!val || val <= 0) continue;

      const style = window.getComputedStyle(el);
      const isLineThrough = style.textDecoration?.includes("line-through");
      const color = style.color || el.style.color || "";

      // Detect grey/muted colors (MRP indicator)
      // rgb(162, 170, 186) is Zepto's MRP grey — but check broadly
      const isGrey = isGreyColor(color);

      if (isLineThrough || isGrey) {
        if (!mrp || val > mrp) mrp = val; // track MRP
        continue;
      }

      // This is a non-strikethrough, non-grey price = selling price
      if (!price || val < price) price = val;
    }

    // Fallback: just grab the first ₹ number in the card
    if (!price) {
      const m = card.textContent.match(/₹\s*(\d+(?:\.\d+)?)/);
      if (m) price = parseFloat(m[1]);
    }

    // ── UNIT ──────────────────────────────────────────────────────────────────
    // Look for text like "1 pc (200 ml)" or "500g" or "1 L"
    let unit = "";
    const unitMatch = card.textContent.match(/\d+\s*(pc|pcs|ml|g|kg|L|ltr|litre)[^)]*\)?/i);
    if (unitMatch) unit = unitMatch[0].trim();

    const img = card.querySelector("img")?.src || "";

    if (!name || !price) {
      console.log("[SmartCart] ✗ Could not parse — name:", name, "price:", price,
        "card text:", card.textContent.slice(0, 100));
      return null;
    }

    return { name: name.slice(0, 120), price, mrp: mrp || price, qty, unit, img, platform: "zepto" };
  }

  // Detect if a CSS color string is grey/muted (used for MRP prices)
  function isGreyColor(colorStr) {
    if (!colorStr) return false;
    // rgb(162, 170, 186) and similar greys
    const rgb = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgb) {
      const [r, g, b] = [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
      // Grey: r≈g≈b and not very dark (not black)
      const avg = (r + g + b) / 3;
      const variance = Math.max(Math.abs(r-avg), Math.abs(g-avg), Math.abs(b-avg));
      if (variance < 25 && avg > 100 && avg < 210) return true;
    }
    // Named colors
    if (colorStr.includes("gray") || colorStr.includes("grey") || colorStr === "silver") return true;
    return false;
  }

  // ── REDUX / WINDOW STORE FALLBACK ──────────────────────────────────────────
  function scrapeFromStore() {
    for (const key of Object.keys(window)) {
      if (typeof window[key] !== "object" || !window[key]) continue;
      try {
        const str = JSON.stringify(window[key]);
        if (!str || str.length > 5000000 || !str.includes('"cart"')) continue;
        const obj = JSON.parse(str);
        const found = findCartArray(obj, 0);
        if (found.length > 0 && found.length < 200) {
          console.log("[SmartCart] Store hit:", key, found.length, "items");
          return found.map(i => ({ ...i, platform: "zepto" }));
        }
      } catch {}
    }
    return [];
  }

  function findCartArray(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== "object") return [];
    if (Array.isArray(obj)) {
      if (obj.length > 0 && obj.length < 200) {
        const s = obj[0];
        if (s && typeof s === "object") {
          const hasName = s.name || s.product_name || s.display_name;
          const hasPrice = s.price || s.mrp || s.selling_price;
          if (hasName && hasPrice) {
            return obj.map(i => ({
              name: i.name || i.product_name || i.display_name || "",
              price: parseFloat(i.price || i.selling_price || i.mrp || 0),
              mrp: parseFloat(i.mrp || i.price || 0),
              qty: parseInt(i.quantity || i.qty || 1),
              unit: i.unit || i.weight || "",
              img: i.image || i.img_url || "",
            })).filter(i => i.price > 0 && i.name.length > 1);
          }
        }
      }
      for (const v of obj.slice(0, 50)) {
        const r = findCartArray(v, depth + 1);
        if (r.length > 0 && r.length < 200) return r;
      }
    } else {
      const keys = Object.keys(obj).sort(a => {
        const l = a.toLowerCase();
        return l === "cart" || l === "cartitems" ? -1 : l.includes("cart") ? 0 : 1;
      });
      for (const k of keys.slice(0, 40)) {
        const r = findCartArray(obj[k], depth + 1);
        if (r.length > 0 && r.length < 200) return r;
      }
    }
    return [];
  }

  // ── SEARCH (Blinkit & Swiggy) ──────────────────────────────────────────────
  async function searchViaAPI(query) {
    console.log(`[SmartCart] Searching "${query}" on ${PLATFORM}`);

    const CONFIGS = {
      blinkit: [
        {
          url: `https://blinkit.com/v2/products/search?q=${enc(query)}&start=0&size=10`,
          parse: d => d?.response?.products?.objects || d?.products || [],
          norm: p => ({
            name: p.name || p.brand_name || "",
            price: parseFloat(p.price || p.mrp || 0),
            mrp: parseFloat(p.mrp || p.price || 0),
            unit: p.quantity || p.unit || "",
            inStock: p.is_available !== false,
            img: p.image || "",
          })
        },
        {
          url: `https://blinkit.com/v6/listings/page/?q=${enc(query)}`,
          parse: d => {
            for (const w of (d?.data?.widgets || d?.widgets || [])) {
              const items = w?.data?.items || w?.items || [];
              if (items.length > 0) return items;
            }
            return [];
          },
          norm: p => ({
            name: p.name || p.product?.name || "",
            price: parseFloat(p.price || p.product?.price || 0),
            mrp: parseFloat(p.mrp || p.product?.mrp || 0),
            unit: p.weight || "",
            inStock: true,
            img: p.image_url || "",
          })
        }
      ],
      swiggy: [
        {
          url: `https://www.swiggy.com/mapi/instamart/search?query=${enc(query)}&offset=0&limit=10&pageType=INSTAMART_HOME_PAGE`,
          parse: d => {
            for (const w of (d?.data?.widgets || [])) {
              const prods = w?.data?.products || w?.products || [];
              if (prods.length > 0) return prods;
            }
            return d?.data?.products || [];
          },
          norm: p => ({
            name: p.display_name || p.name || "",
            price: parseFloat(p.offer_price || p.price || p.mrp || 0),
            mrp: parseFloat(p.mrp || p.price || 0),
            unit: p.weight || p.pack_desc || "",
            inStock: p.is_available !== false,
            img: p.product_image || p.image || "",
          })
        },
        {
          url: `https://www.swiggy.com/api/instamart/v4/search?searchString=${enc(query)}&pageNumber=0`,
          parse: d => d?.data?.products || d?.data?.listings || [],
          norm: p => ({
            name: p.display_name || p.name || "",
            price: parseFloat(p.offer_price || p.price || p.mrp || 0),
            mrp: parseFloat(p.mrp || p.price || 0),
            unit: p.weight || "",
            inStock: p.is_available !== false,
            img: p.product_image || p.image || "",
          })
        }
      ]
    };

    const configs = CONFIGS[PLATFORM] || [];
    for (const cfg of configs) {
      try {
        console.log("[SmartCart] →", cfg.url.split("?")[0]);
        const res = await fetch(cfg.url, {
          credentials: "include",
          headers: {
            "Accept": "application/json, */*",
            "Accept-Language": "en-IN,en;q=0.9",
            "X-Requested-With": "XMLHttpRequest",
          }
        });
        if (!res.ok) { console.log("[SmartCart] HTTP", res.status); continue; }
        const data = await res.json();
        const raw = cfg.parse(data);
        if (!Array.isArray(raw) || raw.length === 0) continue;
        const products = raw.slice(0, 8).map(cfg.norm).filter(p => p.price > 0 && p.name.length > 1);
        if (products.length > 0) {
          console.log("[SmartCart]", PLATFORM, "→", products.length, "results");
          return products;
        }
      } catch (e) {
        console.log("[SmartCart] Error:", e.message);
      }
    }
    // All API endpoints failed (404 or empty). Try a conservative HTML-search fallback
    try {
      console.log("[SmartCart] Trying HTML fallback search on", location.origin);
      const htmlResults = await htmlSearchFallback(query);
      if (htmlResults && htmlResults.length > 0) {
        console.log("[SmartCart] HTML fallback →", htmlResults.length, "results");
        return htmlResults;
      }
    } catch (e) {
      console.log("[SmartCart] HTML fallback error:", e.message);
    }
    // If HTML fallback failed, try an in-page search (simulate user typing into site's search box)
    try {
      console.log("[SmartCart] Trying in-page search fallback");
      const pageResults = await pageSearchFallback(query);
      if (pageResults && pageResults.length > 0) {
        console.log("[SmartCart] In-page fallback →", pageResults.length, "results");
        return pageResults;
      }
    } catch (e) {
      console.log("[SmartCart] In-page fallback error:", e.message);
    }

    return [];
  }

  function enc(q) { return encodeURIComponent(q); }

  function scrapeOffers() {
    const seen = new Set(), offers = [];
    document.querySelectorAll('[class*="offer" i],[class*="coupon" i],[class*="promo" i]')
      .forEach(el => {
        const t = el.textContent.trim().replace(/\s+/g, " ");
        if (t.length > 4 && t.length < 100 && !seen.has(t)) { seen.add(t); offers.push(t); }
      });
    return offers.slice(0, 4);
  }

  // Conservative HTML-search fallback: fetch the site's public search page and
  // parse product cards. This helps when the JSON API endpoints change/return 404.
  async function htmlSearchFallback(query) {
    const tryPaths = [
      `/search?q=${enc(query)}`,
      `/search/?q=${enc(query)}`,
      `/search/${enc(query)}`,
    ];

    for (const p of tryPaths) {
      try {
        const url = location.origin + p;
        console.log(`[SmartCart] HTML fallback fetch: ${url}`);
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          console.log('[SmartCart] HTML fallback HTTP', res.status, 'for', url);
          continue;
        }
        const txt = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(txt, 'text/html');

        // Heuristic: find candidate product cards that contain an image and a ₹ price
        const candidates = [];
        const nodes = doc.querySelectorAll('article, li, div');
        for (const node of nodes) {
          try {
            if (!node.querySelector) continue;
            const img = node.querySelector('img');
            if (!img) continue;
            const text = node.textContent || '';
            if (!/₹/.test(text)) continue;
            // extract first price and a short name
            const priceMatch = text.match(/₹\s*(\d+[\d,]*(?:\.\d+)?)/);
            if (!priceMatch) continue;
            const price = toNum(priceMatch[0]);
            // name: longest reasonable text chunk
            const name = (text.replace(/\s+/g, ' ').trim().slice(0, 140));
            candidates.push({ name, price, mrp: price, unit: '', inStock: true, img: img.src || '' });
            if (candidates.length >= 8) break;
          } catch (e) { /* ignore node parse errors */ }
        }
        if (candidates.length > 0) return candidates;
      } catch (e) {
        console.log('[SmartCart] HTML fallback fetch error:', e.message);
      }
    }
    return [];
  }

  // In-page search fallback: find a visible search input on the page, input the
  // query and simulate Enter/input events. Wait for results to appear in the
  // DOM and then parse product cards. This avoids calling JSON APIs directly.
  async function pageSearchFallback(query) {
    const candidates = [];
    const inputSelectors = [
      'input[type="search"]',
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      'input[name="q"]',
      'input[role="search"]',
      '.search-input input',
      '.SearchBar input',
      'input[class*="search"]'
    ];

    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }

    if (!input) {
      console.log('[SmartCart] No visible search input found on page for in-page fallback');
      return [];
    }

    const original = input.value;
    try {
      // Focus, set value, dispatch events
      input.focus();
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));

      // If inside a form, try submit
      const form = input.form;
      if (form) {
        try { form.requestSubmit?.(); } catch {};
      }

      // Wait for DOM changes: look for new product nodes (image + ₹ price)
      const found = await waitForResultsInDOM(6000);
      if (found && found.length > 0) {
        return found.slice(0, 8);
      }
    } finally {
      // restore input if possible
      try { input.value = original; input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
    return [];
  }

  function waitForResultsInDOM(timeout = 5000) {
    return new Promise(resolve => {
      const start = Date.now();
      const parseNow = () => {
        const nodes = Array.from(document.querySelectorAll('article, li, div'));
        const out = [];
        for (const node of nodes) {
          try {
            if (!node.querySelector) continue;
            const img = node.querySelector('img');
            if (!img) continue;
            const text = node.textContent || '';
            if (!/₹/.test(text)) continue;
            const priceMatch = text.match(/₹\s*(\d+[\d,]*(?:\.\d+)?)/);
            if (!priceMatch) continue;
            const price = toNum(priceMatch[0]);
            const name = (text.replace(/\s+/g, ' ').trim().slice(0, 140));
            out.push({ name, price, mrp: price, unit: '', inStock: true, img: img.src || '' });
            if (out.length >= 8) break;
          } catch (e) {}
        }
        return out;
      };

      const initial = parseNow();
      if (initial.length > 0) return resolve(initial);

      const obs = new MutationObserver(() => {
        const curr = parseNow();
        if (curr.length > 0) {
          obs.disconnect();
          resolve(curr);
        } else if (Date.now() - start > timeout) {
          obs.disconnect();
          resolve([]);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      // fallback timeout
      setTimeout(() => { try { obs.disconnect(); } catch {} ; resolve([]); }, timeout + 50);
    });
  }

  // ── MESSAGE HANDLER ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "PING") {
      sendResponse({ pong: true, platform: PLATFORM, url: location.href });
      return false;
    }

    if (msg.type === "SCRAPE_ZEPTO_CART") {
      try {
        const items = scrapeZeptoCart();
        const offers = scrapeOffers();
        console.log("[SmartCart] Returning", items.length, "items");
        sendResponse({ success: true, items, offers, platform: "zepto", url: location.href });
      } catch (e) {
        console.error("[SmartCart] Error:", e);
        sendResponse({ success: false, items: [], offers: [], error: e.message });
      }
      return false;
    }

    if (msg.type === "SEARCH_ITEM") {
      const timeout = new Promise(resolve =>
        setTimeout(() => resolve({ success: false, results: [], error: "timeout" }), 9000)
      );
      const search = searchViaAPI(msg.query)
        .then(results => ({ success: true, results, platform: PLATFORM }))
        .catch(e => ({ success: false, results: [], error: e.message }));
      Promise.race([search, timeout]).then(sendResponse);
      return true;
    }

    return false;
  });

  console.log(`[SmartCart v7] ✓ ${PLATFORM} @ ${location.hostname}`);
})();
