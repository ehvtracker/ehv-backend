// server.js 
// Backend + hourly EDCC sync for your EHV tracker

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const cheerio = require("cheerio");

// node-fetch shim so this works in CommonJS
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 4000;

// ---- Config ----
const EDCC_BASE = "https://www.equinediseasecc.org";
const EDCC_EHV_PAGE = `${EDCC_BASE}/equine-herpesvirus`;

// ---------- County -> pin coordinates (county-seat style) ----------
const COUNTY_COORDS = {
  "Lancaster County, PA": { lat: 40.0379, lng: -76.3055 },
  "Payne County, OK": { lat: 36.1156, lng: -97.0584 },
  "Logan County, OK": { lat: 35.8784, lng: -97.4253 },
  "Rocky View County, AB": { lat: 51.2, lng: -114.2 },
  "Harris County, TX": { lat: 29.7604, lng: -95.3698 },
  "Erath County, TX": { lat: 32.2207, lng: -98.2023 },
  "Lee County, TX": { lat: 30.1822, lng: -96.9369 },
  "Randall County, TX": { lat: 34.977, lng: -101.918 },
  "Parker County, TX": { lat: 32.7593, lng: -97.7973 },
  "Hyde County, SD": { lat: 44.5214, lng: -99.4454 },
  "Love County, OK": { lat: 33.9387, lng: -97.1167 },
  "Eddy County, NM": { lat: 32.4207, lng: -104.2288 },
  "McLennan County, TX": { lat: 31.5493, lng: -97.1467 },
  "Hood County, TX": { lat: 32.4421, lng: -97.7942 },
  "Wise County, TX": { lat: 33.234, lng: -97.5867 },
  "Dona Ana County, NM": { lat: 32.3199, lng: -106.7637 },
  "Larimer County, CO": { lat: 40.5853, lng: -105.0844 },
  "Fort Bend County, TX": { lat: 29.5822, lng: -95.7608 },
  "Bell County, TX": { lat: 31.056, lng: -97.4645 },
  "Mayes County, OK": { lat: 36.3084, lng: -95.3161 },
  "Wharton County, TX": { lat: 29.3119, lng: -96.103 },
  "Montgomery County, TX": { lat: 30.3119, lng: -95.4561 },
  "East Baton Rouge Parish, LA": { lat: 30.4515, lng: -91.1871 },
  "St. Mary's County, MD": { lat: 38.2918, lng: -76.6352 },
  "Red Deer County, AB": { lat: 52.2681, lng: -113.8112 },
  "Regional Municipality of Waterloo, ON": { lat: 43.4643, lng: -80.5204 },
  "Regional Municipality of Halton, ON": { lat: 43.4675, lng: -79.6877 },
  "Oklahoma County, OK": { lat: 35.4676, lng: -97.5164 },
  "Waller County, TX": { lat: 30.0972, lng: -96.0783 },
  "McClain County, OK": { lat: 35.0137, lng: -97.3614 },
  "Madison County, OH": { lat: 39.8864, lng: -83.4483 },
  "Northumberland County, PA": { lat: 40.862, lng: -76.7944 },
  "Maricopa County, AZ": { lat: 33.4484, lng: -112.074 },
  "Spokane County, WA": { lat: 47.6588, lng: -117.426 },
  "Beaverhead County, MT": { lat: 45.2166, lng: -112.636 },
  "Waupaca County, WI": { lat: 44.358, lng: -89.0859 }
  // 👉 Add more here as new counties show up
};

// Clean EDCC county text & build key "County, ST"
function makeCountyKey(countyRaw, state) {
  if (!countyRaw || !state) return null;
  let name = countyRaw.trim();

  // Strip leading clinical words like "Neurologic" or "Respiratory"
  name = name.replace(/^(Neurologic|Respiratory)\s+/i, "");

  name = name.replace(/\s+/g, " "); // collapse spaces
  return `${name}, ${state}`;
}

function getCoordsForCounty(countyRaw, state) {
  const key = makeCountyKey(countyRaw, state);
  if (!key) return { lat: null, lng: null };
  return COUNTY_COORDS[key] || { lat: null, lng: null };
}

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// ---- Database setup ----
const db = new Database("ehv.db");

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS outbreaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- EDCC identifiers
    alert_id TEXT UNIQUE,
    outbreak_identifier TEXT,

    -- Disease info
    disease TEXT,             -- "Equine Herpesvirus- Neurologic" / "Equine Herpesvirus- Respiratory"
    category TEXT,            -- "Neurologic" / "Respiratory" / etc.

    -- Location
    country TEXT,
    state TEXT,
    county TEXT,

    -- Dates
    date_label TEXT,          -- as shown on EDCC e.g. "November 28, 2025"
    reported_at_utc TEXT,     -- ISO 8601

    -- Status + numbers
    status TEXT,              -- e.g. "Confirmed Case(s) - Official Quarantine", "Quarantine Released"
    source TEXT,
    num_confirmed INTEGER,
    num_suspected INTEGER,
    num_exposed INTEGER,
    num_euthanized INTEGER,
    facility_type TEXT,

    -- Content
    comments TEXT,
    raw_text TEXT,

    -- For your map
    lat REAL,
    lng REAL
  );
