import {
  StationRef,
  WaterLevelRecord,
  RainfallRecord,
  WaterLevelGraphResult,
  WaterLevelGraphPoint,
} from "./types.js";

/**
 * Interface สำหรับ Cloudflare D1 Database
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: any;
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

const BATCH_SIZE = 80;

/**
 * บันทึกหรืออัปเดตข้อมูลสถานี (Stations Upsert)
 */
export async function upsertStations(
  db: D1Database,
  stations: (StationRef & {
    minBankMsl?: number | null;
    warningLevelMsl?: number | null;
    criticalLevelMsl?: number | null;
    groundLevelMsl?: number | null;
  })[]
): Promise<number> {
  if (!stations || stations.length === 0) return 0;
  const now = new Date().toISOString();

  const query = `
    INSERT INTO stations (
      id, oldcode, name_th, name_en, lat, lon,
      province_code, province_name_th, amphoe_name_th, tumbon_name_th,
      basin_name_th, agency_name_th,
      min_bank_msl, warning_level_msl, critical_level_msl, ground_level_msl,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      oldcode = excluded.oldcode,
      name_th = excluded.name_th,
      name_en = excluded.name_en,
      lat = excluded.lat,
      lon = excluded.lon,
      province_code = excluded.province_code,
      province_name_th = excluded.province_name_th,
      amphoe_name_th = excluded.amphoe_name_th,
      tumbon_name_th = excluded.tumbon_name_th,
      basin_name_th = excluded.basin_name_th,
      agency_name_th = excluded.agency_name_th,
      min_bank_msl = COALESCE(excluded.min_bank_msl, stations.min_bank_msl),
      warning_level_msl = COALESCE(excluded.warning_level_msl, stations.warning_level_msl),
      critical_level_msl = COALESCE(excluded.critical_level_msl, stations.critical_level_msl),
      ground_level_msl = COALESCE(excluded.ground_level_msl, stations.ground_level_msl),
      updated_at = excluded.updated_at
  `;

  // ตัดซ้ำ id ในอาร์เรย์เดียวกันก่อนยิง batch
  const uniqueStationsMap = new Map<number, typeof stations[0]>();
  for (const st of stations) {
    uniqueStationsMap.set(st.id, st);
  }
  const uniqueStations = Array.from(uniqueStationsMap.values());

  const statements: D1PreparedStatement[] = uniqueStations.map((st) =>
    db.prepare(query).bind(
      st.id,
      st.oldcode ?? null,
      st.nameTh ?? null,
      st.nameEn ?? null,
      st.lat,
      st.lon,
      st.provinceCode ?? null,
      st.provinceNameTh ?? null,
      st.amphoeNameTh ?? null,
      st.tumbonNameTh ?? null,
      st.basinNameTh ?? null,
      st.agencyNameTh ?? null,
      st.minBankMsl ?? null,
      st.warningLevelMsl ?? null,
      st.criticalLevelMsl ?? null,
      st.groundLevelMsl ?? null,
      now
    )
  );

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    await db.batch(chunk);
  }

  return uniqueStations.length;
}

/**
 * บันทึก Snapshot ระดับน้ำลงตาราง `water_level_history` (Upsert ป้องกันซ้ำซ้อน)
 */
export async function upsertWaterLevelRecords(
  db: D1Database,
  records: WaterLevelRecord[]
): Promise<number> {
  const validRecords = records.filter((r) => r.observedAt && r.station?.id);
  if (validRecords.length === 0) return 0;
  const now = new Date().toISOString();

  // Deduplicate by (station_id, observed_at) within the incoming array
  const keyMap = new Map<string, WaterLevelRecord>();
  for (const r of validRecords) {
    keyMap.set(`${r.station.id}_${r.observedAt}`, r);
  }
  const uniqueRecords = Array.from(keyMap.values());

  const query = `
    INSERT INTO water_level_history (
      station_id, observed_at, waterlevel_msl, waterlevel_local_m,
      freeboard_m, situation_level, storage_percent, discharge, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id, observed_at) DO UPDATE SET
      waterlevel_msl = excluded.waterlevel_msl,
      waterlevel_local_m = excluded.waterlevel_local_m,
      freeboard_m = excluded.freeboard_m,
      situation_level = excluded.situation_level,
      storage_percent = excluded.storage_percent,
      discharge = excluded.discharge
  `;

  const statements: D1PreparedStatement[] = uniqueRecords.map((r) =>
    db.prepare(query).bind(
      r.station.id,
      r.observedAt,
      r.waterlevelMsl,
      r.waterlevelLocalM,
      r.freeboardM,
      r.situationLevel,
      r.storagePercent,
      null, // discharge ใน snapshot มักเป็น null
      now
    )
  );

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    await db.batch(chunk);
  }

  return uniqueRecords.length;
}

