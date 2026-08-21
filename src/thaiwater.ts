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

/**
 * แปลง String เวลาท้องถิ่นไทย (เช่น "2026-08-21 09:00") เป็น ISO-8601 UTC String
 * โดยกำหนด Timezone offset +07:00 เสมอ
 */
export function toIso(dateStr: unknown): string | null {
  if (typeof dateStr !== "string" || !dateStr.trim()) return null;
  const trimmed = dateStr.trim();
  // จัดการรูปแบบที่มีหรือไม่มี T และการใส่ +07:00
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

  const lat = Number(stationObj.tele_station_lat);
  const lon = Number(stationObj.tele_station_long);

  // กรองสถานี: พิกัดต้องเป็นตัวเลขที่ถูกต้อง และไม่ตกที่ (0, 0)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    return null;
  }

  const rawProvCode = geocodeObj.province_code ?? stationObj.province_code;
  const provinceCode = rawProvCode != null ? String(rawProvCode).padStart(2, "0") : null;

  return {
    id: Number(stationObj.id ?? item.id),
    nameTh: stationObj.tele_station_name?.th ?? item.station_name?.th ?? null,
    nameEn: stationObj.tele_station_name?.en ?? item.station_name?.en ?? null,
    lat,
    lon,
    provinceCode,
    provinceNameTh: geocodeObj.province_name?.th ?? null,
    amphoeNameTh: geocodeObj.amphoe_name?.th ?? null,
    tumbonNameTh: geocodeObj.tumbon_name?.th ?? null,
    basinNameTh: item.basin?.basin_name?.th ?? null,
  };
}

export const UBON_PROVINCE_CODE = "34";

/**
 * 1. ดึงข้อมูลระดับน้ำ (Water Level Snapshot) - กรองเฉพาะ จ.อุบลราชธานี (34) ทันทีเพื่อความเร็วสูงสุด
 */