`);

// Prepared statements
const selectByAlertId = db.prepare(
  "SELECT * FROM outbreaks WHERE alert_id = ?"
);

const insertOutbreak = db.prepare(`
  INSERT INTO outbreaks (
    alert_id, outbreak_identifier,
    disease, category,
    country, state, county,
    date_label, reported_at_utc,
    status, source,
    num_confirmed, num_suspected, num_exposed, num_euthanized,
    facility_type,
    comments, raw_text,
    lat, lng
  )
  VALUES (
    @alert_id, @outbreak_identifier,
    @disease, @category,
    @country, @state, @county,
    @date_label, @reported_at_utc,
    @status, @source,
    @num_confirmed, @num_suspected, @num_exposed, @num_euthanized,
    @facility_type,
    @comments, @raw_text,
    @lat, @lng
  )
`);

const updateOutbreak = db.prepare(`
  UPDATE outbreaks SET
    outbreak_identifier = @outbreak_identifier,
    disease = @disease,
    category = @category,
    country = @country,
    state = @state,
    county = @county,
    date_label = @date_label,
    reported_at_utc = @reported_at_utc,
    status = @status,
    source = @source,
    num_confirmed = @num_confirmed,
    num_suspected = @num_suspected,
    num_exposed = @num_exposed,
    num_euthanized = @num_euthanized,
    facility_type = @facility_type,
    comments = @comments,
    raw_text = @raw_text,
    lat = @lat,
    lng = @lng
  WHERE alert_id = @alert_id
`);

// ---- Helpers: parsing EDCC pages ----

function toISOFromDateLabel(dateLabel) {
  if (!dateLabel) return null;
  const d = new Date(dateLabel);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Extracts info from a single alert page HTML
function parseAlertHtml(html) {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  // Disease line: e.g. "Equine Herpesvirus- Neurologic"
  let disease = null;
  $("a").each((i, el) => {
    const txt = $(el).text().trim();
    if (txt.startsWith("Equine Herpesvirus")) {
      disease = txt;
      return false;
    }
    return;
  });

  let category = null;
  if (disease) {
    const parts = disease.split("-");
    category = parts[1] ? parts[1].trim() : null;
  }

  // County, State: "Some County, ST"
  const countyStateMatch = bodyText.match(/([A-Za-z\s]+ County),\s+([A-Z]{2})/);
  const county = countyStateMatch ? countyStateMatch[1].trim() : null;
  const state = countyStateMatch ? countyStateMatch[2].trim() : null;

  // Alert & Outbreak IDs
  const alertMatch = bodyText.match(/Alert ID:\s*(\d+)/i);
  const outbreakMatch = bodyText.match(/Outbreak Identifier:\s*(\d+)/i);

  const alert_id = alertMatch ? alertMatch[1] : null;
  const outbreak_identifier = outbreakMatch ? outbreakMatch[1] : null;

  // Date: look for "Month DD, YYYY"
  const dateMatch = bodyText.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/
  );
  const date_label = dateMatch ? dateMatch[0] : null;
  const reported_at_utc = toISOFromDateLabel(date_label);

  // Status: text between date and "Source:"
  let status = null;
  if (date_label) {
    const statusRegex = new RegExp(
      date_label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+([^S]+)Source:",
      "i"
    );
    const m = bodyText.match(statusRegex);
    if (m) status = m[1].trim();
  }
  if (!status) {
    // fallback: look for "Confirmed Case(s)" or "Quarantine Released" etc.
    const statusSimple = bodyText.match(
      /(Confirmed Case\(s\)[^S]+|Quarantine Released|Outbreak Update)/i
    );
    status = statusSimple ? statusSimple[0].trim() : null;
  }

  // Source
  const sourceMatch = bodyText.match(/Source:\s*([^N]+?)Number/i);
  const source = sourceMatch ? sourceMatch[1].trim() : null;

  // Numbers
  const num_confirmedMatch = bodyText.match(/Number Confirmed:\s*([\w]+)/i);
  const num_suspectedMatch = bodyText.match(/Number Suspected:\s*([\w]+)/i);
  const num_exposedMatch = bodyText.match(/Number Exposed:\s*([\w]+)/i);
  const num_euthanizedMatch = bodyText.match(/Number Euthanized:\s*([\w]+)/i);

  function toNum(value) {
    if (!value || value.toLowerCase() === "unknown") return null;
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  const num_confirmed = num_confirmedMatch
    ? toNum(num_confirmedMatch[1])
    : null;
  const num_suspected = num_suspectedMatch
    ? toNum(num_suspectedMatch[1])
    : null;
  const num_exposed = num_exposedMatch ? toNum(num_exposedMatch[1]) : null;
  const num_euthanized = num_euthanizedMatch
    ? toNum(num_euthanizedMatch[1])
    : null;

  // Facility Type (if present)
  const facilityMatch = bodyText.match(/Facility Type:\s*([^C]+?)Comments:/i);
  const facility_type = facilityMatch ? facilityMatch[1].trim() : null;

  // Comments: between "Comments:" and either "Previous Alerts:" or "Search for County"
  let comments = null;
  const commentsRegex =
    /Comments:\s*(.+?)(Previous Alerts:|Search for County|$)/i;
  const commentsMatch = bodyText.match(commentsRegex);
  if (commentsMatch) comments = commentsMatch[1].trim();

  // 👉 Look up a map pin for this county/state
  const { lat, lng } = getCoordsForCounty(county, state);

  return {
    alert_id,
    outbreak_identifier,
    disease,
    category,
    country: "USA", // override later if needed
    state,
    county,
    date_label,
    reported_at_utc,
    status,
    source,
    num_confirmed,
    num_suspected,
    num_exposed,
    num_euthanized,
    facility_type,
    comments,
    raw_text: bodyText,
    lat,
    lng
  };
}

// Fetch the main EHV page and pull the latest alert URLs
async function getLatestAlertUrls() {
  const resp = await fetch(EDCC_EHV_PAGE);
  if (!resp.ok) {
    throw new Error(`Failed to fetch EHV page: ${resp.status}`);
  }
  const html = await resp.text();
  const $ = cheerio.load(html);

  const urls = new Set();

  $("a").each((i, el) => {
    const href = $(el).attr("href") || "";
    if (href.includes("/alerts?alertID=")) {
      const full = new URL(href, EDCC_BASE).toString();
      urls.add(full);
    }
  });

  // Take first 10 unique alert URLs (latest EHV alerts)
  return Array.from(urls).slice(0, 10);
}

// Fetch and parse a single alert
async function fetchAlert(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch alert ${url}: ${resp.status}`);
  }
  const html = await resp.text();
  return parseAlertHtml(html);
}

