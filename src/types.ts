export interface StationRef {
  id: number;
  oldcode?: string | null;
  nameTh: string | null;
  nameEn: string | null;
  lat: number;
  lon: number;
  provinceCode: string | null;
  provinceNameTh: string | null;
  amphoeNameTh: string | null;
  tumbonNameTh?: string | null;
  basinNameTh?: string | null;
  agencyNameTh?: string | null;
}

export interface WaterLevelRecord {
  station: StationRef;
  waterlevelMsl: number | null;     // ระดับน้ำเทียบระดับน้ำทะเลปานกลาง (ม.รทก.)
  waterlevelLocalM: number | null;   // ระดับน้ำเทียบระดับท้องน้ำ (ม.)
  minBankMsl: number | null;         // ระดับตลิ่งต่ำสุด (ม.รทก.)
  freeboardM: number | null;         // ระยะพ้นตลิ่ง (เมตร) [ค่าบวก = ต่ำกว่าตลิ่ง, ค่าลบ = ล้นตลิ่ง]
  situationLevel: number | null;     // ระดับสถานการณ์ (1-5)
  storagePercent: number | null;     // % ความจุ
  observedAt: string | null;         // ISO String (+07:00 -> UTC ISO)
}

export interface RainfallRecord {
  station: StationRef;
  rain24h: number | null;            // ฝนสะสม 24 ชม. (มม.)
  rain1h: number | null;             // ฝน 1 ชม. ล่าสุด (มม.)
  observedAt: string | null;         // ISO String (+07:00 -> UTC ISO)
}

export interface WaterLevelGraphPoint {
  observedAt: string | null;         // ISO String (+07:00 -> UTC ISO)
  waterlevelMsl: number | null;     // ระดับน้ำเทียบระดับน้ำทะเลปานกลาง (ม.รทก.) จาก pt.value หรือ pt.waterlevel_msl
  waterlevelLocalM: number | null;   // ระดับน้ำเทียบระดับท้องน้ำ (ม.)
  discharge?: number | null;        // อัตราการไหล (ลบ.ม./วินาที)
  situationLevel?: number | null;
  rawDatetime?: string;
}

export interface WaterLevelGraphResult {
  stationId: number;
  startDate: string;
  endDate: string;
  minBankMsl: number | null;
  warningLevelMsl: number | null;
  criticalLevelMsl: number | null;
  groundLevelMsl: number | null;
  points: WaterLevelGraphPoint[];
}

export interface ThaiWaterClientOptions {
  userAgent?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  targetProvinceCode?: string | null;
  deduplicate?: boolean;
}

export interface CacheOptions {
  ttlMs?: number;               // ระยะเวลา Cache (default: 5 นาที / 300,000 ms)
  pollIntervalMs?: number;      // ความถี่ Background Polling (default: 5 นาที)
  autoStartPolling?: boolean;   // เริ่ม Polling ทันทีหรือไม่ (default: false)
}

