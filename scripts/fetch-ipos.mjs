/**
 * fetch-ipos.mjs
 * Pulls current + upcoming IPO data from NSE's public (undocumented) JSON
 * endpoints and rewrites data/ipos.json in the shape index.html expects.
 *
 * Run: node scripts/fetch-ipos.mjs
 * Requires Node 18+ (built-in fetch).
 *
 * NOTES ON NSE:
 * - These endpoints are undocumented and can change without notice.
 * - NSE requires browser-like headers AND a cookie handshake: hit the
 *   homepage first, carry the cookies to the API call.
 * - Cloud IPs (GitHub Actions, AWS) are sometimes blocked. If that happens,
 *   run this on a small VPS / your machine on a cron, or switch to a paid
 *   API and swap out fetchNSE() — the mapping layer below stays the same.
 * - GMP is NOT available from NSE. Either maintain it by hand in a
 *   gmp-overrides.json, or scrape an aggregator (check their ToS first).
 */

import { readFile, writeFile } from "node:fs/promises";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/market-data/all-upcoming-issues-ipo",
};

async function nseSession() {
  // Handshake: NSE sets cookies on the homepage that the API endpoints require.
  const res = await fetch("https://www.nseindia.com", { headers: HEADERS });
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

async function fetchNSE(path, cookie) {
  const res = await fetch(`https://www.nseindia.com${path}`, {
    headers: { ...HEADERS, Cookie: cookie },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toISO(d) {
  // NSE dates arrive in formats like "17-Jul-2026"; normalise to YYYY-MM-DD.
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function num(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isNaN(n) ? null : n;
}

function mapIssue(raw, status) {
  // Field names below reflect NSE's current schema; verify against a live
  // response and adjust — this is the ONLY place you should need to edit
  // if NSE renames fields or you swap in another provider.
  const [min, max] = String(raw.issuePrice ?? raw.priceBand ?? "")
    .split(/[-–to]+/)
    .map(num);
  return {
    id: slug(raw.companyName ?? raw.company ?? "unknown"),
    company: raw.companyName ?? raw.company,
    exchange: raw.series === "SME" ? "NSE SME" : "NSE, BSE",
    board: raw.series === "SME" ? "SME" : "Mainboard",
    sector: raw.industry ?? "—",
    status,
    priceBand: { min: min ?? 0, max: max ?? min ?? 0 },
    lotSize: num(raw.lotSize) ?? 0,
    issueSizeCr: num(raw.issueSize) ?? 0,
    openDate: toISO(raw.issueStartDate),
    closeDate: toISO(raw.issueEndDate),
    allotmentDate: null, // fill from BSE/registrar if you need it
    listingDate: toISO(raw.listingDate),
    gmp: null,
    subscription: raw.noOfTimesSubscribed
      ? { qib: null, nii: null, retail: null, total: num(raw.noOfTimesSubscribed) }
      : null,
  };
}

async function main() {
  const cookie = await nseSession();

  const [current, upcoming] = await Promise.all([
    fetchNSE("/api/ipo-current-issue", cookie).catch(() => []),
    fetchNSE("/api/all-upcoming-issues?category=ipo", cookie).catch(() => []),
  ]);

  const ipos = [
    ...(Array.isArray(current) ? current : []).map((r) => mapIssue(r, "open")),
    ...(Array.isArray(upcoming) ? upcoming : []).map((r) => mapIssue(r, "upcoming")),
  ];

  // Optional hand-maintained overrides (GMP, allotment dates, corrections).
  try {
    const overrides = JSON.parse(await readFile("data/overrides.json", "utf8"));
    for (const ipo of ipos) Object.assign(ipo, overrides[ipo.id] ?? {});
  } catch {
    /* no overrides file — fine */
  }

  if (ipos.length === 0) {
    console.error("No issues fetched — keeping existing ipos.json untouched.");
    process.exit(0); // don't wipe good data with an empty response
  }

  const out = {
    lastUpdated: new Date().toISOString(),
    source: "nseindia.com",
    ipos,
  };
  await writeFile("data/ipos.json", JSON.stringify(out, null, 2));
  console.log(`Wrote ${ipos.length} issues to data/ipos.json`);
}

main().catch((e) => {
  console.error("Fetch failed:", e.message);
  process.exit(1);
});
