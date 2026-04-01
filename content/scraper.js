// SmartCart AI v7 — Content Script
// NO obfuscated class names. Uses only:
//   - data-testid attributes (stable, set by devs intentionally)
//   - DOM structure / position
//   - Text content patterns (₹ price, image alt)
//   - Inline styles for color detection

(function () {
  if (window.__smartcartV7) return;
  window.__smartcartV7 = true;

  // NOTE: Network hook removed — injecting inline <script> tags violates Blinkit/Swiggy CSP
  // and causes "Content Security Policy" errors that break script execution on those pages.

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
    // Zepto shows unit as "1 pack (250 g)" or "500 ml" or "1 kg"
    // Priority: extract the quantity inside parentheses first e.g. (250 g) → "250 g"
    // then fall back to standalone patterns like "500ml", "1 kg"
    let unit = "";
    const cardText = card.textContent || "";
    // First: try to find quantity inside parentheses e.g. "(250 g)" or "(500 ml)"
    const parenMatch = cardText.match(/\(\s*(\d+(?:\.\d+)?\s*(?:g|kg|ml|L|ltr|litre|gm))\s*\)/i);
    if (parenMatch) {
      unit = parenMatch[1].trim();
    } else {
      // Fallback: standalone unit like "500ml", "1 kg", "250g"
      const unitMatch = cardText.match(/\b(\d+(?:\.\d+)?\s*(?:g|kg|ml|L|ltr|litre|gm))\b/i);
      if (unitMatch) unit = unitMatch[1].trim();
    }

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

  // ── BLINKIT HEADERS (reads lat/lon from cookies — required or get 400) ─────────
  function blinkitHeaders() {
    // Blinkit stores lat/lon in cookies: gr_1_lat and gr_1_lon
    // Without these, API returns {"error":"location not serviceable"}
    function getCookie(name) {
      const match = document.cookie.match(new RegExp('(?:^|;\s*)' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    }
    const lat = getCookie('gr_1_lat') || '12.9352';   // fallback: Bengaluru center
    const lon = getCookie('gr_1_lon') || '77.6245';
    const deviceId = getCookie('gr_1_deviceId') || 'web';
    const accessToken = getCookie('gr_1_accessToken') || '';

    console.log('[SmartCart] Blinkit lat:', lat, 'lon:', lon);

    return {
      'app_client': 'consumer_web',
      'app_version': '1010101010',
      'web_app_version': '1008010016',
      'Content-Type': 'application/json',
      'lat': lat,
      'lon': lon,
      'device_id': deviceId,
      ...(accessToken ? { 'access_token': accessToken } : {}),
    };
  }

  // ── SEARCH (Blinkit & Swiggy) ──────────────────────────────────────────────
  async function searchViaAPI(query) {
    console.log(`[SmartCart] Searching "${query}" on ${PLATFORM}`);

    const CONFIGS = {
      blinkit: [
        {
          // Confirmed from network: POST to v1/layout/search with these exact headers
          url: `https://blinkit.com/v1/layout/search?q=${enc(query)}&offset=0&limit=12&actual_query=${enc(query)}&search_type=auto_suggest`,
          method: "POST",
          // FIX: lat/lon are REQUIRED — without them Blinkit returns {"error":"location not serviceable"}
          // These are read dynamically from Blinkit's own cookies (gr_1_lat, gr_1_lon) so they
          // work for any user location, not just Bengaluru.
          headers: blinkitHeaders(),
          body: "",  // Blinkit POST with empty body — confirmed from network (content-length: 0)
          // Real response shape: { is_success: true, response: { snippets: [ { data: { name: {text}, mrp: {text}, variant: {text}, image: {url} } } ] } }
          parse: d => {
            if (d?.is_success && d?.response?.snippets?.length > 0) {
              // Filter out non-product snippets (banners/headers only have identity+title+bg_color+padding)
              // Real product snippets have name, variant, atc_action etc.
              return d.response.snippets.filter(s => {
                const sd = s?.data || {};
                return sd?.name?.text || sd?.atc_action || sd?.variant_list?.length > 0;
              });
            }
            return [];
          },
          norm: (snippet, query) => {
            // Real Blinkit structure confirmed from network:
            // snippet is one entry from response.snippets[]
            // It may itself be a product card OR contain variant_list[] with size variants
            //
            // Price is in: data.atc_action.add_to_cart.cart_item.price (number)
            // OR:          data.normal_price.text = "₹27" (display string)
            // Name:        data.name.text
            // Unit/size:   data.variant.text = "500 ml"
            // Stock:       data.is_sold_out === false AND data.product_state === "available"
            // Variants:    data.variant_list[] — different sizes of same product

            const d = snippet.data || snippet;
            if (!d?.name?.text) return { name: "", price: 0, mrp: 0, unit: "", inStock: false, img: "" };

            // Helper to extract one product from a Blinkit data node
            function extractProduct(node) {
              const cartItem = node?.atc_action?.add_to_cart?.cart_item;
              const price = cartItem?.price || toNum(node?.normal_price?.text) || 0;
              const mrp = cartItem?.mrp || price;
              return {
                name: node?.name?.text || node?.display_name?.text || "",
                price: parseFloat(price),
                mrp: parseFloat(mrp),
                unit: node?.variant?.text || cartItem?.unit || "",
                inStock: node?.is_sold_out === false && node?.product_state !== "sold_out",
                img: node?.image?.url || cartItem?.image_url || "",
              };
            }

            // If variant_list exists, pick best size match (same logic as Swiggy)
            const variantList = d.variant_list || [];
            if (variantList.length > 0) {
              const qtyMatch = (query || "").match(/(\d+)\s*(ml|g|kg|l|ltr|litre|gm)/i);
              const targetQty = qtyMatch ? parseInt(qtyMatch[1]) : null;
              const targetUnit = qtyMatch ? qtyMatch[2].toLowerCase().replace('ltr','l').replace('litre','l').replace('gm','g') : null;

              let best = null;
              let bestScore = Infinity;

              const targetIsMultipack = /x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(query || "");
              for (const v of variantList) {
                const vd = v.data || v;
                const vUnitText = (vd?.variant?.text || "").toLowerCase();
                // Skip multi-packs if target is single unit
                const isMultipack = /x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(vUnitText);
                if (isMultipack && !targetIsMultipack) continue;
                const vMatch = vUnitText.match(/(\d+)\s*(ml|g|kg|l|ltr|litre|gm)/i);
                if (targetQty && vMatch) {
                  const vQty = parseInt(vMatch[1]);
                  const vU = vMatch[2].toLowerCase().replace('ltr','l').replace('litre','l').replace('gm','g');
                  if (vU === targetUnit) {
                    const score = Math.abs(vQty - targetQty);
                    if (score < bestScore) { bestScore = score; best = vd; }
                  }
                }
              }
              // Fallback: use first available variant
              if (!best) {
                const avail = variantList.find(v => (v.data || v)?.is_sold_out === false) || variantList[0];
                best = avail?.data || avail;
              }
              if (best) return extractProduct(best);
            }

            // No variant_list — extract directly from the snippet data
            return extractProduct(d);
          }
        }
      ],
      swiggy: [
        {
          // Confirmed from network: POST with exact URL and body shape
          // storeId 1395425 confirmed from your cookies (Bengaluru/Marathahalli)
          url: `https://www.swiggy.com/api/instamart/search/v2?offset=0&ageConsent=false&voiceSearchTrackingId=&storeId=1395425&primaryStoreId=1395425&secondaryStoreId=1400609`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "origin": "https://www.swiggy.com",
          },
          body: JSON.stringify({
            facets: [],
            sortAttribute: "",
            query: query,
            search_results_offset: "0",
            page_type: "INSTAMART_AUTO_SUGGEST_PAGE",
            is_pre_search_tag: false,
          }),
          // Real response shape confirmed:
          // data.cards[].card.card.gridElements.infoWithStyle.items[]
          // Each item: { displayName, variations: [{ listingVariant, displayName, quantityDescription, price: { offerPrice: { units: "24" } }, inventory: { inStock } }] }
          parse: d => {
            const items = [];
            for (const card of (d?.data?.cards || [])) {
              const inner = card?.card?.card;
              if (!inner) continue;
              // Products live under gridElements.infoWithStyle.items
              const gridItems = inner?.gridElements?.infoWithStyle?.items;
              if (Array.isArray(gridItems) && gridItems.length > 0) {
                items.push(...gridItems);
              }
            }
            return items;
          },
          norm: (p, targetQuery) => {
            const variations = p?.variations || [];
            if (variations.length === 0) return { name: "", price: 0, mrp: 0, unit: "", inStock: false, img: "" };

            // FIX: Pick best variation by matching quantity in the search query.
            // e.g. if Zepto item is "500ml", prefer the 500ml variant on Swiggy over 1L or 4-pack.
            // Strategy: parse qty numbers from query, find closest matching variation.
            const qtyMatch = (targetQuery || "").match(/(\d+)\s*(ml|g|kg|l|ltr|litre|gm|pc|pcs)/i);
            const targetQty = qtyMatch ? parseInt(qtyMatch[1]) : null;
            const targetUnit = qtyMatch ? qtyMatch[2].toLowerCase() : null;

            let best = variations.find(v => v.listingVariant === true) || variations[0];

            if (targetQty && targetUnit) {
              // Score each variation by how close its qty is to target
              // IMPORTANT: reject multi-packs (x2, x3, pack of 2) unless target is also multi-pack
              const targetIsMultipack = /x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(targetQuery || "");
              let bestScore = Infinity;
              for (const v of variations) {
                const vDesc = (v.quantityDescription || "").toLowerCase();
                // Skip multi-packs if target is single unit
                const isMultipack = /x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(vDesc);
                if (isMultipack && !targetIsMultipack) continue;
                const vMatch = vDesc.match(/(\d+)\s*(ml|g|kg|l|ltr|litre|gm|pc|pcs)/i);
                if (!vMatch) continue;
                let vQty = parseInt(vMatch[1]);
                let vUnit = vMatch[2].toLowerCase();
                // Normalize units for comparison
                if (vUnit === "ltr" || vUnit === "litre") vUnit = "l";
                if (vUnit === "gm") vUnit = "g";
                const tUnit = targetUnit === "ltr" || targetUnit === "litre" ? "l" : targetUnit === "gm" ? "g" : targetUnit;
                if (vUnit !== tUnit) continue; // different unit type, skip
                const score = Math.abs(vQty - targetQty);
                if (score < bestScore) { bestScore = score; best = v; }
              }
            }

            const offerPrice = parseInt(best?.price?.offerPrice?.units || "0", 10);
            const mrpPrice = parseInt(best?.price?.mrp?.units || "0", 10);

            return {
              name: best.displayName || p.displayName || "",
              price: offerPrice || mrpPrice,
              mrp: mrpPrice || offerPrice,
              unit: best.quantityDescription || "",
              inStock: best?.inventory?.inStock !== false && best?.slotInfo?.isAvail !== false,
              img: best.imageIds?.[0]
                ? `https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_300/${best.imageIds[0]}`
                : "",
            };
          }
        }
      ]
    };

    const configs = CONFIGS[PLATFORM] || [];
    for (const cfg of configs) {
      try {
        const isPost = cfg.method === "POST";
        console.log("[SmartCart] →", cfg.method || "GET", cfg.url.split("?")[0]);
        // Use background proxy for cross-origin requests (content scripts are limited by CORS)
        const isCross = (() => {
          try { return new URL(cfg.url, location.origin).origin !== location.origin; } catch { return false; }
        })();
        let data = null;
        // Merge base headers with platform-specific headers from cfg
        const reqHeaders = {
          'Accept': 'application/json, */*',
          'Accept-Language': 'en-IN,en;q=0.9',
          ...(cfg.headers || {}),
        };
        const reqBody = isPost ? (cfg.body ?? "") : null;

        // FIX: Always use the background proxy for search API calls.
        // The isCross check was returning false (content script runs ON blinkit.com so origin matches),
        // but direct fetch still gets 400 because the background service worker handles
        // cookies and auth headers more reliably than the content script context.
        const useProxy = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
        if (useProxy) {
          const pref = await proxyFetch(cfg.url, isPost ? 'POST' : 'GET', reqHeaders, reqBody);
          if (!pref || !pref.ok) { console.log('[SmartCart] proxy HTTP', pref?.status, pref?.error || ''); continue; }
          data = pref.body;
        } else {
          const res = await fetch(cfg.url, {
            method: isPost ? "POST" : "GET",
            credentials: "include",
            headers: reqHeaders,
            ...(isPost ? { body: reqBody } : {}),
          });
          if (!res.ok) { console.log("[SmartCart] HTTP", res.status); continue; }
          data = await res.json();
        }
        const raw = cfg.parse(data);
        if (!Array.isArray(raw) || raw.length === 0) continue;

        // KEY FIX: Expand ALL variants before returning so agent.js pickBest
        // can size-filter across every available size option.
        // Previously norm() picked ONE variant internally → pickBest saw only 1 candidate → wrong size won.
        // Now we return ALL variants as separate candidates → pickBest picks the right size.
        const expanded = [];
        for (const item of raw.slice(0, 8)) {
          const d = item.data || item;

          // ── Blinkit: expand variant_list[] ──────────────────────────────
          const variantList = d?.variant_list || [];
          if (variantList.length > 0) {
            for (const v of variantList) {
              const vd = v.data || v;
              if (!vd?.name?.text) continue;
              const cartItem = vd?.atc_action?.add_to_cart?.cart_item;
              const price = cartItem?.price || toNum(vd?.normal_price?.text) || 0;
              if (price <= 0) continue;
              const unitText = vd.variant?.text || cartItem?.unit || "";
              // Skip multipacks unless query is also multipack
              if (/x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(unitText) &&
                  !/x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(query)) continue;
              expanded.push({
                name: vd.name.text || vd.display_name?.text || "",
                price: parseFloat(price),
                mrp: parseFloat(cartItem?.mrp || price),
                unit: unitText,
                inStock: vd.is_sold_out === false && vd.product_state !== "sold_out",
                img: vd.image?.url || cartItem?.image_url || "",
              });
            }
            if (expanded.length > 0) continue; // used variant_list, skip top-level norm
          }

          // ── Swiggy: expand variations[] ─────────────────────────────────
          const variations = d?.variations || item?.variations || [];
          if (variations.length > 0) {
            for (const v of variations) {
              const price = parseInt(v?.price?.offerPrice?.units || "0", 10);
              const mrp = parseInt(v?.price?.mrp?.units || "0", 10);
              if (price <= 0 && mrp <= 0) continue;
              const unitText = v.quantityDescription || "";
              // Skip multipacks unless query is also multipack
              if (/x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(unitText) &&
                  !/x\s*\d+|pack\s*of\s*\d+|\d+\s*x\s*\d+/i.test(query)) continue;
              expanded.push({
                name: v.displayName || d.displayName || "",
                price: price || mrp,
                mrp: mrp || price,
                unit: unitText,
                inStock: v?.inventory?.inStock !== false && v?.slotInfo?.isAvail !== false,
                img: v.imageIds?.[0]
                  ? `https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_300/${v.imageIds[0]}`
                  : "",
              });
            }
            if (expanded.length > 0) continue; // used variations, skip top-level norm
          }

          // ── No variants: normalize as single product ─────────────────────
          const normed = cfg.norm(item, query);
          if (normed.price > 0 && normed.name.length > 1) expanded.push(normed);
        }

        const products = expanded.filter(p => p.price > 0 && p.name.length > 1);
        if (products.length > 0) {
          console.log("[SmartCart]", PLATFORM, "→", products.length, "candidates (all variants expanded)");
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

  // Proxy fetch helper: ask background service worker to perform cross-origin fetch
  function proxyFetch(url, method = 'GET', headers = {}, body = null) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'PROXY_FETCH', url, method, headers, body }, resp => {
          resolve(resp);
        });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  }
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
    // Each platform uses a different search URL structure
    const SEARCH_PATHS = {
      blinkit: [`/s/?q=${enc(query)}`],
      swiggy:  [`/instamart/search?custom_back=true&query=${enc(query)}`],
    };
    const tryPaths = SEARCH_PATHS[PLATFORM] || [
      `/search?q=${enc(query)}`,
      `/search/?q=${enc(query)}`,
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

    // Platform-specific selectors first, then generic fallbacks
    const PLATFORM_SELECTORS = {
      blinkit: [
        'input[data-testid="search-input"]',
        'input[placeholder*="Search" i]',
        '.search-bar input',
        'input[class*="Search"]',
        'header input',
      ],
      swiggy: [
        'input[data-testid="search_input"]',
        'input[placeholder*="Search" i]',
        'input[placeholder*="search" i]',
        'div[class*="SearchBar"] input',
        'div[class*="search"] input',
        'header input',
      ],
    };

    const inputSelectors = [
      ...(PLATFORM_SELECTORS[PLATFORM] || []),
      'input[type="search"]',
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      'input[name="q"]',
      'input[role="search"]',
      '.search-input input',
      '.SearchBar input',
      'input[class*="search" i]',
    ];

    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }

    if (!input) {
      // No search input visible — try navigating to the search URL directly
      // This works for Blinkit (/s/?q=) and Swiggy (/instamart/search?query=)
      const NAV_URLS = {
        blinkit: `/s/?q=${enc(query)}`,
        swiggy:  `/instamart/search?custom_back=true&query=${enc(query)}`,
      };
      const navUrl = NAV_URLS[PLATFORM];
      if (navUrl) {
        console.log('[SmartCart] Navigating to search URL:', navUrl);
        history.pushState({}, '', navUrl);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        const found = await waitForResultsInDOM(7000);
        if (found && found.length > 0) return found.slice(0, 8);
      }
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

      // Platform-specific product card selectors — more precise than generic div/li
      const RESULT_SELECTORS = {
        blinkit: [
          '[class*="Product__UpdatedPlpProductContainer"]',
          '[class*="plp-product"]',
          '[data-testid*="plp-product"]',
          '[class*="SearchResults"] [class*="product"]',
        ],
        swiggy: [
          '[class*="SearchResultItem"]',
          '[class*="ItemRevamp"]',
          '[data-testid*="item"]',
          '[class*="search"] [class*="Item"]',
        ],
      };

      const selectors = RESULT_SELECTORS[PLATFORM] || [];

      const parseNodes = (nodes) => {
        const out = [];
        for (const node of nodes) {
          try {
            const text = node.textContent || '';
            if (!/₹/.test(text)) continue;
            const priceMatch = text.match(/₹\s*(\d+[\d,]*(?:\.\d+)?)/);
            if (!priceMatch) continue;
            const price = toNum(priceMatch[0]);
            const img = node.querySelector('img');
            out.push({ name: text.replace(/\s+/g, ' ').trim().slice(0, 100), price, mrp: price, unit: '', inStock: true, img: img?.src || '' });
            if (out.length >= 8) break;
          } catch {}
        }
        return out;
      };

      const parseNow = () => {
        // Try platform-specific selectors first (avoids navbar/banner false positives)
        for (const sel of selectors) {
          const nodes = Array.from(document.querySelectorAll(sel));
          if (nodes.length > 0) {
            const out = parseNodes(nodes);
            if (out.length > 0) return out;
          }
        }
        // Generic fallback scoped to main content area only
        const nodes = Array.from(document.querySelectorAll('main article, main li, [role="main"] > div > div'));
        return parseNodes(nodes);
      };

      // Don't check immediately — only fire on DOM mutations (prevents pre-existing content false positive)
      const obs = new MutationObserver(() => {
        const curr = parseNow();
        if (curr.length > 0) { obs.disconnect(); resolve(curr); }
        else if (Date.now() - start > timeout) { obs.disconnect(); resolve([]); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { try { obs.disconnect(); } catch {} resolve([]); }, timeout + 100);
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