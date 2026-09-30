import { Hono } from "hono";
import { cors } from "hono/cors";
import { ThaiWaterService } from "./cache-service.js";
import {
  D1Database,
  syncSnapshotToD1,
  queryWaterLevelHistory,
  queryWaterLevelSnapshotFromD1,
  queryRainfallSnapshotFromD1,
  upsertWaterLevelGraphPoints,
} from "./db.js";
import { toIso } from "./thaiwater.js";
import { WaterLevelRecord, RainfallRecord } from "./types.js";

type Bindings = {
  DB?: D1Database;
  STADIA_API_KEY?: string;
  ADMIN_TOKEN?: string;
};

// สร้าง Service สำหรับจัดการแคชใน Worker isolate
const thaiWaterService = new ThaiWaterService(
  {
    ttlMs: 5 * 60 * 1000, // 5 นาที
    autoStartPolling: false, // บน Workers ใช้ Cron Triggers แทน setInterval
  },
  {
    timeoutMs: 25000, // abort upstream request ที่ช้าเกิน 25 วินาที
  }
);

const app = new Hono<{ Bindings: Bindings }>();

// เปิดใช้งาน CORS สำหรับทุก request
app.use("/*", cors());

// ----- Admin Auth -----
// Endpoint /api/admin/* ต้องส่ง header: Authorization: Bearer <ADMIN_TOKEN>
// (token เก็บเป็น Worker secret — ถ้ายังไม่ตั้ง จะปิด endpoint ไว้ก่อนเพื่อกันยิงฟรี)
app.use("/api/admin/*", async (c, next) => {
  const adminToken = c.env?.ADMIN_TOKEN;
  if (!adminToken) {
    return c.json({ success: false, message: "Admin endpoints are disabled (ADMIN_TOKEN secret is not configured)" }, 503);
  }

  const provided = c.req.header("Authorization") ?? "";
  const token = provided.startsWith("Bearer ") ? provided.slice(7).trim() : "";
  const providedBytes = new TextEncoder().encode(token);
  const adminBytes = new TextEncoder().encode(adminToken);
  // timingSafeEqual เป็น non-standard extension ของ Workers runtime
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
  };
  if (providedBytes.length !== adminBytes.length ||
      !subtle.timingSafeEqual(providedBytes.buffer, adminBytes.buffer)) {
    return c.json({ success: false, message: "Unauthorized" }, 401);
  }

  await next();
});

// ดักจับ Error รวมในระดับแอปพลิเคชัน
app.onError((err, c) => {
  console.error("[Worker Error]:", err);
  return c.json({ success: false, message: err.message || "Internal Server Error" }, 500);
});

// ----- Filter Helper Functions -----

/** กรองสถานีที่ซ้ำกับ water-level IDs ออก */
function filterOutWaterStations(rainfalls: RainfallRecord[], waterIds: Set<number>): RainfallRecord[] {
  return rainfalls.filter((r) => !waterIds.has(r.station.id));
}

/** กรองตามอำเภอ (ถ้าระบุ) */
function filterByAmphoe<T extends { station: { amphoeNameTh?: string | null } }>(
  list: T[],
  amphoe: string | undefined
): T[] {
  if (!amphoe?.trim()) return list;
  const name = amphoe.trim();
  return list.filter((item) => item.station.amphoeNameTh === name);
}

/** กรองตาม search query (ชื่อ / อำเภอ / ลุ่มน้ำ / ID) */
function filterBySearch<T extends { station: { nameTh?: string | null; nameEn?: string | null; amphoeNameTh?: string | null; basinNameTh?: string | null; id: number } }>(
  list: T[],
  search: string | undefined
): T[] {
  if (!search?.trim()) return list;
  const q = search.trim().toLowerCase();
  return list.filter(
    (item) =>
      item.station.nameTh?.toLowerCase().includes(q) ||
      item.station.nameEn?.toLowerCase().includes(q) ||
      item.station.amphoeNameTh?.toLowerCase().includes(q) ||
      item.station.basinNameTh?.toLowerCase().includes(q) ||
      String(item.station.id).includes(q)
  );
}

