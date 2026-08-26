import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ThaiWaterService } from "./cache-service.js";
import { WaterLevelRecord, RainfallRecord } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// สร้าง Service พร้อม Auto Polling ทุก 5 นาที
const thaiWaterService = new ThaiWaterService({
  ttlMs: 5 * 60 * 1000,
  pollIntervalMs: 5 * 60 * 1000,
  autoStartPolling: true,
});

// Serve static dashboard files
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

// ----- Filter Helpers -----

function filterOutWaterStations(rainfalls: RainfallRecord[], waterIds: Set<number>): RainfallRecord[] {
  return rainfalls.filter((r) => !waterIds.has(r.station.id));
}

function filterByAmphoe<T extends { station: { amphoeNameTh?: string | null } }>(
  list: T[],
  amphoe: unknown
): T[] {
  if (typeof amphoe !== "string" || !amphoe.trim()) return list;
  const name = amphoe.trim();
  return list.filter((item) => item.station.amphoeNameTh === name);
}

function filterBySearch<T extends { station: { nameTh?: string | null; nameEn?: string | null; amphoeNameTh?: string | null; basinNameTh?: string | null; id: number } }>(
  list: T[],
  search: unknown
): T[] {
  if (typeof search !== "string" || !search.trim()) return list;
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

function filterWaterByStatus(
  list: WaterLevelRecord[],
  status: unknown
): WaterLevelRecord[] {
  if (typeof status !== "string" || !status.trim()) return list;
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

function applyLimit<T>(list: T[], limit: unknown): T[] {
  const n = Number(limit);
  return n > 0 ? list.slice(0, n) : list;
}

/**
 * 1. API: สรุปภาพรวมและสถิติสำคัญ จ.อุบลราชธานี (KPIs / Summary)
 */
app.get("/api/summary", async (req, res) => {
  try {
    let [waterLevels, rawRainfalls] = await Promise.all([
      thaiWaterService.getWaterLevel(),
      thaiWaterService.getRainfall(),
    ]);

    const waterIds = new Set(waterLevels.map((w) => w.station.id));
    let rainfalls = filterOutWaterStations(rawRainfalls, waterIds);

    waterLevels = filterByAmphoe(waterLevels, req.query.amphoe);
    rainfalls = filterByAmphoe(rainfalls, req.query.amphoe);

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

    res.json({
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
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 2. API: รายการระดับน้ำ Snapshot จ.อุบลราชธานี
 */
app.get("/api/water-levels", async (req, res) => {
  try {
    let list = await thaiWaterService.getWaterLevel();
    list = filterByAmphoe(list, req.query.amphoe);
    list = filterWaterByStatus(list, req.query.status);
    list = filterBySearch(list, req.query.search);

    const total = list.length;
    list = applyLimit(list, req.query.limit);

    res.json({ success: true, count: list.length, total, data: list });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 3. API: รายการน้ำฝน Snapshot จ.อุบลราชธานี
 */
app.get("/api/rainfall", async (req, res) => {
  try {
    const [waterLevels, allRain] = await Promise.all([
      thaiWaterService.getWaterLevel(),
      thaiWaterService.getRainfall(),
    ]);

    const waterStationIds = new Set(waterLevels.map((w) => w.station.id));
    let list = filterOutWaterStations(allRain, waterStationIds);
    list = filterByAmphoe(list, req.query.amphoe);

    const minRain = req.query.minRain;
    if (minRain && !isNaN(Number(minRain))) {
      const threshold = Number(minRain);
      list = list.filter((item) => (item.rain24h ?? 0) >= threshold);
    }

    list = filterBySearch(list, req.query.search);

    const total = list.length;
    list = applyLimit(list, req.query.limit);

    res.json({ success: true, count: list.length, total, data: list });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 4. API: รวมข้อมูลระดับน้ำและน้ำฝนสำหรับแสดงหมุดแผนที่ (Combined Snapshot)
 */
app.get("/api/map-points", async (req, res) => {
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

    res.json({ success: true, count: list.length, data: list });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 5. API: รายชื่ออำเภอทั้งหมดใน จ.อุบลราชธานี
 */
app.get("/api/amphoes", async (req, res) => {
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
    res.json({ success: true, count: amphoes.length, data: amphoes });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 6. API: ดึง Time-series Graph ของสถานี
 */
app.get("/api/water-levels/graph", async (req, res) => {
  try {
    const { station_id, start_date, end_date } = req.query;
    if (!station_id || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: "Missing required query parameters: station_id, start_date, end_date",
      });
    }

    const result = await thaiWaterService.getWaterLevelGraph({
      stationId: String(station_id),
      startDate: String(start_date),
      endDate: String(end_date),
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 7. API: บังคับ Refresh ข้อมูลในแคช
 */
app.post("/api/refresh", async (req, res) => {
  try {
    const refreshed = await thaiWaterService.refreshAll();
    res.json({
      success: true,
      message: "Cache refreshed successfully",
      waterLevelsCount: refreshed.waterLevels.length,
      rainfallsCount: refreshed.rainfalls.length,
      status: thaiWaterService.getCacheStatus(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🌊 ThaiWater Dashboard Server running on http://localhost:${PORT}`);
});