/**
 * บันทึก Snapshot น้ำฝนลงตาราง `rainfall_history` (Upsert ป้องกันซ้ำซ้อน)
 */
export async function upsertRainfallRecords(
  db: D1Database,
  records: RainfallRecord[]
): Promise<number> {
  const validRecords = records.filter((r) => r.observedAt && r.station?.id);
  if (validRecords.length === 0) return 0;
  const now = new Date().toISOString();

  // Deduplicate by (station_id, observed_at) within incoming array
  const keyMap = new Map<string, RainfallRecord>();
  for (const r of validRecords) {
    keyMap.set(`${r.station.id}_${r.observedAt}`, r);
  }
  const uniqueRecords = Array.from(keyMap.values());

  const query = `
    INSERT INTO rainfall_history (
      station_id, observed_at, rain24h, rain1h, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(station_id, observed_at) DO UPDATE SET
      rain24h = excluded.rain24h,
      rain1h = excluded.rain1h
  `;

  const statements: D1PreparedStatement[] = uniqueRecords.map((r) =>
    db.prepare(query).bind(
      r.station.id,
      r.observedAt,
      r.rain24h,
      r.rain1h,
      now
    )
  );

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    await db.batch(chunk);
  }

  return uniqueRecords.length;
}

/**
 * บันทึก Time-Series Graph Points ย้อนหลังลง D1 (Auto-Backfill & Deduplication)
 */
export async function upsertWaterLevelGraphPoints(
  db: D1Database,
  stationId: number,
  points: WaterLevelGraphPoint[],
  metadata?: {
    minBankMsl?: number | null;
    warningLevelMsl?: number | null;
    criticalLevelMsl?: number | null;
    groundLevelMsl?: number | null;
  }
): Promise<number> {
  if (!points || points.length === 0) return 0;

  // 1. อัปเดต metadata ของสถานีในตาราง stations หากมี
  if (metadata) {
    const updateStationQuery = `
      UPDATE stations SET
        min_bank_msl = COALESCE(?, min_bank_msl),
        warning_level_msl = COALESCE(?, warning_level_msl),
        critical_level_msl = COALESCE(?, critical_level_msl),
        ground_level_msl = COALESCE(?, ground_level_msl),
        updated_at = ?
      WHERE id = ?
    `;
    await db.prepare(updateStationQuery).bind(
      metadata.minBankMsl ?? null,
      metadata.warningLevelMsl ?? null,
      metadata.criticalLevelMsl ?? null,
      metadata.groundLevelMsl ?? null,
      new Date().toISOString(),
      stationId
    ).run();
  }

  // 2. Upsert graph points
  const validPoints = points.filter((p) => p.observedAt);
  const keyMap = new Map<string, WaterLevelGraphPoint>();
  for (const p of validPoints) {
    keyMap.set(`${stationId}_${p.observedAt}`, p);
  }
  const uniquePoints = Array.from(keyMap.values());
  const now = new Date().toISOString();

  const query = `
    INSERT INTO water_level_history (
      station_id, observed_at, waterlevel_msl, waterlevel_local_m,
      freeboard_m, situation_level, storage_percent, discharge, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id, observed_at) DO UPDATE SET
      waterlevel_msl = excluded.waterlevel_msl,
      waterlevel_local_m = excluded.waterlevel_local_m,
      freeboard_m = COALESCE(excluded.freeboard_m, water_level_history.freeboard_m),
      situation_level = COALESCE(excluded.situation_level, water_level_history.situation_level),
      discharge = COALESCE(excluded.discharge, water_level_history.discharge)
  `;

  const statements: D1PreparedStatement[] = uniquePoints.map((p) => {
    let freeboardM: number | null = null;
    if (metadata?.minBankMsl != null && p.waterlevelMsl != null) {
      freeboardM = Math.round((metadata.minBankMsl - p.waterlevelMsl) * 100) / 100;
    }
    return db.prepare(query).bind(
      stationId,
      p.observedAt,
      p.waterlevelMsl,
      p.waterlevelLocalM,
      freeboardM,
      p.situationLevel ?? null,
      null,
      p.discharge ?? null,
      now
    );
  });

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    await db.batch(chunk);
  }

  return uniquePoints.length;
}

