// utils/eval.js
// Evaluation & testing framework for SmartCart AI Agent
// Run with: node utils/eval.js

const MOCK_CART = [
  { name: "Amul Butter 100g", price: 55, qty: 2, platform: "zepto" },
  { name: "Aashirvaad Atta 5kg", price: 270, qty: 1, platform: "zepto" },
  { name: "Maggi Noodles 70g Pack of 4", price: 65, qty: 1, platform: "zepto" },
  { name: "Tata Salt 1kg", price: 22, qty: 2, platform: "zepto" },
  { name: "Surf Excel 1kg", price: 190, qty: 1, platform: "zepto" },
];

const MOCK_PLATFORM_DATA = {
  zepto: [
    { name: "Amul Butter 100g", price: 55, platform: "zepto" },
    { name: "Aashirvaad Atta 5kg", price: 270, platform: "zepto" },
    { name: "Maggi Noodles 70g 4pk", price: 65, platform: "zepto" },
    { name: "Tata Salt 1kg", price: 22, platform: "zepto" },
    { name: "Surf Excel 1kg", price: 190, platform: "zepto" },
  ],
  blinkit: [
    { name: "Amul Butter 100g", price: 50, platform: "blinkit" },
    { name: "Aashirvaad Atta 5kg", price: 259, platform: "blinkit" },
    { name: "Maggi Noodles 70g x4", price: 62, platform: "blinkit" },
    { name: "Tata Salt 1kg", price: 21, platform: "blinkit" },
    { name: "Surf Excel Matic 1kg", price: 185, platform: "blinkit" },
  ],
  swiggy: [
    { name: "Amul Butter 100g", price: 58, platform: "swiggy" },
    { name: "Aashirvaad Atta 5kg", price: 275, platform: "swiggy" },
    { name: "Maggi Noodles 70g 4pk", price: 67, platform: "swiggy" },
    { name: "Tata Salt 1kg", price: 23, platform: "swiggy" },
    { name: "Surf Excel 1kg", price: 195, platform: "swiggy" },
  ],
};

// ── TEST CASES ────────────────────────────────────────────────────────────────
const TESTS = [
  {
    name: "Price Extraction",
    run() {
      const texts = ["₹55", "Rs 55.50", "55", "MRP: ₹100 Offer: ₹55"];
      const expected = [55, 55.5, 55, 55];
      const passed = texts.every((t, i) => extractPrice(t) === expected[i]);
      return { passed, details: texts.map((t, i) => `"${t}" → ${extractPrice(t)}`) };
    },
  },
  {
    name: "Fuzzy Matching",
    run() {
      const pairs = [
        ["Amul Butter 100g", "amul butter 100 g", true],
        ["Maggi Noodles 70g Pack of 4", "Maggi Noodles 70g 4pk", true],
        ["Surf Excel 1kg", "Ariel 1kg", false],
      ];
      const results = pairs.map(([a, b, expected]) => {
        const got = fuzzyMatch(a.toLowerCase(), b.toLowerCase());
        return { a, b, expected, got, passed: got === expected };
      });
      return { passed: results.every(r => r.passed), details: results };
    },
  },
  {
    name: "Guardrail: Suspicious Price",
    run() {
      const mockComparison = {
        recommendation: { bestPlatform: "blinkit", confidence: "high" },
        platformTotals: { blinkit: { subtotal: 100 }, zepto: { subtotal: 1000 } }, // 90% diff
        itemComparison: [],
      };
      const issues = guardrailCheck(mockComparison, { blinkit: [{ name: "test" }] });
      const passed = issues.some(i => i.includes("Suspicious"));
      return { passed, details: issues };
    },
  },
  {
    name: "Guardrail: Invalid Platform",
    run() {
      const mockComparison = {
        recommendation: { bestPlatform: "amazon", confidence: "high" },
        platformTotals: {},
        itemComparison: [],
      };
      const issues = guardrailCheck(mockComparison, {});
      const passed = issues.some(i => i.includes("Invalid platform"));
      return { passed, details: issues };
    },
  },
  {
    name: "Total Calculation",
    run() {
      const totals = calculateTotals(MOCK_PLATFORM_DATA);
      const blinkitCheaper = totals.blinkit < totals.zepto;
      return {
        passed: blinkitCheaper,
        details: { totals, blinkitCheaper },
      };
    },
  },
  {
    name: "Best Platform Selection",
    run() {
      const totals = calculateTotals(MOCK_PLATFORM_DATA);
      const best = Object.entries(totals).sort(([, a], [, b]) => a - b)[0][0];
      const passed = best === "blinkit";
      return { passed, details: { totals, winner: best } };
    },
  },
];

// ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────
function extractPrice(text) {
  if (!text) return null;
  const match = String(text).match(/[\d,]+\.?\d*/g);
  if (match) return parseFloat(match[match.length - 1].replace(",", ""));
  return null;
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const ca = clean(a), cb = clean(b);
  if (ca.includes(cb) || cb.includes(ca)) return true;
  const wa = ca.split(/\s+/), wb = cb.split(/\s+/);
  const overlap = wa.filter(w => wb.includes(w) && w.length > 2);
  return overlap.length / Math.max(wa.length, wb.length) > 0.5;
}

function guardrailCheck(comparison, platformData) {
  const issues = [];
  const validPlatforms = ["zepto", "blinkit", "swiggy"];
  if (comparison.recommendation?.bestPlatform &&
    !validPlatforms.includes(comparison.recommendation.bestPlatform.toLowerCase())) {
    issues.push(`Invalid platform recommendation: ${comparison.recommendation.bestPlatform}`);
  }
  const totals = comparison.platformTotals || {};
  const prices = Object.values(totals).map(p => p?.subtotal).filter(Boolean);
  if (prices.length >= 2) {
    const min = Math.min(...prices), max = Math.max(...prices);
    if (max > 0 && (max - min) / max > 0.5) {
      issues.push(`Suspicious price difference: ₹${min} vs ₹${max}`);
    }
  }
  return issues;
}

function calculateTotals(platformData) {
  const totals = {};
  for (const [platform, items] of Object.entries(platformData)) {
    totals[platform] = items.reduce((sum, i) => sum + (i.price || 0), 0);
  }
  return totals;
}

// ── RUN TESTS ─────────────────────────────────────────────────────────────────
function runEvals() {
  console.log("\n🧪 SmartCart AI — Evaluation Suite");
  console.log("=".repeat(50));

  let passed = 0, failed = 0;
  for (const test of TESTS) {
    try {
      const result = test.run();
      const icon = result.passed ? "✅" : "❌";
      console.log(`${icon} ${test.name}`);
      if (!result.passed || process.argv.includes("--verbose")) {
        console.log("   ", JSON.stringify(result.details, null, 2).replace(/\n/g, "\n    "));
      }
      if (result.passed) passed++;
      else failed++;
    } catch (e) {
      console.log(`💥 ${test.name} — THREW: ${e.message}`);
      failed++;
    }
  }

  console.log("=".repeat(50));
  console.log(`\n📊 Results: ${passed}/${TESTS.length} passed, ${failed} failed`);
  console.log(passed === TESTS.length ? "\n🎉 All tests passed!" : "\n⚠️ Some tests failed");

  // Mock agent run summary
  console.log("\n📋 Mock Agent Run:");
  const totals = calculateTotals(MOCK_PLATFORM_DATA);
  const best = Object.entries(totals).sort(([, a], [, b]) => a - b)[0];
  const savings = Math.max(...Object.values(totals)) - best[1];
  console.log(`  Cart items: ${MOCK_CART.length}`);
  console.log(`  Platforms compared: 3`);
  console.log(`  Best platform: ${best[0]} (₹${best[1]})`);
  console.log(`  Max savings: ₹${savings}`);
  console.log(`  Totals: ${JSON.stringify(totals)}`);
}

runEvals();
