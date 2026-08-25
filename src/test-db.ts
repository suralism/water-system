import {
  upsertStations,
  upsertWaterLevelRecords,
  upsertRainfallRecords,
  upsertWaterLevelGraphPoints,
  queryWaterLevelHistory,
  syncSnapshotToD1,
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "./db.js";
import { WaterLevelRecord, RainfallRecord, WaterLevelGraphPoint } from "./types.js";

/**
 * In-Memory Mock D1 Database สำหรับ Unit Testing โดยไม่ต้องต่อ Cloudflare
 */
class MockD1Database implements D1Database {
  public tables: {
    stations: Map<number, any>;
    water_level_history: Map<string, any>;
    rainfall_history: Map<string, any>;
  } = {
    stations: new Map(),
    water_level_history: new Map(),
    rainfall_history: new Map(),
  };

  prepare(query: string): D1PreparedStatement {
    const self = this;
    let boundValues: unknown[] = [];

    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        boundValues = values;
        return stmt;
      },
      async run<T = unknown>(): Promise<D1Result<T>> {
        self.executeSql(query, boundValues);
        return { success: true };
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const results = self.executeSelect(query, boundValues);
        return { success: true, results: results as T[] };
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const results = self.executeSelect(query, boundValues);
        if (results.length === 0) return null;
        if (colName) return (results[0] as any)[colName] ?? null;
        return results[0] as T;
      },
    };
    return stmt;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run<T>());
    }
    return results;
  }

  private executeSql(query: string, values: unknown[]) {
    const q = query.trim().toUpperCase();
    if (q.startsWith("INSERT INTO STATIONS")) {
      const [
        id, oldcode, name_th, name_en, lat, lon,
        province_code, province_name_th, amphoe_name_th, tumbon_name_th,
        basin_name_th, agency_name_th,
        min_bank_msl, warning_level_msl, critical_level_msl, ground_level_msl,
        updated_at,
      ] = values;
      const existing = this.tables.stations.get(Number(id)) || {};
      this.tables.stations.set(Number(id), {
        ...existing,
        id: Number(id),
        oldcode,
        name_th,
        name_en,
        lat,
        lon,
        province_code,
        province_name_th,
        amphoe_name_th,
        tumbon_name_th,
        basin_name_th,
        agency_name_th,
        min_bank_msl: min_bank_msl ?? existing.min_bank_msl ?? null,
        warning_level_msl: warning_level_msl ?? existing.warning_level_msl ?? null,
        critical_level_msl: critical_level_msl ?? existing.critical_level_msl ?? null,
        ground_level_msl: ground_level_msl ?? existing.ground_level_msl ?? null,
        updated_at,
      });
    } else if (q.startsWith("INSERT INTO WATER_LEVEL_HISTORY")) {
      const [
        station_id, observed_at, waterlevel_msl, waterlevel_local_m,
        freeboard_m, situation_level, storage_percent, discharge, created_at,
      ] = values;
      const key = `${station_id}_${observed_at}`;
      const existing = this.tables.water_level_history.get(key) || {};
      this.tables.water_level_history.set(key, {
        ...existing,
        station_id: Number(station_id),
        observed_at: String(observed_at),
        waterlevel_msl,
        waterlevel_local_m,
        freeboard_m: freeboard_m ?? existing.freeboard_m ?? null,
        situation_level: situation_level ?? existing.situation_level ?? null,
        storage_percent: storage_percent ?? existing.storage_percent ?? null,
        discharge: discharge ?? existing.discharge ?? null,
        created_at,
      });
    } else if (q.startsWith("INSERT INTO RAINFALL_HISTORY")) {
      const [station_id, observed_at, rain24h, rain1h, created_at] = values;
      const key = `${station_id}_${observed_at}`;
      this.tables.rainfall_history.set(key, {
        station_id: Number(station_id),
        observed_at: String(observed_at),
        rain24h,
        rain1h,
        created_at,
      });
    } else if (q.startsWith("UPDATE STATIONS SET")) {
      const [min_bank_msl, warning_level_msl, critical_level_msl, ground_level_msl, updated_at, stationId] = values;
      const existing = this.tables.stations.get(Number(stationId));
      if (existing) {
        if (min_bank_msl != null) existing.min_bank_msl = min_bank_msl;
        if (warning_level_msl != null) existing.warning_level_msl = warning_level_msl;
        if (critical_level_msl != null) existing.critical_level_msl = critical_level_msl;
        if (ground_level_msl != null) existing.ground_level_msl = ground_level_msl;
        existing.updated_at = updated_at;
      }
    }
  }

  private executeSelect(query: string, values: unknown[]): any[] {
    const q = query.trim().toUpperCase();
    if (q.includes("FROM STATIONS WHERE ID = ?")) {
      const stationId = Number(values[0]);
      const found = this.tables.stations.get(stationId);
      return found ? [found] : [];
    } else if (q.includes("FROM WATER_LEVEL_HISTORY")) {
      const [stationId, startIso, endIso] = values;
      const stId = Number(stationId);
      const results: any[] = [];
      for (const row of this.tables.water_level_history.values()) {
        if (
          row.station_id === stId &&
          row.observed_at >= String(startIso) &&
          row.observed_at <= String(endIso)
        ) {
          results.push(row);
        }
      }
      results.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
      return results;
    }
    return [];
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${msg}`);
  }
}

async function runTests() {
  console.log("=== 1. Testing D1 Station Upsert & Deduplication ===");
  const db = new MockD1Database();

  const stations = [
    {
      id: 512,
      oldcode: "M.7",
      nameTh: "สะพานเสรีประชาธิปไตย",
      nameEn: "Seri Democracy Bridge",
      lat: 15.228,
      lon: 104.859,
      provinceCode: "34",
      provinceNameTh: "อุบลราชธานี",
      amphoeNameTh: "เมืองอุบลราชธานี",
      minBankMsl: 112.0,
    },
    // Duplicate ID in the same batch
    {
      id: 512,
      oldcode: "M.7",
      nameTh: "สะพานเสรีประชาธิปไตย (อัปเดต)",
      nameEn: "Seri Democracy Bridge",
      lat: 15.228,
      lon: 104.859,
      provinceCode: "34",
      provinceNameTh: "อุบลราชธานี",
      amphoeNameTh: "เมืองอุบลราชธานี",
      minBankMsl: 112.0,
    },
    {
      id: 513,
      nameTh: "แก่งสะพือ",
      nameEn: "Kaeng Saphue",
      lat: 15.24,
      lon: 105.25,
      provinceCode: "34",
      provinceNameTh: "อุบลราชธานี",
      amphoeNameTh: "พิบูลมังสาหาร",
    },
  ];

  const count = await upsertStations(db, stations);
  assert(count === 2, `Expected 2 unique stations upserted, got ${count}`);
  assert(db.tables.stations.size === 2, `Expected 2 rows in stations table, got ${db.tables.stations.size}`);
  assert(db.tables.stations.get(512)?.name_th === "สะพานเสรีประชาธิปไตย (อัปเดต)", "Expected updated name for station 512");
  console.log("✔ Station upsert & batch deduplication tests passed.");

  console.log("\n=== 2. Testing Water Level History Upsert & Deduplication (Exact Time) ===");
  const observedTime = "2026-08-22T02:00:00.000Z";
  const records: WaterLevelRecord[] = [
    {
      station: { id: 512, lat: 15.228, lon: 104.859, nameTh: "สะพานเสรี", nameEn: "Seri", provinceCode: "34", provinceNameTh: "อุบลราชธานี", amphoeNameTh: "เมือง" },
      waterlevelMsl: 110.5,
      waterlevelLocalM: 5.5,
      minBankMsl: 112.0,
      freeboardM: 1.5,
      situationLevel: 1,
      storagePercent: 75.0,
      observedAt: observedTime,
    },
    // Duplicate insertion at exact same time with updated water level
    {
      station: { id: 512, lat: 15.228, lon: 104.859, nameTh: "สะพานเสรี", nameEn: "Seri", provinceCode: "34", provinceNameTh: "อุบลราชธานี", amphoeNameTh: "เมือง" },
      waterlevelMsl: 110.8, // updated value
      waterlevelLocalM: 5.8,
      minBankMsl: 112.0,
      freeboardM: 1.2,
      situationLevel: 2,
      storagePercent: 78.0,
      observedAt: observedTime,
    },
  ];

  await upsertWaterLevelRecords(db, records);
  // Re-run upsert with same data to simulate repeated cron runs
  await upsertWaterLevelRecords(db, records);

  assert(db.tables.water_level_history.size === 1, `Expected exactly 1 row in water_level_history, got ${db.tables.water_level_history.size}`);
  const savedRecord = db.tables.water_level_history.get(`512_${observedTime}`);
  assert(savedRecord?.waterlevel_msl === 110.8, `Expected updated waterlevel_msl 110.8, got ${savedRecord?.waterlevel_msl}`);
  console.log("✔ Water level history deduplication and idempotent upsert tests passed.");

  console.log("\n=== 3. Testing Rainfall History Upsert & Deduplication ===");
  const rainRecords: RainfallRecord[] = [
    {
      station: { id: 512, lat: 15.228, lon: 104.859, nameTh: "สะพานเสรี", nameEn: "Seri", provinceCode: "34", provinceNameTh: "อุบลราชธานี", amphoeNameTh: "เมือง" },
      rain24h: 35.0,
      rain1h: 5.0,
      observedAt: observedTime,
    },
    {
      station: { id: 512, lat: 15.228, lon: 104.859, nameTh: "สะพานเสรี", nameEn: "Seri", provinceCode: "34", provinceNameTh: "อุบลราชธานี", amphoeNameTh: "เมือง" },
      rain24h: 38.5,
      rain1h: 6.0,
      observedAt: observedTime,
    },
  ];

  await upsertRainfallRecords(db, rainRecords);
  await upsertRainfallRecords(db, rainRecords); // repeated

  assert(db.tables.rainfall_history.size === 1, `Expected 1 row in rainfall_history, got ${db.tables.rainfall_history.size}`);
  const savedRain = db.tables.rainfall_history.get(`512_${observedTime}`);
  assert(savedRain?.rain24h === 38.5, `Expected updated rain24h 38.5, got ${savedRain?.rain24h}`);
  console.log("✔ Rainfall history deduplication tests passed.");

  console.log("\n=== 4. Testing Time-Series Graph Upsert & Query ===");
  const graphPoints: WaterLevelGraphPoint[] = [
    { observedAt: "2026-08-20T00:00:00.000Z", waterlevelMsl: 108.0, waterlevelLocalM: 3.0, discharge: 150.0 },
    { observedAt: "2026-08-21T00:00:00.000Z", waterlevelMsl: 109.5, waterlevelLocalM: 4.5, discharge: 220.0 },
    { observedAt: "2026-08-22T00:00:00.000Z", waterlevelMsl: 111.0, waterlevelLocalM: 6.0, discharge: 310.0 },
  ];

  await upsertWaterLevelGraphPoints(db, 512, graphPoints, {
    minBankMsl: 112.0,
    warningLevelMsl: 111.5,
    criticalLevelMsl: 112.0,
  });

  const queryRes = await queryWaterLevelHistory(
    db,
    512,
    "2026-08-19T00:00:00.000Z",
    "2026-08-22T23:59:59.999Z"
  );

  assert(queryRes !== null, "Expected queryRes to not be null");
  assert(queryRes!.points.length === 4, `Expected 4 points (3 from graph + 1 from earlier snapshot), got ${queryRes!.points.length}`);
  assert(queryRes!.minBankMsl === 112.0, `Expected minBankMsl 112.0, got ${queryRes!.minBankMsl}`);
  assert(queryRes!.warningLevelMsl === 111.5, `Expected warningLevelMsl 111.5, got ${queryRes!.warningLevelMsl}`);
  console.log("✔ Graph upsert and query tests passed.");

  console.log("\n=== 5. Testing syncSnapshotToD1 Combined ===");
  const syncResult = await syncSnapshotToD1(db, records, rainRecords);
  assert(syncResult.stationsCount > 0, "Expected stations to be synced");
  console.log("✔ syncSnapshotToD1 passed.");

  console.log("\n🎉 ALL D1 DATABASE & DEDUPLICATION TESTS PASSED SUCCESSFULLY! 🚀");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
