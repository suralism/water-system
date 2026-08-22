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

    // กรองสถานีน้ำฝนที่ซ้ำกับ water-level ออก
    const waterIds = new Set(waterLevels.map((w) => w.station.id));
    let rainfalls = rawRainfalls.filter((r) => !waterIds.has(r.station.id));

    if (amphoe && amphoe.trim()) {
      const aName = amphoe.trim();
      waterLevels = waterLevels.filter((item) => item.station.amphoeNameTh === aName);
      rainfalls = rainfalls.filter((item) => item.station.amphoeNameTh === aName);
    }

    // คำนวณสถิติระดับน้ำ
    let overflowCount = 0;
    let warningCount = 0;
    const overflowingStations = [];

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

    // เรียงสถานีล้นตลิ่งมากที่สุด (freeboardM ติดลบมากที่สุด)
    overflowingStations.sort(
      (a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0)
    );

    // เรียงสถานีฝนตกหนักสุด 24 ชม.
    const sortedRain = [...rainfalls]
      .filter((r) => r.rain24h !== null && r.rain24h > 0)
      .sort((a, b) => (b.rain24h ?? 0) - (a.rain24h ?? 0));

    const cacheStatus = thaiWaterService.getCacheStatus();

    c.header("Cache-Control", "public, s-maxage=300, max-age=60");
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
        cacheStatus,
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
    const amphoe = c.req.query("amphoe");
    const search = c.req.query("search");
    const status = c.req.query("status");
    const limit = c.req.query("limit");

    let list = await thaiWaterService.getWaterLevel();

    if (amphoe && amphoe.trim()) {
      const aName = amphoe.trim();
      list = list.filter((item) => item.station.amphoeNameTh === aName);
    }

    if (status) {
      if (status === "overflow") {
        list = list.filter((item) => item.freeboardM !== null && item.freeboardM < 0);
      } else if (status === "warning") {
        list = list.filter(
          (item) =>
            (item.freeboardM !== null && item.freeboardM >= 0 && item.freeboardM <= 0.5) ||
            (item.situationLevel !== null && item.situationLevel >= 4)
        );
      } else if (status === "normal") {
        list = list.filter(
          (item) =>
            (item.freeboardM === null || item.freeboardM > 0.5) &&
            (item.situationLevel === null || item.situationLevel < 4)
        );
      }
    }

    if (search) {
      const query = search.trim().toLowerCase();
      list = list.filter(
        (item) =>
          item.station.nameTh?.toLowerCase().includes(query) ||
          item.station.nameEn?.toLowerCase().includes(query) ||
          item.station.amphoeNameTh?.toLowerCase().includes(query) ||
          item.station.basinNameTh?.toLowerCase().includes(query) ||
          String(item.station.id).includes(query)
      );
    }

    const total = list.length;
    if (limit && Number(limit) > 0) {
      list = list.slice(0, Number(limit));
    }

    c.header("Cache-Control", "public, s-maxage=300, max-age=60");
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
    const amphoe = c.req.query("amphoe");
    const search = c.req.query("search");
    const minRain = c.req.query("minRain");
    const limit = c.req.query("limit");

    const [waterLevels, allRain] = await Promise.all([
      thaiWaterService.getWaterLevel(),
      thaiWaterService.getRainfall(),
    ]);

    const waterStationIds = new Set(waterLevels.map((w) => w.station.id));
    let list = allRain.filter((item) => !waterStationIds.has(item.station.id));

    if (amphoe && amphoe.trim()) {
      const aName = amphoe.trim();
      list = list.filter((item) => item.station.amphoeNameTh === aName);
    }

    if (minRain && !isNaN(Number(minRain))) {
      const threshold = Number(minRain);
      list = list.filter((item) => (item.rain24h ?? 0) >= threshold);
    }

    if (search) {
      const query = search.trim().toLowerCase();
      list = list.filter(
        (item) =>
          item.station.nameTh?.toLowerCase().includes(query) ||
          item.station.nameEn?.toLowerCase().includes(query) ||
          item.station.amphoeNameTh?.toLowerCase().includes(query) ||
          item.station.basinNameTh?.toLowerCase().includes(query) ||
          String(item.station.id).includes(query)
      );
    }

    const total = list.length;
    if (limit && Number(limit) > 0) {
      list = list.slice(0, Number(limit));
    }

    c.header("Cache-Control", "public, s-maxage=300, max-age=60");
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
      const st = entry.waterLevel?.station ?? entry.rainfall?.station!;
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
    });

    c.header("Cache-Control", "public, s-maxage=300, max-age=60");
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
    const rainfalls = rawRainfalls.filter((r) => !waterIds.has(r.station.id));

    const amphoeSet = new Set<string>();
    for (const w of waterLevels) {
      if (w.station.amphoeNameTh) amphoeSet.add(w.station.amphoeNameTh);
    }
    for (const r of rainfalls) {
      if (r.station.amphoeNameTh) amphoeSet.add(r.station.amphoeNameTh);
    }

    const amphoes = Array.from(amphoeSet).sort((a, b) => a.localeCompare(b, "th"));
    c.header("Cache-Control", "public, s-maxage=3600, max-age=300");
    return c.json({ success: true, count: amphoes.length, data: amphoes });
  } catch (error: any) {
    return c.json({ success: false, message: error.message }, 500);
  }
});

/**
 * 6. API: ดึง Time-series Graph ของสถานี (รองรับ D1 Database First + Fallback Auto-Backfill)
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
          c.header("Cache-Control", "public, s-maxage=300, max-age=60");
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

    c.header("Cache-Control", "public, s-maxage=300, max-age=60");
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
 * 8. API: Backfill ประวัติกราฟย้อนหลังลง D1 สำหรับทุกสถานีในอุบลราชธานี
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

    // ดึงทีละสถานีพร้อมบันทึกลง D1
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

    // บันทึกลง D1 ด้วยหากมี binding
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
