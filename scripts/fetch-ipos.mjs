/**
 * fetch-ipos.mjs (v2)
 * Pulls current + upcoming + past (listed) IPOs from NSE and merges them
 * into data/ipos.json.
 *
 * Safety rules built in:
 * - A failed or empty fetch NEVER wipes existing data for that section.
 *   Your hand-seeded "listed" entries survive every cron run.
 * - data/overrides.json (optional) is merged last, keyed by id — use it
 *   for GMP, corrections, or listing prices NSE doesn't provide.
 *
 * VERIFY ONCE: the past-issues endpoint path below. Open
 * https://www.nseindia.com/market-data/all-upcoming-issues-ipo
 * -> "Past Issues" tab -> DevTools Network panel -> find the API call,
 * and if the path differs, update PAST_ISSUES_PATH.
 */

import { readFile, writeFile } from "node:fs/promises";

const PAST_ISSUES_PATH = "/api/public-past-issues"; // verify in DevTools
const YEAR_FROM = "2026-01-01";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/market-data/all-upcoming-issues-ipo",
};

const NSE_HOLIDAYS = new Set([
  "2026-01-15", // Maharashtra municipal election
  "2026-01-26", // Republic Day
  "2026-03-03", // Holi
  "2026-03-26", // Ram Navami
  "2026-03-31", // Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Id
  "2026-06-26", // Muharram
  "2026-09-14", // Ganesh Chaturthi
  "2026-10-02", // Gandhi Jayanti
  "2026-10-20", // Dussehra
  "2026-11-10", // Diwali-Balipratipada
  "2026-11-24", // Guru Nanak Jayanti
  "2026-12-25", // Christmas
]);

async function nseSession() {
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

// ── Per-IPO detail (/api/ipo-detail): correct band, lot, issue size, dates
//    + consolidated NSE+BSE category-wise subscription. Schema verified 2 Aug 2026.
async function fetchIpoDetail(symbol, board, cookie) {
  const series = board === "SME" ? "SME" : "EQ";
  let data;
  try {
    data = await fetchNSE(`/api/ipo-detail?symbol=${encodeURIComponent(symbol)}&series=${series}`, cookie);
  } catch {
    const alt = series === "EQ" ? "SME" : "EQ";
    data = await fetchNSE(`/api/ipo-detail?symbol=${encodeURIComponent(symbol)}&series=${alt}`, cookie);
  }
  const out = {};

  // issueInfo: title/value pairs
  const info = {};
  for (const row of data?.issueInfo?.dataList ?? []) {
    if (row?.title) info[row.title] = String(row.value ?? "");
  }
  const period = info["Issue Period"]?.match(/(\d{2}-\w{3}-\d{4})\s*to\s*(\d{2}-\w{3}-\d{4})/);
  if (period) { out.openDate = toISO(period[1]); out.closeDate = toISO(period[2]); }

  const range = info["Price Range"]?.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)\s*to\s*Rs\.?\s*([\d,]+(?:\.\d+)?)/i);
  if (range) out.priceBand = { min: num(range[1]), max: num(range[2]) };

  const lot = info["Bid Lot"]?.match(/([\d,]+)\s*Equity Shares/i);
  if (lot) out.lotSize = num(lot[1]);

  const size = info["Issue Size"]?.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)\s*(million|crore|cr\b|lakh)/i);
  if (size) {
    const v = num(size[1]), unit = size[2].toLowerCase();
    out.issueSizeCr = unit.startsWith("million") ? Math.round(v * 10) / 100
                    : unit.startsWith("lakh") ? v / 100 : v;
  }

  // activeCat = consolidated (NSE+BSE) subscription. srNo: 1=QIB, 2=NII,
  // 2.1=bHNI, 2.2=sHNI, 3=Retail; Total row has srNo null.
  const bySr = {};
  for (const r of data?.activeCat?.dataList ?? []) {
    if (!r || r.srNo === "Sr.No.") continue; // header row
    const key = r.srNo ?? (String(r.category).trim() === "Total" ? "total" : null);
    if (key != null) bySr[key] = num(r.noOfTotalMeant);
  }
  const sub = {
    qib: bySr["1"] ?? null, nii: bySr["2"] ?? null,
    bnii: bySr["2.1"] ?? null, snii: bySr["2.2"] ?? null,
    retail: bySr["3"] ?? null, total: bySr["total"] ?? null,
  };
  if (Object.values(sub).some((v) => typeof v === "number")) out.subscription = sub;

  return out;
}

const slug = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function toISO(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function num(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isNaN(n) ? null : n;
}

function base(raw, status) {
  const [min, max] = String(raw.issuePrice ?? raw.priceBand ?? "")
    .split(/[-–to]+/)
    .map(num);
  return {
    symbol: raw.symbol ?? null,
    id: slug(raw.companyName ?? raw.company ?? "unknown"),
    company: raw.companyName ?? raw.company,
    exchange: raw.series === "SME" ? "NSE SME" : "NSE, BSE",
    board: raw.series === "SME" ? "SME" : "Mainboard",
    sector: raw.industry ?? "—",
    status,
    priceBand: (() => {
      let bMin = min ?? 0, bMax = max ?? min ?? 0;
      // NSE reports the band scaled down 1000x (e.g. "0.56" for ₹560); rescale.
      if (bMax > 0 && bMax < 10) { bMin = Math.round(bMin * 1000); bMax = Math.round(bMax * 1000); }
      return { min: bMin, max: bMax };
    })(),
    lotSize: num(raw.lotSize) ?? 0,
    issueSizeCr: num(raw.issueSize) ?? 0,
    openDate: toISO(raw.issueStartDate),
    closeDate: toISO(raw.issueEndDate),
    allotmentDate: null,
    listingDate: toISO(raw.listingDate),
    gmp: null,
    subscription: raw.noOfTimesSubscribed
      ? { qib: null, nii: null, retail: null, total: num(raw.noOfTimesSubscribed) }
      : null,
  };
}

function mapPast(raw) {
  // Adjust field names after checking a real response in DevTools.
  const ipo = base(raw, "listed");
  const issuePrice = num(raw.issuePrice ?? raw.finalIssuePrice) ?? ipo.priceBand.max;
  const listPrice = num(raw.listingPrice ?? raw.listingDayPrice);
  if (issuePrice && listPrice) {
    ipo.listing = {
      issuePrice,
      listPrice,
      gainPct: Math.round(((listPrice - issuePrice) / issuePrice) * 1000) / 10,
    };
  }
  return ipo;
}

function addBusinessDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    const ds = d.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !NSE_HOLIDAYS.has(ds)) added++;
  }
  return d.toISOString().slice(0, 10);
}

