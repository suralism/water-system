import {
  StationRef,
  WaterLevelRecord,
  RainfallRecord,
  WaterLevelGraphResult,
  WaterLevelGraphPoint,
  ThaiWaterClientOptions,
} from "./types.js";

export const DEFAULT_USER_AGENT = "my-app/1.0.0 (water-data-ingestion)";
export const API_WATER_LEVEL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load";
export const API_RAINFALL_24H = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h";
export const API_WATER_LEVEL_GRAPH = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_graph";

export const UBON_PROVINCE_CODE = "34";

// ค่าคงที่สำหรับระบบ Deduplication สถานี
const DEDUPE_DISTANCE_THRESHOLD_M = 100;
const EXACT_MATCH_DISTANCE_M = 1.0;
const STATION_ID_LEGACY_THRESHOLD = 10_000_000;

// score multipliers สำหรับเปรียบเทียบความสมบูรณ์ของข้อมูลสถานี
const SCORE_HAS_BANK = 1e11;
const SCORE_HAS_LEVEL = 1e10;
const SCORE_HAS_RAIN = 1e10;
const SCORE_LEGACY_ID = 1e9;

/**
 * แปลง String เวลาท้องถิ่นไทย (เช่น "2026-08-21 09:00") เป็น ISO-8601 UTC String
 * โดยกำหนด Timezone offset +07:00 เสมอ
 */
export function toIso(dateStr: unknown): string | null {
  if (typeof dateStr !== "string" || !dateStr.trim()) return null;
  const trimmed = dateStr.trim();
  const formatted = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withOffset =
    formatted.includes("+") || formatted.endsWith("Z")
      ? formatted
      : `${formatted}+07:00`;
  const ms = Date.parse(withOffset);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * ตัวช่วยสร้าง StationRef จากข้อมูล Geocode และ Tele Station
 */
function parseStationRef(item: any): StationRef | null {
  const stationObj = item.station ?? {};
  const geocodeObj = item.geocode ?? {};
  const agencyObj = item.agency ?? stationObj.agency ?? {};

  const lat = Number(stationObj.tele_station_lat ?? item.tele_station_lat);
  const lon = Number(stationObj.tele_station_long ?? item.tele_station_long);

  // กรองสถานี: พิกัดต้องเป็นตัวเลขที่ถูกต้อง และไม่ตกที่ (0, 0)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    return null;
  }

  const rawProvCode = geocodeObj.province_code ?? stationObj.province_code;
  const provinceCode = rawProvCode != null ? String(rawProvCode).padStart(2, "0") : null;

  return {
    id: Number(stationObj.id ?? item.id),
    oldcode: stationObj.tele_station_oldcode ?? item.tele_station_oldcode ?? null,
    nameTh: stationObj.tele_station_name?.th ?? item.station_name?.th ?? null,
    nameEn: stationObj.tele_station_name?.en ?? item.station_name?.en ?? null,
    lat,
    lon,
    provinceCode,
    provinceNameTh: geocodeObj.province_name?.th ?? null,
    amphoeNameTh: geocodeObj.amphoe_name?.th ?? null,
    tumbonNameTh: geocodeObj.tumbon_name?.th ?? null,
    basinNameTh: item.basin?.basin_name?.th ?? null,
    agencyNameTh: agencyObj.agency_shortname?.th ?? agencyObj.agency_name?.th ?? null,
  };
}

/**
 * คำนวณระยะห่างระหว่างพิกัด GPS 2 จุด (หน่วยเป็นเมตร)
 */
export function getGpsDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat1 - lat2) * 111000;
  const dLon = (lon1 - lon2) * 111000 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * ปรับปรุงและตัดอักขระพิเศษของชื่อสถานีเพื่อเปรียบเทียบความซ้ำซ้อน
 */
export function normalizeStationName(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(/\s+/g, "").replace(/[\(\)（）\-\_\.\[\]]/g, "").toLowerCase();
}

/**
 * ตรวจสอบว่า Record สองตัวเป็นสถานีเดียวกันหรือไม่
 * โดยใช้เกณฑ์ ID เดียวกัน หรือ ระยะห่าง < 100 ม. + ชื่อ/รหัสตรงกัน
 */
function isSameStation(
  aId: number, aLat: number, aLon: number, aName: string, aCode: string,
  bId: number, bLat: number, bLon: number, bName: string, bCode: string
): boolean {
  if (aId === bId) return true;
  const distM = getGpsDistanceM(aLat, aLon, bLat, bLon);
  if (distM >= DEDUPE_DISTANCE_THRESHOLD_M) return false;
  const sameName = Boolean(aName && bName && (aName === bName || aName.includes(bName) || bName.includes(aName)));
  const sameCode = Boolean(aCode && bCode && aCode === bCode);
  return sameName || sameCode || distM < EXACT_MATCH_DISTANCE_M;
}

/**
 * Generic helper: จับกลุ่มสถานีที่ซ้ำซ้อนและคัดเลือก Record ที่ดีที่สุดจากแต่ละกลุ่ม
 * ทำงานกับทั้ง WaterLevelRecord และ RainfallRecord โดยรับ callback สำหรับดึงค่า station ref
 */