/** กรองตาม status ระดับน้ำ: overflow / warning / normal */
function filterWaterByStatus(
  list: WaterLevelRecord[],
  status: string | undefined
): WaterLevelRecord[] {
  if (!status) return list;
  if (status === "overflow") {
    return list.filter((item) => item.freeboardM !== null && item.freeboardM < 0);
  }
  if (status === "warning") {
    return list.filter(
      (item) =>
        (item.freeboardM !== null && item.freeboardM >= 0 && item.freeboardM <= 0.5) ||
        (item.situationLevel !== null && item.situationLevel >= 4)
    );
  }
  if (status === "normal") {
    return list.filter(
      (item) =>
        (item.freeboardM === null || item.freeboardM > 0.5) &&
        (item.situationLevel === null || item.situationLevel < 4)
    );
  }
  return list;
}

/** จำกัดจำนวน records ตาม limit (ถ้าระบุ) */
function applyLimit<T>(list: T[], limit: string | undefined): T[] {
  const n = Number(limit);
  return n > 0 ? list.slice(0, n) : list;
}

const CACHE_CONTROL_SHORT = "public, s-maxage=300, max-age=60";
const CACHE_CONTROL_LONG = "public, s-maxage=3600, max-age=300";

// ----- Route Handlers -----

/**
 * 1. API: สรุปภาพรวมและสถิติสำคัญ จ.อุบลราชธานี (KPIs / Summary)
 */