/**
 * ดึงประวัติระดับน้ำย้อนหลังสำหรับทำกราฟจาก D1
 */
export async function queryWaterLevelHistory(
  db: D1Database,
  stationId: number,
  startIso: string,
  endIso: string
): Promise<WaterLevelGraphResult | null> {
  // ดึงข้อมูลสถานี
  const stationRow = await db
    .prepare(
      `SELECT id, min_bank_msl, warning_level_msl, critical_level_msl, ground_level_msl 
       FROM stations WHERE id = ? LIMIT 1`
    )
    .bind(stationId)
    .first<{
      id: number;
      min_bank_msl: number | null;
      warning_level_msl: number | null;
      critical_level_msl: number | null;
      ground_level_msl: number | null;
    }>();

  // ดึงข้อมูล Time-Series Points จาก D1
  const pointsRes = await db
    .prepare(
      `SELECT observed_at, waterlevel_msl, waterlevel_local_m, discharge, situation_level
       FROM water_level_history
       WHERE station_id = ? AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at ASC`
    )
    .bind(stationId, startIso, endIso)
    .all<{
      observed_at: string;
      waterlevel_msl: number | null;
      waterlevel_local_m: number | null;
      discharge: number | null;
      situation_level: number | null;
    }>();

  const rows = pointsRes.results || [];
  if (rows.length === 0) {
    return null;
  }

  const points: WaterLevelGraphPoint[] = rows.map((r) => ({
    observedAt: r.observed_at,
    waterlevelMsl: r.waterlevel_msl,
    waterlevelLocalM: r.waterlevel_local_m,
    discharge: r.discharge,
    situationLevel: r.situation_level,
  }));

  return {
    stationId,
    startDate: startIso,
    endDate: endIso,
    minBankMsl: stationRow?.min_bank_msl ?? null,
    warningLevelMsl: stationRow?.warning_level_msl ?? null,
    criticalLevelMsl: stationRow?.critical_level_msl ?? null,
    groundLevelMsl: stationRow?.ground_level_msl ?? null,
    points,
  };
}

/**
 * รวมการ Sync Snapshot ทั้งหมด (Stations, WaterLevel, Rainfall) ลง D1
 */
export async function syncSnapshotToD1(
  db: D1Database,
  waterLevels: WaterLevelRecord[],
  rainfalls: RainfallRecord[]
): Promise<{
  stationsCount: number;
  waterCount: number;
  rainCount: number;
}> {
  // รวมรายชื่อสถานีทั้งหมด
  const stationsToUpsert: (StationRef & {
    minBankMsl?: number | null;
    warningLevelMsl?: number | null;
    criticalLevelMsl?: number | null;
    groundLevelMsl?: number | null;
  })[] = [];

  for (const w of waterLevels) {
    if (w.station) {
      stationsToUpsert.push({
        ...w.station,
        minBankMsl: w.minBankMsl,
      });
    }
  }

  for (const r of rainfalls) {
    if (r.station) {
      stationsToUpsert.push(r.station);
    }
  }

  const stationsCount = await upsertStations(db, stationsToUpsert);
  const waterCount = await upsertWaterLevelRecords(db, waterLevels);
  const rainCount = await upsertRainfallRecords(db, rainfalls);

  return { stationsCount, waterCount, rainCount };
}