function clusterAndDeduplicate<T>(
  records: T[],
  getStation: (r: T) => StationRef,
  scoreFn: (r: T) => number
): T[] {
  const result: T[] = [];
  const visited = new Set<number>();

  for (let i = 0; i < records.length; i++) {
    if (visited.has(i)) continue;
    const cluster: T[] = [records[i]];
    visited.add(i);

    const a = records[i];
    const sa = getStation(a);
    const nameA = normalizeStationName(sa.nameTh);
    const codeA = (sa.oldcode || "").replace(/^ridhydro_/i, "").trim().toLowerCase();

    for (let j = i + 1; j < records.length; j++) {
      if (visited.has(j)) continue;
      const b = records[j];
      const sb = getStation(b);
      const nameB = normalizeStationName(sb.nameTh);
      const codeB = (sb.oldcode || "").replace(/^ridhydro_/i, "").trim().toLowerCase();

      if (isSameStation(sa.id, sa.lat, sa.lon, nameA, codeA, sb.id, sb.lat, sb.lon, nameB, codeB)) {
        cluster.push(b);
        visited.add(j);
      }
    }

    cluster.sort((x, y) => scoreFn(y) - scoreFn(x));
    result.push(cluster[0]);
  }

  return result;
}

/**
 * ให้คะแนน WaterLevelRecord เพื่อเลือก Record ที่สมบูรณ์และสดใหม่ที่สุด
 */
function scoreWaterLevelRecord(item: WaterLevelRecord): number {
  let score = 0;
  const timeMs = item.observedAt ? Date.parse(item.observedAt) : 0;
  if (Number.isFinite(timeMs)) score += timeMs;
  if (item.minBankMsl !== null && item.minBankMsl > 0) score += SCORE_HAS_BANK;
  if (item.waterlevelMsl !== null) score += SCORE_HAS_LEVEL;
  if (item.station.id < STATION_ID_LEGACY_THRESHOLD) score += SCORE_LEGACY_ID;
  return score;
}

/**
 * ให้คะแนน RainfallRecord เพื่อเลือก Record ที่สมบูรณ์และสดใหม่ที่สุด
 */
function scoreRainfallRecord(item: RainfallRecord): number {
  let score = 0;
  const timeMs = item.observedAt ? Date.parse(item.observedAt) : 0;
  if (Number.isFinite(timeMs)) score += timeMs;
  if (item.rain24h !== null) score += SCORE_HAS_RAIN;
  if (item.station.id < STATION_ID_LEGACY_THRESHOLD) score += SCORE_LEGACY_ID;
  return score;
}

/**
 * ตัดความซ้ำซ้อนของสถานีระดับน้ำ (Water Level Data Deduplication)
 */
export function deduplicateWaterLevelRecords(records: WaterLevelRecord[]): WaterLevelRecord[] {
  return clusterAndDeduplicate(records, (r) => r.station, scoreWaterLevelRecord);
}

/**
 * ตัดความซ้ำซ้อนของสถานีวัดปริมาณน้ำฝน (Rainfall Data Deduplication)
 */
export function deduplicateRainfallRecords(records: RainfallRecord[]): RainfallRecord[] {
  return clusterAndDeduplicate(records, (r) => r.station, scoreRainfallRecord);
}

/**
 * Helper: เรียก HTTP API ด้วย AbortController + User-Agent headers
 */
