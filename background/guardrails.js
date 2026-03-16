// background/guardrails.js
// Safety checks on LLM output before showing to user

export class Guardrails {
  check(comparison, platformData) {
    const issues = [];

    if (!comparison) {
      issues.push("No comparison data generated");
      return issues;
    }

    // 1. Sanity check: recommendation must be one of the valid platforms
    const validPlatforms = ["zepto", "blinkit", "swiggy"];
    if (
      comparison.recommendation?.bestPlatform &&
      !validPlatforms.includes(comparison.recommendation.bestPlatform.toLowerCase())
    ) {
      issues.push(`Invalid platform recommendation: ${comparison.recommendation.bestPlatform}`);
    }

    // 2. Price sanity: total savings shouldn't be > 50% of cart value
    const totals = comparison.platformTotals || {};
    const allPrices = Object.values(totals)
      .map((p) => p?.subtotal)
      .filter(Boolean);
    if (allPrices.length >= 2) {
      const min = Math.min(...allPrices);
      const max = Math.max(...allPrices);
      if (max > 0 && (max - min) / max > 0.5) {
        issues.push(
          `Suspicious price difference: ₹${min} vs ₹${max} (>50% gap — possible scraping error)`
        );
      }
    }

    // 3. Verify recommended platform actually has data
    const recommended = comparison.recommendation?.bestPlatform?.toLowerCase();
    if (recommended && (!platformData[recommended] || platformData[recommended].length === 0)) {
      issues.push(`Recommended platform "${recommended}" has no scraped data`);
    }

    // 4. Confidence check
    if (comparison.recommendation?.confidence === "low") {
      issues.push("Low confidence recommendation — insufficient data");
    }

    // 5. Price range check per item (catch obviously wrong prices)
    const items = comparison.itemComparison || [];
    for (const item of items) {
      for (const platform of validPlatforms) {
        const price = item[platform]?.price;
        if (price && (price < 1 || price > 50000)) {
          issues.push(`Suspicious price for "${item.item}" on ${platform}: ₹${price}`);
        }
      }
    }

    return issues;
  }
}