// Upsert one outbreak row
function upsertOutbreak(record) {
  if (!record.alert_id) {
    console.warn("Skipping record without alert_id");
    return;
  }

  const existing = selectByAlertId.get(record.alert_id);
  if (existing) {
    updateOutbreak.run(record);
  } else {
    insertOutbreak.run(record);
  }
}

// Main sync function
async function syncFromEDCC() {
  console.log(`[EDCC] Sync starting at ${new Date().toISOString()}`);

  let urls;
  try {
    urls = await getLatestAlertUrls();
  } catch (err) {
    console.error("[EDCC] Failed to get alert URLs", err);
    return;
  }

  for (const url of urls) {
    try {
      const rec = await fetchAlert(url);
      if (!rec || !rec.alert_id) {
        console.warn("[EDCC] Parsed record missing alert_id from", url);
        continue;
      }
      upsertOutbreak(rec);
      console.log(
        `[EDCC] Updated alert ${rec.alert_id} (${rec.county}, ${rec.state})`
      );
    } catch (err) {
      console.error("[EDCC] Failed to sync alert", url, err);
    }
  }

  console.log("[EDCC] Sync finished");
}

// ---- API routes ----

// List outbreaks (optionally with time filter)
app.get("/outbreaks", (req, res) => {
  const { sinceHours } = req.query;

  try {
    let rows;
    if (sinceHours) {
      const hours = parseInt(sinceHours, 10);
      if (isNaN(hours) || hours <= 0) {
        return res
          .status(400)
          .json({ error: "sinceHours must be a positive number" });
      }
      rows = db
        .prepare(
          `
          SELECT * FROM outbreaks
          WHERE reported_at_utc IS NOT NULL
            AND reported_at_utc >= datetime('now', ?)
          ORDER BY reported_at_utc DESC
        `
        )
        .all(`-${hours} hours`);
    } else {
      rows = db
        .prepare(
          `
          SELECT * FROM outbreaks
          ORDER BY reported_at_utc DESC
        `
        )
        .all();
    }

    res.json(rows);
  } catch (err) {
    console.error("Error querying outbreaks", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get a single outbreak by alert_id
app.get("/outbreaks/:alertId", (req, res) => {
  try {
    const row = selectByAlertId.get(req.params.alertId);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (err) {
    console.error("Error getting outbreak", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manual trigger for you to hit from browser/Postman
app.post("/admin/sync-edcc", async (req, res) => {
  try {
    await syncFromEDCC();
    res.json({ ok: true });
  } catch (err) {
    console.error("Manual EDCC sync failed", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

// ---- Schedule hourly sync ----
// "0 * * * *" = at minute 0 of every hour
cron.schedule("0 * * * *", () => {
  syncFromEDCC().catch((err) => {
    console.error("Scheduled EDCC sync failed", err);
  });
});

// Do an initial sync on startup (you can comment this out if you want)
syncFromEDCC().catch((err) => console.error("Initial EDCC sync failed", err));

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`EHV backend listening on port ${PORT}`);
});