async function fetchJson(
  url: string,
  options: ThaiWaterClientOptions
): Promise<any> {
  const fetchImpl = options.fetchFn ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  const controller = new AbortController();
  const timeoutId = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (typeof navigator === "undefined" && userAgent) {
      headers["User-Agent"] = userAgent;
    }

    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Fetch failed [${url}] status: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * 1. ดึงข้อมูลระดับน้ำ (Water Level Snapshot) - กรองเฉพาะ จ.อุบลราชธานี (34) ทันทีเพื่อความเร็วสูงสุด
 */
export async function fetchWaterLevel(
  options: ThaiWaterClientOptions & { targetProvinceCode?: string | null } = {}
): Promise<WaterLevelRecord[]> {
  const targetProvince = options.targetProvinceCode !== undefined ? options.targetProvinceCode : UBON_PROVINCE_CODE;
  const shouldDeduplicate = options.deduplicate ?? true;

  const body = await fetchJson(API_WATER_LEVEL, options);
  const rawList = body?.waterlevel_data?.data ?? [];
  const results: WaterLevelRecord[] = [];

  for (const item of rawList) {
    const rawProv = item.geocode?.province_code ?? item.station?.province_code;
    const provCode = rawProv != null ? String(rawProv).padStart(2, "0") : null;
    if (targetProvince && provCode !== targetProvince) continue;

    const station = parseStationRef(item);
    if (!station) continue;

    const rawMinBank = Number(item.station?.min_bank ?? item.min_bank);
    const minBankMsl = Number.isFinite(rawMinBank) && rawMinBank > 0 ? rawMinBank : null;
    const waterlevelMsl = Number.isFinite(Number(item.waterlevel_msl))
      ? Number(item.waterlevel_msl)
      : null;

    const freeboardM =
      waterlevelMsl !== null && minBankMsl !== null
        ? Math.round((minBankMsl - waterlevelMsl) * 1000) / 1000
        : null;

    results.push({
      station,
      waterlevelMsl,
      waterlevelLocalM: Number.isFinite(Number(item.waterlevel_m)) ? Number(item.waterlevel_m) : null,
      minBankMsl,
      freeboardM,
      situationLevel: Number.isFinite(Number(item.situation_level)) ? Number(item.situation_level) : null,
      storagePercent: Number.isFinite(Number(item.storage_percent)) ? Number(item.storage_percent) : null,
      observedAt: toIso(item.waterlevel_datetime),
    });
  }

  return shouldDeduplicate ? deduplicateWaterLevelRecords(results) : results;
}

/**
 * 2. ดึงข้อมูลปริมาณน้ำฝน (Rainfall Snapshot) - กรองเฉพาะ จ.อุบลราชธานี (34) ทันที
 */
export async function fetchRainfall(
  options: ThaiWaterClientOptions & { targetProvinceCode?: string | null } = {}
): Promise<RainfallRecord[]> {
  const targetProvince = options.targetProvinceCode !== undefined ? options.targetProvinceCode : UBON_PROVINCE_CODE;
  const shouldDeduplicate = options.deduplicate ?? true;

  const body = await fetchJson(API_RAINFALL_24H, options);
  const rawList = body?.data ?? [];
  const results: RainfallRecord[] = [];

  for (const item of rawList) {
    const rawProv = item.geocode?.province_code ?? item.station?.province_code;
    const provCode = rawProv != null ? String(rawProv).padStart(2, "0") : null;
    if (targetProvince && provCode !== targetProvince) continue;

    const station = parseStationRef(item);
    if (!station) continue;

    results.push({
      station,
      rain24h: Number.isFinite(Number(item.rain_24h)) ? Number(item.rain_24h) : null,
      rain1h: Number.isFinite(Number(item.rain_1h)) ? Number(item.rain_1h) : null,
      observedAt: toIso(item.rainfall_datetime),
    });
  }

  return shouldDeduplicate ? deduplicateRainfallRecords(results) : results;
}

export interface WaterLevelGraphParams {
  stationId: number | string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string;   // "YYYY-MM-DD HH:mm"
}

/**
 * 3. ดึงข้อมูลประวัติระดับน้ำย้อนหลังรายสถานี (Station Water Level Time-series)
 * หมายเหตุ: URL Encoding ของช่องว่างใน end_date ใช้ %20 เสมอ (ห้ามใช้ +)
 */
export async function fetchWaterLevelGraph(
  params: WaterLevelGraphParams,
  options: ThaiWaterClientOptions = {}
): Promise<WaterLevelGraphResult> {
  const stationIdStr = String(params.stationId);
  const cleanStartDate = encodeURIComponent(params.startDate.trim());
  const cleanEndDate = params.endDate.trim().replace(/ /g, "%20");

  const query = [
    `station_type=tele_waterlevel`,
    `station_id=${encodeURIComponent(stationIdStr)}`,
    `start_date=${cleanStartDate}`,
    `end_date=${cleanEndDate}`,
  ].join("&");

  const url = `${API_WATER_LEVEL_GRAPH}?${query}`;
  const body = await fetchJson(url, options);
  const dataObj = body?.data ?? {};
  const rawPoints = dataObj.graph_data ?? [];
  const points: WaterLevelGraphPoint[] = [];

  for (const pt of rawPoints) {
    const datetimeStr = pt.datetime ?? pt.waterlevel_datetime;
    const rawVal = pt.value !== undefined ? pt.value : pt.waterlevel_msl;
    const waterlevelMsl =
      rawVal !== null && Number.isFinite(Number(rawVal)) ? Number(rawVal) : null;

    const rawLocalM = pt.waterlevel_m ?? pt.value_out;
    const waterlevelLocalM =
      rawLocalM !== null && Number.isFinite(Number(rawLocalM)) ? Number(rawLocalM) : null;

    const discharge =
      pt.discharge !== null && Number.isFinite(Number(pt.discharge)) ? Number(pt.discharge) : null;

    points.push({
      observedAt: toIso(datetimeStr),
      waterlevelMsl,
      waterlevelLocalM,
      discharge,
      situationLevel: Number.isFinite(Number(pt.situation_level)) ? Number(pt.situation_level) : null,
      rawDatetime: datetimeStr,
    });
  }

  const parsePositiveNum = (v: any) =>
    v !== null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;

  return {
    stationId: Number(params.stationId),
    startDate: params.startDate,
    endDate: params.endDate,
    minBankMsl: parsePositiveNum(dataObj.min_bank),
    warningLevelMsl: parsePositiveNum(dataObj.warning_level),
    criticalLevelMsl: parsePositiveNum(dataObj.critical_level),
    groundLevelMsl: parsePositiveNum(dataObj.ground_level),
    points,
  };
}
