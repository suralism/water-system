# ThaiWater Ingestion & Caching Service

โมดูล TypeScript / Node.js สำหรับดึงข้อมูลและจัดการแคช **ระดับน้ำ (Water Level)**, **ปริมาณน้ำฝน (Rainfall)** และ **กราฟประวัติย้อนหลัง (Time-series Graph)** จาก **ThaiWater API v3** (สถาบันสารสนเทศทรัพยากรน้ำ - HII) โดยไม่ต้องใช้ API Key

---

## 📦 ฟีเจอร์หลัก (Key Features)

1. **Water Level Snapshot**: ดึงระดับน้ำเทียบระดับน้ำทะเลปานกลาง (ม.รทก.), ระดับท้องน้ำ, ความจุ %, ระดับสถานการณ์ (1-5)
2. **Rainfall Snapshot**: ดึงปริมาณน้ำฝนสะสม 24 ชั่วโมง และ 1 ชั่วโมงล่าสุด
3. **Station Time-series Graph**: ดึงกราฟประวัติระดับน้ำย้อนหลังรายสถานี
4. **Timezone Normalization**: แปลงเวลาท้องถิ่นไทย (+07:00) เป็น ISO-8601 UTC
5. **Data Cleaning & Validation**:
   - กรองและ Drop สถานีที่ไม่มีพิกัด Latitude/Longitude หรือตกที่ `(0, 0)`
   - แปลงรหัสจังหวัด `provinceCode` ให้เป็น String 2 หลักเสมอ (เช่น `"50"`, `"10"`)
   - กรองค่าความสูงตลิ่ง `min_bank <= 0` ให้เป็น `null` เพื่อป้องกันการคำนวณน้ำล้นตลิ่งผิดพลาด
   - คำนวณระยะพ้นตลิ่ง (`freeboardM = minBankMsl - waterlevelMsl`) โดยค่าบวก = น้ำต่ำกว่าตลิ่ง (ม.), ค่าลบ = น้ำล้นตลิ่ง (ม.)
6. **Smart Caching & Request Deduplication (Single-Flight)**:
   - ป้องกันการยิง API ซ้ำซ้อนและลดภาระโหลดข้อมูลขนาด 2–4 MB (~5,500 สถานี)
   - รองรับ In-memory TTL Cache และ Background Polling (5–10 นาที)
7. **URL Encoding**: จัดการ Query Parameters ของ Graph API โดยใช้ `%20` สำหรับช่องว่างใน `end_date` อย่างถูกต้อง

---

## 🚀 การติดตั้งและเริ่มใช้งาน (Installation)

```bash
npm install
```

### การทดสอบ (Run Tests)
```bash
npm test
```

### การรันตัวอย่าง (Run Demo)
```bash
npm run demo
```

### การ Build TypeScript
```bash
npm run build
```

---

## 💻 ตัวอย่างการเรียกใช้งาน (Usage Examples)

### 1. ใช้งานผ่าน `ThaiWaterService` (แนะนำ - มี Cache และ Request Deduplication ในตัว)

```typescript
import { ThaiWaterService } from "./src/index.js";

const service = new ThaiWaterService({
  ttlMs: 5 * 60 * 1000,          // แคช 5 นาที (default)
  pollIntervalMs: 5 * 60 * 1000, // Background Polling ทุก 5 นาที
  autoStartPolling: false,       // ตั้งเป็น true หากต้องการให้ Poll อัตโนมัติในเบื้องหลัง
});

// ดึงระดับน้ำ Snapshot
const waterLevels = await service.getWaterLevel();

// ดึงปริมาณน้ำฝน Snapshot
const rainfalls = await service.getRainfall();

// กรองสถานีตามรหัสจังหวัด (เช่น เชียงใหม่ รหัส "50")
const cmStations = await service.getWaterLevelsByProvince("50");

// รวมข้อมูลระดับน้ำ + น้ำฝนตามสถานี
const combinedMap = await service.getCombinedSnapshot();

// ดึงข้อมูลกราฟย้อนหลังรายสถานี
const graph = await service.getWaterLevelGraph({
  stationId: 512,
  startDate: "2026-08-20",
  endDate: "2026-08-21 09:00",
});
```

---

### 2. เรียกใช้งานฟังก์ชันโดยตรง (Direct Ingestion Functions)

```typescript
import {
  fetchWaterLevel,
  fetchRainfall,
  fetchWaterLevelGraph,
} from "./src/index.js";

// ดึงระดับน้ำ
const waterLevels = await fetchWaterLevel({
  userAgent: "my-custom-agent/1.0.0",
  timeoutMs: 15000,
});

// ดึงน้ำฝน
const rainfalls = await fetchRainfall();

// ดึงกราฟประวัติย้อนหลัง
const graphData = await fetchWaterLevelGraph({
  stationId: 123,
  startDate: "2026-08-20",
  endDate: "2026-08-21 09:00",
});
```

---

## 📊 โครงสร้างข้อมูล (Data Structures)

### `WaterLevelRecord`
```typescript
interface WaterLevelRecord {
  station: {
    id: number;
    nameTh: string | null;
    nameEn: string | null;
    lat: number;
    lon: number;
    provinceCode: string | null;   // e.g. "50", "10"
    provinceNameTh: string | null; // e.g. "เชียงใหม่"
    amphoeNameTh: string | null;
    tumbonNameTh?: string | null;
    basinNameTh?: string | null;
  };
  waterlevelMsl: number | null;     // ระดับน้ำ ม.รทก.
  waterlevelLocalM: number | null;   // ระดับน้ำเทียบท้องน้ำ (ม.)
  minBankMsl: number | null;         // ระดับตลิ่งต่ำสุด (ม.รทก.)
  freeboardM: number | null;         // ระยะพ้นตลิ่ง (เมตร) [บวก = ต่ำกว่าตลิ่ง, ลบ = ล้นตลิ่ง]
  situationLevel: number | null;     // ระดับสถานการณ์ (1-5)
  storagePercent: number | null;     // % ความจุ
  observedAt: string | null;         // ISO-8601 UTC string
}
```

### `RainfallRecord`
```typescript
interface RainfallRecord {
  station: StationRef;
  rain24h: number | null;            // ฝนสะสม 24 ชม. (มม.)
  rain1h: number | null;             // ฝน 1 ชม. ล่าสุด (มม.)
  observedAt: string | null;         // ISO-8601 UTC string
}
```
