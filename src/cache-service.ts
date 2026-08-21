import {
  WaterLevelRecord,
  RainfallRecord,
  WaterLevelGraphResult,
  CacheOptions,
  ThaiWaterClientOptions,
} from "./types.js";
import {
  fetchWaterLevel,
  fetchRainfall,
  fetchWaterLevelGraph,
  WaterLevelGraphParams,
} from "./thaiwater.js";

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

export interface StationCombinedData {
  stationId: number;
  waterLevel?: WaterLevelRecord;
  rainfall?: RainfallRecord;
}

export class ThaiWaterService {
  private waterLevelCache: CacheEntry<WaterLevelRecord[]> | null = null;
  private rainfallCache: CacheEntry<RainfallRecord[]> | null = null;
  private graphCache = new Map<string, CacheEntry<WaterLevelGraphResult>>();

  private ttlMs: number;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private clientOptions: ThaiWaterClientOptions;

  // In-flight request deduplication (Single Flight)
  private pendingWaterLevelPromise: Promise<WaterLevelRecord[]> | null = null;
  private pendingRainfallPromise: Promise<RainfallRecord[]> | null = null;

  constructor(
    cacheOptions: CacheOptions = {},
    clientOptions: ThaiWaterClientOptions = {}
  ) {
    this.ttlMs = cacheOptions.ttlMs ?? 5 * 60 * 1000; // 5 นาที
    this.pollIntervalMs = cacheOptions.pollIntervalMs ?? 5 * 60 * 1000;
    this.clientOptions = clientOptions;

    if (cacheOptions.autoStartPolling) {
      this.startPolling();
    }
  }

  /**
   * ดึงข้อมูลระดับน้ำ (Water Level) โดยใช้ระบบ Cache & Request Deduplication
   */
  async getWaterLevel(forceRefresh = false): Promise<WaterLevelRecord[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.waterLevelCache &&
      now - this.waterLevelCache.cachedAt < this.ttlMs
    ) {
      return this.waterLevelCache.data;
    }

    if (this.pendingWaterLevelPromise) {
      return this.pendingWaterLevelPromise;
    }

    this.pendingWaterLevelPromise = (async () => {
      try {
        const data = await fetchWaterLevel(this.clientOptions);
        this.waterLevelCache = { data, cachedAt: Date.now() };
        return data;
      } finally {
        this.pendingWaterLevelPromise = null;
      }
    })();

    return this.pendingWaterLevelPromise;
  }

  /**
   * ดึงข้อมูลปริมาณน้ำฝน (Rainfall) โดยใช้ระบบ Cache & Request Deduplication
   */
  async getRainfall(forceRefresh = false): Promise<RainfallRecord[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.rainfallCache &&
      now - this.rainfallCache.cachedAt < this.ttlMs
    ) {
      return this.rainfallCache.data;
    }

    if (this.pendingRainfallPromise) {
      return this.pendingRainfallPromise;
    }

    this.pendingRainfallPromise = (async () => {
      try {
        const data = await fetchRainfall(this.clientOptions);
        this.rainfallCache = { data, cachedAt: Date.now() };
        return data;
      } finally {
        this.pendingRainfallPromise = null;
      }
    })();

    return this.pendingRainfallPromise;
  }

  /**
   * ดึงข้อมูลประวัติกราฟระดับน้ำย้อนหลังรายสถานี
   */
  async getWaterLevelGraph(
    params: WaterLevelGraphParams,
    forceRefresh = false
  ): Promise<WaterLevelGraphResult> {
    const cacheKey = `${params.stationId}_${params.startDate}_${params.endDate}`;
    const now = Date.now();
    const existing = this.graphCache.get(cacheKey);

    if (!forceRefresh && existing && now - existing.cachedAt < this.ttlMs) {
      return existing.data;
    }

    const data = await fetchWaterLevelGraph(params, this.clientOptions);
    this.graphCache.set(cacheKey, { data, cachedAt: Date.now() });
    return data;
  }

  /**
   * ดึงข้อมูลสถานีตามรหัสจังหวัด (เช่น "50" สำหรับเชียงใหม่, "10" สำหรับ กทม.)
   */
  async getWaterLevelsByProvince(
    provinceCode: string,
    forceRefresh = false
  ): Promise<WaterLevelRecord[]> {
    const normalized = provinceCode.padStart(2, "0");
    const list = await this.getWaterLevel(forceRefresh);
    return list.filter((item) => item.station.provinceCode === normalized);
  }

  /**
   * รวมข้อมูล Snapshot ระดับน้ำ และปริมาณน้ำฝน เข้าด้วยกันเป็น Map ตาม Station ID
   */
  async getCombinedSnapshot(
    forceRefresh = false
  ): Promise<Map<number, StationCombinedData>> {
    const [waterLevels, rainfalls] = await Promise.all([
      this.getWaterLevel(forceRefresh),
      this.getRainfall(forceRefresh),
    ]);

    const map = new Map<number, StationCombinedData>();

    for (const wl of waterLevels) {
      map.set(wl.station.id, {
        stationId: wl.station.id,
        waterLevel: wl,
      });
    }

    for (const rf of rainfalls) {
      const existing = map.get(rf.station.id);
      if (existing) {
        existing.rainfall = rf;
      } else {
        map.set(rf.station.id, {
          stationId: rf.station.id,
          rainfall: rf,
        });
      }
    }

    return map;
  }

  /**
   * เริ่ม Background Polling เพื่อดึงข้อมูลอัปเดตอัตโนมัติตามช่วงเวลา
   */
  startPolling(intervalMs?: number): void {
    if (intervalMs) this.pollIntervalMs = intervalMs;
    if (this.pollTimer) clearInterval(this.pollTimer);

    // Initial fetch
    this.refreshAll().catch((err) =>
      console.error("[ThaiWaterService] Initial poll error:", err)
    );

    this.pollTimer = setInterval(async () => {
      try {
        await this.refreshAll();
      } catch (err) {
        console.error("[ThaiWaterService] Background poll error:", err);
      }
    }, this.pollIntervalMs);
  }

  /**
   * หยุด Background Polling
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * บังคับดึงข้อมูลใหม่ทั้งหมดทันที
   */
  async refreshAll(): Promise<{
    waterLevels: WaterLevelRecord[];
    rainfalls: RainfallRecord[];
  }> {
    const [waterLevels, rainfalls] = await Promise.all([
      this.getWaterLevel(true),
      this.getRainfall(true),
    ]);
    return { waterLevels, rainfalls };
  }

  /**
   * คืนสถานะและขนาดข้อมูลใน Cache ปัจจุบัน
   */
  getCacheStatus(): {
    waterLevelCount: number;
    waterLevelAgeMs: number | null;
    rainfallCount: number;
    rainfallAgeMs: number | null;
    isPolling: boolean;
  } {
    const now = Date.now();
    return {
      waterLevelCount: this.waterLevelCache?.data.length ?? 0,
      waterLevelAgeMs: this.waterLevelCache ? now - this.waterLevelCache.cachedAt : null,
      rainfallCount: this.rainfallCache?.data.length ?? 0,
      rainfallAgeMs: this.rainfallCache ? now - this.rainfallCache.cachedAt : null,
      isPolling: this.pollTimer !== null,
    };
  }
}