async function main() {
  // Load existing file so failed fetches never wipe good data.
  let existing = { ipos: [] };
  try {
    existing = JSON.parse(await readFile("data/ipos.json", "utf8"));
  } catch { /* first run */ }
  const keep = (status) => existing.ipos.filter((i) => i.status === status);

  const cookie = await nseSession();

  const [current, upcoming, past] = await Promise.all([
    fetchNSE("/api/ipo-current-issue", cookie).catch((e) => (console.error("current:", e.message), null)),
    fetchNSE("/api/all-upcoming-issues?category=ipo", cookie).catch((e) => (console.error("upcoming:", e.message), null)),
    fetchNSE(PAST_ISSUES_PATH, cookie).catch((e) => (console.error("past:", e.message), null)),
  ]);

  const open = Array.isArray(current) && current.length
    ? current.map((r) => base(r, "open"))
    : keep("open");

  const upc = Array.isArray(upcoming) && upcoming.length
    ? upcoming.map((r) => base(r, "upcoming"))
    : keep("upcoming");

  let listed;
  const pastArr = Array.isArray(past) ? past : past?.data;
  if (Array.isArray(pastArr) && pastArr.length) {
    const fetched = pastArr
      .map(mapPast)
      .filter((i) => !i.listingDate || i.listingDate >= YEAR_FROM);
    // Fetched entries win; hand-seeded entries NSE doesn't return are kept.
    const ids = new Set(fetched.map((i) => i.id));
    listed = [...fetched, ...keep("listed").filter((i) => !ids.has(i.id))];
  } else {
    listed = keep("listed");
  }

  // Newest listings first.
  listed.sort((a, b) => (b.listingDate ?? "").localeCompare(a.listingDate ?? ""));

  // Derive status from dates and dedupe — NSE's "upcoming" feed includes open issues too.
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map();
  for (const ipo of [...open, ...upc]) {
    if (ipo.openDate && ipo.openDate <= today && (!ipo.closeDate || ipo.closeDate >= today)) ipo.status = "open";
    else if (ipo.openDate && ipo.openDate > today) ipo.status = "upcoming";
    const prev = byId.get(ipo.id);
    if (!prev || prev.status !== "open") byId.set(ipo.id, ipo);
  }

  // Enrich open + upcoming issues from the per-IPO detail endpoint.
  for (const ipo of byId.values()) {
    if (!ipo.symbol) continue;
    try {
      Object.assign(ipo, await fetchIpoDetail(ipo.symbol, ipo.board, cookie));
      await new Promise((r) => setTimeout(r, 800)); // be gentle to NSE
    } catch (e) {
      console.error(`detail ${ipo.symbol}:`, e.message);
    }
  }
  
  // SEBI T+3 regime: derive allotment (T+1) and listing (T+3) from close date when missing.
  for (const ipo of byId.values()) {
    if (ipo.closeDate) {
      if (!ipo.allotmentDate) ipo.allotmentDate = addBusinessDays(ipo.closeDate, 1);
      if (!ipo.listingDate) ipo.listingDate = addBusinessDays(ipo.closeDate, 3);
    }
  }
  const ipos = [...byId.values(), ...listed];

  // Optional hand-maintained overrides (GMP, listing prices, corrections).
  try {
    const overrides = JSON.parse(await readFile("data/overrides.json", "utf8"));
    for (const ipo of ipos) Object.assign(ipo, overrides[ipo.id] ?? {});
  } catch { /* no overrides file — fine */ }

  // Manual issue sizes (data/issue-sizes.json): id -> ₹ crore. Wins for issueSizeCr.
  try {
    const sizes = JSON.parse(await readFile("data/issue-sizes.json", "utf8"));
    for (const ipo of ipos) {
      if (typeof sizes[ipo.id] === "number") ipo.issueSizeCr = sizes[ipo.id];
    }
  } catch { /* no issue-sizes file — fine */ }

  if (!ipos.length) {
    console.error("Nothing fetched and nothing existing — aborting without writing.");
    process.exit(0);
  }

  await writeFile(
    "data/ipos.json",
    JSON.stringify({ lastUpdated: new Date().toISOString(), source: "nseindia.com", ipos }, null, 2)
  );
  const counts = ipos.reduce((a, i) => (a[i.status] = (a[i.status] || 0) + 1, a), {});
  console.log(`Wrote ${counts.open || 0} open, ${counts.upcoming || 0} upcoming, ${counts.listed || 0} listed.`);
}

main().catch((e) => {
  console.error("Fetch failed:", e.message);
  process.exit(1);
});