export async function fetchWaterLevel(
  options: ThaiWaterClientOptions & { targetProvinceCode?: string | null } = {}
): Promise<WaterLevelRecord[]> {
  const fetchImpl = options.fetchFn ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const targetProvince = options.targetProvinceCode !== undefined ? options.targetProvinceCode : UBON_PROVINCE_CODE;

  const controller = new AbortController();
  const timeoutId = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;

  try {
    const res = await fetchImpl(API_WATER_LEVEL, {
      method: "GET",
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Fetch waterlevel failed with status: ${res.status} ${res.statusText}`);
    }

    const body: any = await res.json();
    const rawList = body?.waterlevel_data?.data ?? [];
    const results: WaterLevelRecord[] = [];

    for (const item of rawList) {
      // ตรวจสอบรหัสจังหวัดก่อน เพื่อลดภาระการประมวลผลทันที
      const rawProv = item.geocode?.province_code ?? item.station?.province_code;
      const provCode = rawProv != null ? String(rawProv).padStart(2, "0") : null;
      if (targetProvince && provCode !== targetProvince) {
        continue; // ข้ามข้อมูลจังหวัดอื่นทั้งหมด
      }

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
        waterlevelLocalM: Number.isFinite(Number(item.waterlevel_m))
          ? Number(item.waterlevel_m)
          : null,
        minBankMsl,
        freeboardM,
        situationLevel: Number.isFinite(Number(item.situation_level))
          ? Number(item.situation_level)
          : null,
        storagePercent: Number.isFinite(Number(item.storage_percent))
          ? Number(item.storage_percent)
          : null,
        observedAt: toIso(item.waterlevel_datetime),
      });
    }

    return results;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * 2. ดึงข้อมูลปริมาณน้ำฝน (Rainfall Snapshot) - กรองเฉพาะ จ.อุบลราชธานี (34) ทันที
 */
export async function fetchRainfall(
  options: ThaiWaterClientOptions & { targetProvinceCode?: string | null } = {}
): Promise<RainfallRecord[]> {
  const fetchImpl = options.fetchFn ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const targetProvince = options.targetProvinceCode !== undefined ? options.targetProvinceCode : UBON_PROVINCE_CODE;

  const controller = new AbortController();
  const timeoutId = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;

  try {
    const res = await fetchImpl(API_RAINFALL_24H, {
      method: "GET",
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Fetch rainfall failed with status: ${res.status} ${res.statusText}`);
    }

    const body: any = await res.json();
    const rawList = body?.data ?? [];
    const results: RainfallRecord[] = [];

    for (const item of rawList) {
      // ตรวจสอบรหัสจังหวัดก่อน
      const rawProv = item.geocode?.province_code ?? item.station?.province_code;
      const provCode = rawProv != null ? String(rawProv).padStart(2, "0") : null;
      if (targetProvince && provCode !== targetProvince) {
        continue; // ข้ามข้อมูลจังหวัดอื่นทั้งหมด
      }

      const station = parseStationRef(item);
      if (!station) continue;

      results.push({
        station,
        rain24h: Number.isFinite(Number(item.rain_24h)) ? Number(item.rain_24h) : null,
        rain1h: Number.isFinite(Number(item.rain_1h)) ? Number(item.rain_1h) : null,
        observedAt: toIso(item.rainfall_datetime),
      });
    }

    return results;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
  const fetchImpl = options.fetchFn ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  const stationIdStr = String(params.stationId);
  // ใช้ %20 สำหรับช่องว่างใน end_date เพื่อความถูกต้องตามข้อกำหนดของ ThaiWater API
  const cleanStartDate = encodeURIComponent(params.startDate.trim());
  const cleanEndDate = params.endDate.trim().replace(/ /g, "%20");

  const query = [
    `station_type=tele_waterlevel`,
    `station_id=${encodeURIComponent(stationIdStr)}`,
    `start_date=${cleanStartDate}`,
    `end_date=${cleanEndDate}`,
  ].join("&");

  const url = `${API_WATER_LEVEL_GRAPH}?${query}`;

  const controller = new AbortController();
  const timeoutId = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Fetch waterlevel graph failed with status: ${res.status} ${res.statusText}`);
    }

    const body: any = await res.json();
    const dataObj = body?.data ?? {};
    const rawPoints = dataObj.graph_data ?? [];
    const points: WaterLevelGraphPoint[] = [];

    for (const pt of rawPoints) {
      const datetimeStr = pt.datetime ?? pt.waterlevel_datetime;
      const rawVal = pt.value !== undefined ? pt.value : pt.waterlevel_msl;
      const waterlevelMsl =
        rawVal !== null && Number.isFinite(Number(rawVal))
          ? Number(rawVal)
          : null;

      const rawLocalM = pt.waterlevel_m ?? pt.value_out;
      const waterlevelLocalM =
        rawLocalM !== null && Number.isFinite(Number(rawLocalM))
          ? Number(rawLocalM)
          : null;

      const discharge =
        pt.discharge !== null && Number.isFinite(Number(pt.discharge))
          ? Number(pt.discharge)
          : null;

      points.push({
        observedAt: toIso(datetimeStr),
        waterlevelMsl,
        waterlevelLocalM,
        discharge,
        situationLevel: Number.isFinite(Number(pt.situation_level))
          ? Number(pt.situation_level)
          : null,
        rawDatetime: datetimeStr,
      });
    }

    const parseNum = (v: any) =>
      v !== null && Number.isFinite(Number(v)) && Number(v) > 0
        ? Number(v)
        : null;

    return {
      stationId: Number(params.stationId),
      startDate: params.startDate,
      endDate: params.endDate,
      minBankMsl: parseNum(dataObj.min_bank),
      warningLevelMsl: parseNum(dataObj.warning_level),
      criticalLevelMsl: parseNum(dataObj.critical_level),
      groundLevelMsl: parseNum(dataObj.ground_level),
      points,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
