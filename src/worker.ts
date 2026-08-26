import { Hono } from "hono";
import { cors } from "hono/cors";
import { ThaiWaterService } from "./cache-service.js";
import {
  D1Database,
  syncSnapshotToD1,
  queryWaterLevelHistory,
  upsertWaterLevelGraphPoints,
} from "./db.js";
import { toIso } from "./thaiwater.js";
import { WaterLevelRecord, RainfallRecord } from "./types.js";

type Bindings = {
  DB?: D1Database;
};

// สร้าง Service สำหรับจัดการแคชใน Worker isolate
const thaiWaterService = new ThaiWaterService({
  ttlMs: 5 * 60 * 1000, // 5 นาที
  autoStartPolling: false, // บน Workers ใช้ Cron Triggers แทน setInterval
});

const app = new Hono<{ Bindings: Bindings }>();

// เปิดใช้งาน CORS สำหรับทุก request
app.use("/*", cors());

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
    let [waterLevels, rawRainfalls] = await Promise.all([
      thaiWaterService.getWaterLevel(),
      thaiWaterService.getRainfall(),
    ]);

    const waterIds = new Set(waterLevels.map((w) => w.station.id));
    let rainfalls = filterOutWaterStations(rawRainfalls, waterIds);

    waterLevels = filterByAmphoe(waterLevels, amphoe);
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
 */
app.get("/api/water-levels", async (c) => {
  try {
    let list = await thaiWaterService.getWaterLevel();
    list = filterByAmphoe(list, c.req.query("amphoe"));
    list = filterWaterByStatus(list, c.req.query("status"));
    list = filterBySearch(list, c.req.query("search"));

    const total = list.length;
    list = applyLimit(list, c.req.query("limit"));

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    return c.json({ success: true, count: list.length, total, data: list });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 3. API: รายการน้ำฝน Snapshot จ.อุบลราชธานี (กรองสถานีซ้ำออก)
 */
app.get("/api/rainfall", async (c) => {
  try {
    const [waterLevels, allRain] = await Promise.all([
      thaiWaterService.getWaterLevel(),
      thaiWaterService.getRainfall(),
    ]);

    const waterIds = new Set(waterLevels.map((w) => w.station.id));
    let list = filterOutWaterStations(allRain, waterIds);
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
    return c.json({ success: true, count: list.length, total, data: list });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 4. API: รวมข้อมูลระดับน้ำและน้ำฝนสำหรับแสดงหมุดแผนที่ (Combined Snapshot)
 */
app.get("/api/map-points", async (c) => {
  try {
    const map = await thaiWaterService.getCombinedSnapshot();
    const list = Array.from(map.values()).map((entry) => {
      const st = entry.waterLevel?.station ?? entry.rainfall?.station;
      if (!st) return null;
      return {
        stationId: entry.stationId,
        nameTh: st.nameTh,
        nameEn: st.nameEn,
        lat: st.lat,
        lon: st.lon,
        provinceCode: st.provinceCode,
        provinceNameTh: st.provinceNameTh,
        amphoeNameTh: st.amphoeNameTh,
        basinNameTh: st.basinNameTh,
        waterlevelMsl: entry.waterLevel?.waterlevelMsl ?? null,
        waterlevelLocalM: entry.waterLevel?.waterlevelLocalM ?? null,
        minBankMsl: entry.waterLevel?.minBankMsl ?? null,
        freeboardM: entry.waterLevel?.freeboardM ?? null,
        situationLevel: entry.waterLevel?.situationLevel ?? null,
        storagePercent: entry.waterLevel?.storagePercent ?? null,
        waterObservedAt: entry.waterLevel?.observedAt ?? null,
        rain24h: entry.rainfall?.rain24h ?? null,
        rain1h: entry.rainfall?.rain1h ?? null,
        rainObservedAt: entry.rainfall?.observedAt ?? null,
      };
    }).filter(Boolean);

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
    const [waterLevels, rawRainfalls] = await Promise.all([
      thaiWaterService.getWaterLevel(),
      thaiWaterService.getRainfall(),
    ]);

    const waterIds = new Set(waterLevels.map((w) => w.station.id));
    const rainfalls = filterOutWaterStations(rawRainfalls, waterIds);

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

    // 2. Fallback ไปดึงสดจาก ThaiWater API
    const result = await thaiWaterService.getWaterLevelGraph({
      stationId: String(station_id),
      startDate: String(start_date),
      endDate: String(end_date),
    });

    // 3. บันทึกข้อมูลที่เพิ่งดึงได้ลง D1 ใน Background (Auto-Backfill)
    if (c.env?.DB && result.points && result.points.length > 0) {
      const db = c.env.DB;
      const savePromise = upsertWaterLevelGraphPoints(db, stationIdNum, result.points, {
        minBankMsl: result.minBankMsl,
        warningLevelMsl: result.warningLevelMsl,
        criticalLevelMsl: result.criticalLevelMsl,
        groundLevelMsl: result.groundLevelMsl,
      }).catch((err) => console.error("[D1 Auto-Save Error]:", err));

      if (c.executionCtx) {
        c.executionCtx.waitUntil(savePromise);
      }
    }

    c.header("Cache-Control", CACHE_CONTROL_SHORT);
    c.header("X-Data-Source", "ThaiWater-API");
    return c.json({ success: true, source: "thaiwater-api", data: result });
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

    const daysStr = c.req.query("days") || "7";
    const days = Math.min(Math.max(parseInt(daysStr, 10) || 7, 1), 30);

    const waterLevels = await thaiWaterService.getWaterLevel();
    const db = c.env.DB;

    const pad = (n: number) => String(n).padStart(2, "0");
    const today = new Date();
    const startObj = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
    const startDate = `${startObj.getFullYear()}-${pad(startObj.getMonth() + 1)}-${pad(startObj.getDate())}`;
    const endDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} ${pad(today.getHours())}:${pad(today.getMinutes())}`;

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
      message: `Backfilled graph points for ${waterLevels.length} stations over ${days} days`,
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