app.get("/api/summary", async (c) => {
  try {
    const amphoe = c.req.query("amphoe");
    const [{ list: waterLevelsAll, source }, { list: rawRainfalls }] = await Promise.all([
      getWaterLevelsResilient(c),
      getRainfallsResilient(c),
    ]);
    if (source === "collecting") return collectingResponse(c);

    const waterIds = new Set(waterLevelsAll.map((w) => w.station.id));
    let rainfalls = filterOutWaterStations(rawRainfalls, waterIds);

    let waterLevels = filterByAmphoe(waterLevelsAll, amphoe);
    rainfalls = filterByAmphoe(rainfalls, amphoe);

    let overflowCount = 0;
    let warningCount = 0;
    const overflowingStations: WaterLevelRecord[] = [];

    for (const item of waterLevels) {
      if (item.freeboardM !== null && item.freeboardM < 0) {
        overflowCount++;
        overflowingStations.push(item);
      } else if (
        (item.situationLevel !== null && item.situationLevel >= 4) ||
        (item.freeboardM !== null && item.freeboardM <= 0.5)
      ) {
        warningCount++;
      }
    }

    overflowingStations.sort((a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0));

    const sortedRain = [...rainfalls]
      .filter((r) => r.rain24h !== null && r.rain24h > 0)
      .sort((a, b) => (b.rain24h ?? 0) - (a.rain24h ?? 0));

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    return c.json({
      success: true,
      data: {
        provinceCode: "34",
        provinceNameTh: "อุบลราชธานี",
        totalWaterStations: waterLevels.length,
        totalRainStations: rainfalls.length,
        overflowCount,
        warningCount,
        topOverflowStations: overflowingStations.slice(0, 10),
        topRainStations: sortedRain.slice(0, 10),
        maxRainfall24h: sortedRain[0] ?? null,
        cacheStatus: thaiWaterService.getCacheStatus(),
        serverTime: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 2. API: รายการระดับน้ำ Snapshot จ.อุบลราชธานี (พร้อม Filter)
 *    Data Flow: D1 Database (แสดงทันที) → Background Refresh จาก upstream → เก็บลง D1 รอบถัดไป
 */

// ----- Resilient Data Helpers (D1-first + Background Refresh) -----

// Cooldown กันการยิง upstream ถี่เกินไปจาก background refresh (60 วินาที)
const BG_REFRESH_COOLDOWN_MS = 60 * 1000;
let lastBgWaterRefreshAt = 0;
let lastBgRainRefreshAt = 0;

/**
 * Background Refresh: ดึงข้อมูลจาก upstream แล้วเก็บลง D1 (รันเบื้องหลังผ่าน waitUntil)
 * - ใช้ getWaterLevel()/getRainfall() แบบไม่ force → single-flight dedupe กันยิงซ้ำ
 * - มี cooldown 60 วินาทีกัน hammering upstream เมื่อ upstream ล้ม
 */
function triggerWaterBackgroundRefresh(c: any): void {
  const now = Date.now();
  if (now - lastBgWaterRefreshAt < BG_REFRESH_COOLDOWN_MS) return;
  lastBgWaterRefreshAt = now;

  const job = (async () => {
    const waterLevels = await thaiWaterService.getWaterLevel();
    const rainfalls = await thaiWaterService.getRainfall().catch(() => []);
    if (c.env?.DB && waterLevels.length > 0) {
      await syncSnapshotToD1(c.env.DB, waterLevels, rainfalls);
    }
    console.log(`[BG Refresh] Water synced: ${waterLevels.length} stations`);
  })().catch((err) => console.error("[BG Refresh] Water failed:", err?.message));

  if (c.executionCtx) c.executionCtx.waitUntil(job);
}

function triggerRainBackgroundRefresh(c: any): void {
  const now = Date.now();
  if (now - lastBgRainRefreshAt < BG_REFRESH_COOLDOWN_MS) return;
  lastBgRainRefreshAt = now;

  const job = (async () => {
    const rainfalls = await thaiWaterService.getRainfall();
    const waterLevels = await thaiWaterService.getWaterLevel().catch(() => []);
    if (c.env?.DB && rainfalls.length > 0) {
      await syncSnapshotToD1(c.env.DB, waterLevels, rainfalls);
    }
    console.log(`[BG Refresh] Rain synced: ${rainfalls.length} stations`);
  })().catch((err) => console.error("[BG Refresh] Rain failed:", err?.message));

  if (c.executionCtx) c.executionCtx.waitUntil(job);
}

/**
 * ดึงข้อมูลระดับน้ำแบบ Resilient — **แสดงผลจากฐานข้อมูล/แคชเท่านั้น ห้ามรอ upstream เด็ดขาด**
 * 1) peek in-memory cache (สด ≤ 5 นาที จาก cron/background) → คืนทันที (0ms)
 * 2) D1 snapshot (เร็ว ~10ms) → คืนทันที + trigger background refresh จาก upstream
 * 3) D1 ว่างด้วย → trigger background refresh แล้วคืนลิสต์ว่าง (source: "collecting")
 *    endpoint จะตอบ 503 ให้ frontend ลองใหม่ — upstream จะถูกดึงเบื้องหลังเท่านั้น
 */

async function getWaterLevelsResilient(c: any): Promise<{ list: WaterLevelRecord[]; source: string }> {
  // 1) peek in-memory cache — ไม่ trigger fetch ไม่มีการรอ upstream
  const cached = thaiWaterService.peekWaterLevel();
  if (cached && cached.length > 0) return { list: cached, source: "thaiwater-cache" };

  // 2) D1 snapshot + background refresh (upstream จะถูกดึงเบื้องหลังและ sync ลง D1)
  if (c.env?.DB) {
    const d1List = await queryWaterLevelSnapshotFromD1(c.env.DB);
    if (d1List && d1List.length > 0) {
      triggerWaterBackgroundRefresh(c);
      return { list: d1List, source: "d1-fallback" };
    }
  }

  // 3) ฐานข้อมูลยังว่าง (เช่นระบบเพิ่งเริ่มต้น) → เก็บข้อมูลเบื้องหลัง ไม่บล็อก request
  triggerWaterBackgroundRefresh(c);
  return { list: [], source: "collecting" };
}

/** ดึงข้อมูลน้ำฝนแบบ Resilient (โครงสร้างเดียวกับ getWaterLevelsResilient) */
async function getRainfallsResilient(c: any): Promise<{ list: RainfallRecord[]; source: string }> {
  // 1) peek in-memory cache — ไม่ trigger fetch ไม่มีการรอ upstream
  const cached = thaiWaterService.peekRainfall();
  if (cached && cached.length > 0) return { list: cached, source: "thaiwater-cache" };

  // 2) D1 snapshot + background refresh
  if (c.env?.DB) {
    const d1List = await queryRainfallSnapshotFromD1(c.env.DB);
    if (d1List && d1List.length > 0) {
      triggerRainBackgroundRefresh(c);
      return { list: d1List, source: "d1-fallback" };
    }
  }

  // 3) ฐานข้อมูลยังว่าง → เก็บข้อมูลเบื้องหลัง ไม่บล็อก request
  triggerRainBackgroundRefresh(c);
  return { list: [], source: "collecting" };
}

/** Response กรณีฐานข้อมูลยังว่าง (ระบบเพิ่งเริ่มต้น) — frontend จะลองใหม่เองอัตโนมัติ */
function collectingResponse(c: any) {
  return c.json(
    {
      success: false,
      source: "collecting",
      message: "กำลังรวบรวมข้อมูลครั้งแรกเข้าฐานข้อมูล ลองใหม่ในอีกสักครู่",
    },
    503
  );
}

app.get("/api/water-levels", async (c) => {
  try {
    const { list: rawList, source } = await getWaterLevelsResilient(c);
    if (source === "collecting") return collectingResponse(c);

    let list = filterByAmphoe(rawList, c.req.query("amphoe"));
    list = filterWaterByStatus(list, c.req.query("status"));
    list = filterBySearch(list, c.req.query("search"));

    const total = list.length;
    list = applyLimit(list, c.req.query("limit"));

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    c.header("X-Data-Source", source === "d1-fallback" ? "Cloudflare-D1-Fallback" : "ThaiWater-API");
    return c.json({ success: true, source, count: list.length, total, data: list });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 3. API: รายการน้ำฝน Snapshot จ.อุบลราชธานี (กรองสถานีซ้ำออก)
 *    Data Flow: D1-first + Background Refresh (เหมือน /api/water-levels)
 */
app.get("/api/rainfall", async (c) => {
  try {
    const [{ list: rawWater, source }, { list: rawRain, source: rainSource }] = await Promise.all([
      getWaterLevelsResilient(c),
      getRainfallsResilient(c),
    ]);
    if (source === "collecting" || rainSource === "collecting") return collectingResponse(c);

    const waterIds = new Set(rawWater.map((w) => w.station.id));
    let list = filterOutWaterStations(rawRain, waterIds);
    list = filterByAmphoe(list, c.req.query("amphoe"));

    const minRain = c.req.query("minRain");
    if (minRain && !isNaN(Number(minRain))) {
      const threshold = Number(minRain);
      list = list.filter((item) => (item.rain24h ?? 0) >= threshold);
    }

    list = filterBySearch(list, c.req.query("search"));

    const total = list.length;
    list = applyLimit(list, c.req.query("limit"));

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    c.header("X-Data-Source", rainSource === "d1-fallback" ? "Cloudflare-D1-Fallback" : "ThaiWater-API");
    return c.json({ success: true, source: rainSource, count: list.length, total, data: list });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 4. API: รวมข้อมูลระดับน้ำและน้ำฝนสำหรับแสดงหมุดแผนที่ (Combined Snapshot)
 *    Data Flow: D1-first + Background Refresh
 */
app.get("/api/map-points", async (c) => {
  try {
    const [{ list: waterLevels, source }, { list: rainfalls, source: rainSource }] = await Promise.all([
      getWaterLevelsResilient(c),
      getRainfallsResilient(c),
    ]);
    if (source === "collecting" || rainSource === "collecting") return collectingResponse(c);

    const rainById = new Map(rainfalls.map((r) => [r.station.id, r]));
    const list = waterLevels.map((wl) => {
      const rf = rainById.get(wl.station.id);
      return {
        stationId: wl.station.id,
        nameTh: wl.station.nameTh,
        nameEn: wl.station.nameEn,
        lat: wl.station.lat,
        lon: wl.station.lon,
        provinceCode: wl.station.provinceCode,
        provinceNameTh: wl.station.provinceNameTh,
        amphoeNameTh: wl.station.amphoeNameTh,
        basinNameTh: wl.station.basinNameTh,
        waterlevelMsl: wl.waterlevelMsl,
        waterlevelLocalM: wl.waterlevelLocalM,
        minBankMsl: wl.minBankMsl,
        freeboardM: wl.freeboardM,
        situationLevel: wl.situationLevel,
        storagePercent: wl.storagePercent,
        waterObservedAt: wl.observedAt,
        rain24h: rf?.rain24h ?? null,
        rain1h: rf?.rain1h ?? null,
        rainObservedAt: rf?.observedAt ?? null,
      };
    });

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    return c.json({ success: true, count: list.length, data: list });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 5. API: รายชื่ออำเภอทั้งหมดใน จ.อุบลราชธานี
 */
app.get("/api/amphoes", async (c) => {
  try {
    const [{ list: waterLevels, source }, { list: rainfalls, source: rainSource }] = await Promise.all([
      getWaterLevelsResilient(c),
      getRainfallsResilient(c),
    ]);
    if (source === "collecting" || rainSource === "collecting") return collectingResponse(c);

    const amphoeSet = new Set<string>();
    for (const w of waterLevels) {
      if (w.station.amphoeNameTh) amphoeSet.add(w.station.amphoeNameTh);
    }
    for (const r of rainfalls) {
      if (r.station.amphoeNameTh) amphoeSet.add(r.station.amphoeNameTh);
    }

    const amphoes = Array.from(amphoeSet).sort((a, b) => a.localeCompare(b, "th"));
    c.header("Cache-Control", CACHE_CONTROL_LONG);
    return c.json({ success: true, count: amphoes.length, data: amphoes });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 6. API: ดึง Time-series Graph ของสถานี (D1 Database First + Fallback Auto-Backfill)
 */
app.get("/api/water-levels/graph", async (c) => {
  try {
    const station_id = c.req.query("station_id");
    const start_date = c.req.query("start_date");
    const end_date = c.req.query("end_date");

    if (!station_id || !start_date || !end_date) {
      return c.json({
        success: false,
        message: "Missing required query parameters: station_id, start_date, end_date",
      }, 400);
    }

    const stationIdNum = Number(station_id);
    const startIso = toIso(start_date) || `${start_date}T00:00:00.000Z`;
    const endIso = toIso(end_date) || `${end_date}T23:59:59.999Z`;

    // 1. ตรวจสอบใน Cloudflare D1 Database ก่อน (ถ้ามี Binding)
    if (c.env?.DB) {
      try {
        const d1Result = await queryWaterLevelHistory(c.env.DB, stationIdNum, startIso, endIso);
        if (d1Result && d1Result.points.length > 0) {
          c.header("Cache-Control", CACHE_CONTROL_SHORT);
          c.header("X-Data-Source", "Cloudflare-D1");
          return c.json({ success: true, source: "d1", data: d1Result });
        }
      } catch (d1Err) {
        console.warn("[D1 Query Warning]:", d1Err);
      }
    }

    // 2. ฐานข้อมูลยังไม่มีข้อมูลช่วงวันที่นี้ → ตอบกราฟว่างทันที แล้วไปดึงจาก ThaiWater API
    //    เพื่อเก็บลง D1 เบื้องหลัง (Auto-Backfill) — ไม่มีการรอ upstream บน request path เด็ดขาด
    if (c.executionCtx) {
      const backfillJob = (async () => {
        const result = await thaiWaterService.getWaterLevelGraph({
          stationId: String(station_id),
          startDate: String(start_date),
          endDate: String(end_date),
        }, true);
        if (c.env?.DB && result.points && result.points.length > 0) {
          await upsertWaterLevelGraphPoints(c.env.DB, stationIdNum, result.points, {
            minBankMsl: result.minBankMsl,
            warningLevelMsl: result.warningLevelMsl,
            criticalLevelMsl: result.criticalLevelMsl,
            groundLevelMsl: result.groundLevelMsl,
          });
        }
        console.log(`[BG Graph Backfill] station ${station_id} ${start_date}..${end_date}: ${result.points?.length ?? 0} points`);
      })().catch((err) => console.error("[BG Graph Backfill] failed:", err?.message));

      c.executionCtx.waitUntil(backfillJob);
    }

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    c.header("X-Data-Source", "Cloudflare-D1-Collecting");
    return c.json({
      success: true,
      source: "d1-collecting",
      data: {
        stationId: stationIdNum,
        startDate: startIso,
        endDate: endIso,
        minBankMsl: null,
        warningLevelMsl: null,
        criticalLevelMsl: null,
        groundLevelMsl: null,
        points: [],
      },
    });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 7. API: Sync Snapshot ปัจจุบันลง Cloudflare D1 ทันที
 */
app.post("/api/admin/sync-d1", async (c) => {
  try {
    if (!c.env?.DB) {
      return c.json({ success: false, message: "D1 database binding (DB) is not available" }, 400);
    }

    const [waterLevels, rainfalls] = await Promise.all([
      thaiWaterService.getWaterLevel(true),
      thaiWaterService.getRainfall(true),
    ]);

    const syncResult = await syncSnapshotToD1(c.env.DB, waterLevels, rainfalls);

    return c.json({
      success: true,
      message: "Synced snapshot to D1 database successfully",
      data: syncResult,
    });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 8. API: Backfill ประวัติกราฟย้อนหลังลง D1 สำหรับทุกสถานี
 */
app.post("/api/admin/backfill-graphs", async (c) => {
  try {
    if (!c.env?.DB) {
      return c.json({ success: false, message: "D1 database binding (DB) is not available" }, 400);
    }

    // รองรับ 2 โหมด: ระบุ start_date/end_date ตรง ๆ (สำหรับ backfill ย้อนหลังหลายปี)
    // หรือใช้ days (default 7 วัน, cap 30 วัน) สำหรับ backfill ล่าสุด
    const pad = (n: number) => String(n).padStart(2, "0");
    let startDate: string;
    let endDate: string;

    const startDateParam = c.req.query("start_date");
    const endDateParam = c.req.query("end_date");

    if (startDateParam && endDateParam) {
      startDate = startDateParam.trim();
      endDate = endDateParam.trim();
    } else {
      const daysStr = c.req.query("days") || "7";
      const days = Math.min(Math.max(parseInt(daysStr, 10) || 7, 1), 30);
      const today = new Date();
      const startObj = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
      startDate = `${startObj.getFullYear()}-${pad(startObj.getMonth() + 1)}-${pad(startObj.getDate())}`;
      endDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} ${pad(today.getHours())}:${pad(today.getMinutes())}`;
    }

    const waterLevels = await thaiWaterService.getWaterLevel();
    const db = c.env.DB;

    let totalPointsSaved = 0;
    const errors: { stationId: number; error: string }[] = [];

    for (const item of waterLevels) {
      try {
        const graphResult = await thaiWaterService.getWaterLevelGraph({
          stationId: item.station.id,
          startDate,
          endDate,
        });

        if (graphResult.points && graphResult.points.length > 0) {
          const saved = await upsertWaterLevelGraphPoints(db, item.station.id, graphResult.points, {
            minBankMsl: graphResult.minBankMsl ?? item.minBankMsl,
            warningLevelMsl: graphResult.warningLevelMsl,
            criticalLevelMsl: graphResult.criticalLevelMsl,
            groundLevelMsl: graphResult.groundLevelMsl,
          });
          totalPointsSaved += saved;
        }
      } catch (err: any) {
        errors.push({ stationId: item.station.id, error: err.message });
      }
    }

    return c.json({
      success: true,
      message: `Backfilled graph points for ${waterLevels.length} stations (${startDate} → ${endDate})`,
      totalStations: waterLevels.length,
      totalPointsSaved,
      errorsCount: errors.length,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 9. API: บังคับ Refresh ข้อมูลในแคช
 */
app.post("/api/refresh", async (c) => {
  try {
    const refreshed = await thaiWaterService.refreshAll();

    if (c.env?.DB) {
      syncSnapshotToD1(c.env.DB, refreshed.waterLevels, refreshed.rainfalls).catch((err) =>
        console.error("[Refresh D1 Sync Error]:", err)
      );
    }

    return c.json({
      success: true,
      message: "Cache refreshed successfully",
      waterLevelsCount: refreshed.waterLevels.length,
      rainfallsCount: refreshed.rainfalls.length,
      status: thaiWaterService.getCacheStatus(),
    });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * API: Map tile API key (อ่านจาก Worker secret — ห้าม hardcode ในฝั่ง client)
 */
app.get("/api/map-key", (c) => {
  return c.json({ key: c.env?.STADIA_API_KEY ?? null });
});

/**
 * 10. API: Health Check
 */
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    runtime: "Cloudflare Workers",
    d1Available: Boolean(c.env?.DB),
    time: new Date().toISOString(),
  });
});

/**
 * 11. Embed Widget: Standalone 2D Cross-Section สำหรับนำไปฝัง iframe บนเว็บอื่น
 */
app.get("/embed/cross-section", (c) => {
  const url = new URL(c.req.url);
  return c.redirect(`/embed-cross-section.html${url.search}`, 302);
});

export default {
  fetch: app.fetch,

  /**
   * Cron Trigger: ดึงข้อมูลสดจาก ThaiWater อัตโนมัติทุก 5 นาที และบันทึกลง D1
   */
  async scheduled(event: any, env: Bindings, ctx: any) {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await thaiWaterService.refreshAll();
          console.log(`[Cron] Auto-refreshed ThaiWater data: ${result.waterLevels.length} water, ${result.rainfalls.length} rain`);

          if (env?.DB) {
            const syncRes = await syncSnapshotToD1(env.DB, result.waterLevels, result.rainfalls);
            console.log(`[Cron] Synced to D1: ${syncRes.stationsCount} stations, ${syncRes.waterCount} water records, ${syncRes.rainCount} rain records`);
          }
        } catch (err) {
          console.error("[Cron] Auto-refresh / D1 sync failed:", err);
        }
      })()
    );
  },
};
