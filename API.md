# 📡 UBONWATCH Public API Documentation
> **ระบบเตือนภัยและติดตามสถานการณ์น้ำ จ.อุบลราชธานี แบบ Real-time**  
> ข้อมูลตรวจวัดจาก สถาบันสารสนเทศทรัพยากรน้ำ (องค์การมหาชน) - HII (ThaiWater API v3)  
> ประมวลผลและให้บริการความเร็วสูงผ่าน Cloudflare Workers & D1 Edge Database

---

## 🌐 Base URL & Protocol

ทุก Endpoint ให้บริการผ่าน HTTPS รองรับ HTTP/1.1, HTTP/2 และ HTTP/3 พร้อมเปิด **CORS (`Access-Control-Allow-Origin: *`)** เป็นค่าเริ่มต้น สามารถเรียกใช้งานได้จาก Browser (Frontend), Node.js, Python, LINE Bot, Webhook หรือ Mobile App ได้โดยตรง

- **Production Primary:** `https://water.ubon.online`
- **Production Failover (Worker Direct):** `https://ubonwatch-water.suralism.workers.dev`

---

## 📋 สรุปรายการ Endpoints ทั้งหมด

| Endpoint | Method | ความเร็วเฉลี่ย | สิทธิ์เข้าถึง | คำอธิบาย |
| :--- | :---: | :---: | :---: | :--- |
| [`/api/summary`](#1-get-apisummary) | `GET` | ~10 ms | Public | สรุปภาพรวมสถานการณ์น้ำทั้งจังหวัด (เหมาะสำหรับบอท/ป้ายไฟ) |
| [`/api/water-levels`](#2-get-apiwater-levels) | `GET` | ~15 ms | Public | รายการสถานีตรวจวัดระดับน้ำทั้งหมด พร้อมระยะพ้นตลิ่ง |
| [`/api/rainfall`](#3-get-apirainfall) | `GET` | ~15 ms | Public | รายการสถานีวัดน้ำฝนทั้งหมด พร้อมฝนสะสม 24 ชม. และ 1 ชม. |
| [`/api/water-levels/graph`](#4-get-apiwater-levelsgraph) | `GET` | ~12 ms (D1) | Public | ประวัติระดับน้ำย้อนหลัง (Time-series) และข้อมูลเทียบปีน้ำท่วม |
| [`/api/map-points`](#5-get-apimap-points) | `GET` | ~15 ms | Public | ข้อมูลพิกัดสถานีทั้งหมดสำหรับปักหมุดบนแผนที่ภายนอก |
| [`/api/amphoes`](#6-get-apiamphoes) | `GET` | ~5 ms | Public | รายชื่ออำเภอทั้งหมดใน จ.อุบลราชธานี ที่มีสถานีตรวจวัด |
| [`/api/health`](#7-get-apihealth) | `GET` | ~5 ms | Public | ตรวจสอบสถานะการทำงานของระบบ (Health Check) |
| `/api/admin/*` | `POST` | - | 🔒 Admin Token | คำสั่งจัดการระบบ (Sync D1 / Backfill) |

---

## 1. `GET /api/summary`
ดึงข้อมูลสรุปภาพรวมสถานการณ์น้ำและปริมาณฝนสะสมทั้งจังหวัดอุบลราชธานีในจุดเดียว เหมาะสำหรับการทำข้อความสรุปประจำวันของ LINE Bot หรือ Dashboard หน้าแรก

### Query Parameters
*ไม่มี*

### ตัวอย่าง Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "water": {
      "total": 19,
      "overflow": 0,
      "warning": 4,
      "normal": 15,
      "status": "warning"
    },
    "rainfall": {
      "total": 48,
      "activeRainStations": 12,
      "veryHeavy": 0,
      "heavy": 1,
      "max24h": {
        "amount": 42.5,
        "station": "อบต.ท่าลาด อ.วารินชำราบ"
      }
    },
    "updatedAt": "2026-09-07T08:30:00.000Z",
    "cacheStatus": "fresh"
  }
}
```

### การนำไปใช้:
- `data.water.overflow`: มีค่ามากกว่า `0` หมายถึง **มีสถานีน้ำเอ่อล้นตลิ่งแล้ว (ภาวะวิกฤต)**
- `data.water.warning`: จำนวนสถานีที่ระดับน้ำเหลือต่ำกว่าตลิ่งไม่เกิน 50 ซม.

---

## 2. `GET /api/water-levels`
ดึงรายการสถานีตรวจวัดระดับน้ำทั้งหมดในจังหวัดอุบลราชธานี พร้อมค่าระดับน้ำปัจจุบัน ระดับตลิ่ง และระยะพ้นตลิ่งที่คำนวณให้แบบ Real-time

### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :---: | :---: | :--- |
| `amphoe` | `string` | No | กรองเฉพาะอำเภอ เช่น `?amphoe=เมืองอุบลราชธานี` |
| `search` | `string` | No | ค้นหาตามชื่อสถานี, อำเภอ หรือลำน้ำ เช่น `?search=แม่น้ำมูล` |

### ตัวอย่าง Request
```bash
curl "https://water.ubon.online/api/water-levels?amphoe=เมืองอุบลราชธานี"
```

### ตัวอย่าง Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    {
      "station": {
        "id": 269,
        "nameTh": "สะพานเสรีประชาธิปไตย",
        "nameEn": "Seri Min Democracy Bridge",
        "amphoeNameTh": "เมืองอุบลราชธานี",
        "basinNameTh": "แม่น้ำมูล",
        "lat": 15.2285,
        "lon": 104.8587
      },
      "waterlevelMsl": 111.45,
      "minBankMsl": 112.00,
      "freeboardM": 0.55,
      "waterlevelLocalM": 4.20,
      "situationLevel": 3,
      "storagePercent": 78,
      "discharge": 850.5,
      "observedAt": "2026-09-07T08:20:00.000Z"
    }
  ],
  "total": 1
}
```

### ความหมายของตัวแปรสำคัญ:
- `waterlevelMsl` *(number)*: ระดับผิวน้ำเทียบระดับน้ำทะเลปานกลาง (ม.รทก.)
- `minBankMsl` *(number)*: ระดับความสูงของขอบตลิ่ง (ม.รทก.)
- `freeboardM` *(number)*: **ระยะพ้นตลิ่ง (เมตร)**
  - **ค่าติดลบ (< 0)**: น้ำล้นขอบตลิ่งเข้าท่วมพื้นที่แล้ว (เช่น `-0.35` คือล้นตลิ่ง 35 ซม.)
  - **0 ถึง 0.50**: เฝ้าระวังระดับน้ำสูงใกล้ล้นตลิ่ง
  - **> 0.50**: ระดับน้ำยังอยู่ในเกณฑ์ปกติ
- `situationLevel` *(1-5)*: ระดับความรุนแรงตามเกณฑ์ของ สสน. (4-5 = เตือนภัยวิกฤต)

---

## 3. `GET /api/rainfall`
ดึงรายการสถานีตรวจวัดปริมาณน้ำฝนสะสมทั่วจังหวัดอุบลราชธานี

### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :---: | :---: | :--- |
| `amphoe` | `string` | No | กรองเฉพาะอำเภอ |
| `search` | `string` | No | ค้นหาชื่อสถานีหรือพื้นที่ |

### ตัวอย่าง Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    {
      "station": {
        "id": 1045,
        "nameTh": "เทศบาลตำบลพิบูลมังสาหาร",
        "amphoeNameTh": "พิบูลมังสาหาร",
        "lat": 15.2458,
        "lon": 105.2289
      },
      "rain24h": 45.2,
      "rain1h": 12.0,
      "rainToday": 38.5,
      "observedAt": "2026-09-07T08:20:00.000Z"
    }
  ],
  "total": 48
}
```

### เกณฑ์การประเมินปริมาณฝน (`rain24h`):
- `≥ 90.0 มม.`: ฝนตกหนักมาก (Very Heavy) 🚨
- `35.0 - 89.9 มม.`: ฝนตกหนัก (Heavy) ⚠️
- `10.0 - 34.9 มม.`: ฝนปานกลาง (Moderate) 🌧️
- `0.1 - 9.9 มม.`: ฝนเล็กน้อย (Light) 🌦️
- `0.0 มม.`: ไม่มีฝน ☀️

---

## 4. `GET /api/water-levels/graph`
ดึงข้อมูลสถิติระดับน้ำย้อนหลังแบบ Time-series สำหรับพลอตกราฟ ให้บริการจากฐานข้อมูล **Cloudflare D1 Database (มีข้อมูลสะสมตั้งแต่ปี พ.ศ. 2562 ถึงปัจจุบัน มากกว่า 1.4 ล้านจุด)**

### Query Parameters
| Parameter | Type | Required | Default | Description |
| :--- | :---: | :---: | :---: | :--- |
| `station_id` | `number` | **Yes** | - | รหัสสถานีวัดน้ำ (เช่น `269`, `281`, `740540`) |
| `start_date` | `string` | **Yes** | - | วันที่เริ่มต้น (รูปแบบ `YYYY-MM-DD` หรือ `YYYY-MM-DD HH:mm`) |
| `end_date` | `string` | **Yes** | - | วันที่สิ้นสุด (รูปแบบ `YYYY-MM-DD` หรือ `YYYY-MM-DD HH:mm`) |

### ตัวอย่าง Request
```bash
# ดึงข้อมูลกราฟ 7 วันล่าสุดของสถานี 269
curl "https://water.ubon.online/api/water-levels/graph?station_id=269&start_date=2026-09-01&end_date=2026-09-07"

# ดึงข้อมูลเปรียบเทียบปีน้ำท่วมใหญ่ พ.ศ. 2562 (ค.ศ. 2019)
curl "https://water.ubon.online/api/water-levels/graph?station_id=269&start_date=2019-09-01&end_date=2019-09-07"
```

### ตัวอย่าง Response (`200 OK`)
```json
{
  "success": true,
  "source": "d1",
  "data": {
    "stationId": 269,
    "minBankMsl": 112.00,
    "warningLevelMsl": 111.50,
    "criticalLevelMsl": 112.00,
    "points": [
      {
        "observedAt": "2026-09-01T00:00:00.000Z",
        "waterlevelMsl": 110.85
      },
      {
        "observedAt": "2026-09-01T01:00:00.000Z",
        "waterlevelMsl": 110.88
      }
    ]
  }
}
```

---

## 5. `GET /api/map-points`
ดึงรายการพิกัดสถานีทั้งหมดแบบเบา (Lightweight Points) เหมาะสำหรับนำไปปักหมุดบนแผนที่ (Leaflet, Mapbox, Google Maps, OpenLayers)

### ตัวอย่าง Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    {
      "id": 269,
      "type": "water",
      "name": "สะพานเสรีประชาธิปไตย",
      "lat": 15.2285,
      "lon": 104.8587,
      "val": 111.45,
      "unit": "ม.รทก.",
      "status": "normal",
      "freeboard": 0.55
    },
    {
      "id": 1045,
      "type": "rain",
      "name": "เทศบาลตำบลพิบูลมังสาหาร",
      "lat": 15.2458,
      "lon": 105.2289,
      "val": 45.2,
      "unit": "มม.",
      "status": "heavy",
      "rain24h": 45.2
    }
  ]
}
```

---

## 6. `GET /api/amphoes`
ดึงรายชื่ออำเภอทั้งหมดใน จ.อุบลราชธานี ที่มีสถานีตรวจวัดติดตั้งอยู่

### ตัวอย่าง Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    "เมืองอุบลราชธานี",
    "วารินชำราบ",
    "พิบูลมังสาหาร",
    "เขื่องใน",
    "โขงเจียม",
    "ตระการพืชผล",
    "เดชอุดม"
  ]
}
```

---

## 7. `GET /api/health`
ใช้สำหรับตรวจสอบความพร้อมและสถานะการเชื่อมต่อฐานข้อมูลของระบบ (Uptime & Health monitoring)

### ตัวอย่าง Response (`200 OK`)
```json
{
  "status": "ok",
  "runtime": "Cloudflare Workers",
  "d1Available": true,
  "time": "2026-09-07T09:00:00.000Z"
}
```

---

## 🖼️ Standalone Embed Widget (ฝังภาพจำลองหน้าตัดน้ำลงเว็บอื่นด้วย `<iframe>`)

หากต้องการนำ **ภาพจำลองหน้าตัดลำน้ำ 2D (Cross-Section & Physics Animation)** พร้อมตัวเลขระดับน้ำจริงไปแสดงบนเว็บไซต์อื่น (เช่น เว็บข่าว, เทศบาล, อบจ. หรือบล็อก) สามารถคัดลอกโค้ด `<iframe>` ด้านล่างไปแปะได้ทันทีโดยไม่ต้องเขียนโค้ดเอง:

### 1. ฝังสถานี M.7 สะพานเสรีประชาธิปไตย (ค่าเริ่มต้น)
```html
<iframe 
  src="https://water.ubon.online/embed/cross-section?station_id=269" 
  width="100%" 
  height="380" 
  frameborder="0" 
  style="border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; max-width: 650px;"
  title="ภาพจำลองหน้าตัดระดับน้ำ M.7 สะพานเสรีประชาธิปไตย จ.อุบลราชธานี">
</iframe>
```

### 2. พารามิเตอร์ที่ปรับแต่งได้:
- `station_id`: รหัสสถานีที่ต้องการแสดง เช่น:
  - `269`: สะพานเสรีประชาธิปไตย อ.เมือง (M.7)
  - `281`: บ้านนาเยีย อ.นาเยีย (ลำโดมใหญ่)
  - `740540`: สะพานข้ามแม่น้ำมูล อ.เมือง
- `theme`: 
  - `auto` (ค่าเริ่มต้น): สลับสีตามธีมเครื่องผู้ใช้
  - `dark`: บังคับโหมดมืด (Dark Theme)
  - `light`: บังคับโหมดสว่าง (Light Theme)

*ตัวอย่างการบังคับโหมดมืด:*
```html
<iframe src="https://water.ubon.online/embed/cross-section?station_id=269&theme=dark" width="100%" height="380" frameborder="0"></iframe>
```

---

## 💻 ตัวอย่างโค้ดเรียกใช้งาน (Code Examples)

### JavaScript / TypeScript (Node.js หรือ Frontend)
```javascript
// ตรวจสอบสถานีที่มีความเสี่ยงน้ำล้นตลิ่ง
async function checkFloodRisk() {
  const res = await fetch("https://water.ubon.online/api/water-levels");
  const { data } = await res.json();

  const overflowingStations = data.filter(st => st.freeboardM !== null && st.freeboardM < 0);
  const warningStations = data.filter(st => st.freeboardM !== null && st.freeboardM >= 0 && st.freeboardM <= 0.5);

  console.log(`🚨 น้ำล้นตลิ่ง: ${overflowingStations.length} สถานี`);
  overflowingStations.forEach(s => {
    console.log(`- ${s.station.nameTh} (ล้นตลิ่ง ${Math.abs(s.freeboardM).toFixed(2)} ม.)`);
  });

  console.log(`⚠️ เฝ้าระวัง: ${warningStations.length} สถานี`);
}

checkFloodRisk();
```

### Python 3 (บอท / Automation / Data Science)
```python
import requests

def get_ubon_water_summary():
    url = "https://water.ubon.online/api/summary"
    response = requests.get(url, timeout=10)
    
    if response.status_code == 200:
        summary = response.json().get("data", {})
        water = summary.get("water", {})
        rain = summary.get("rainfall", {})
        
        message = (
            f"📊 สรุปสถานการณ์น้ำ จ.อุบลราชธานี\n"
            f"🚨 น้ำล้นตลิ่ง: {water.get('overflow', 0)} สถานี\n"
            f"⚠️ เฝ้าระวัง: {water.get('warning', 0)} สถานี\n"
            f"🌧️ จุดฝนตกหนักสุด 24 ชม.: {rain.get('max24h', {}).get('amount', 0)} มม. "
            f"({rain.get('max24h', {}).get('station', '-')})"
        )
        return message
    return "ไม่สามารถดึงข้อมูลได้"

print(get_ubon_water_summary())
```

### cURL
```bash
# ตรวจสอบสรุปสถิติประจำวัน
curl -s https://water.ubon.online/api/summary | jq .

# ตรวจระดับน้ำเฉพาะใน อ.วารินชำราบ
curl -s "https://water.ubon.online/api/water-levels?amphoe=%E0%B8%A7%E0%B8%B2%E0%B8%A3%E0%B8%B4%E0%B8%99%E0%B8%8A%E0%B8%B3%E0%B8%A3%E0%B8%B2%E0%B8%9A" | jq .
```

---

## ⚡ อัตราการเรียกใช้งาน & แคช (Rate Limit & Caching)
- **อัตราการอัปเดตข้อมูลต้นทาง**: ทุก 5 นาที ตามรอบ Cron ของ Worker
- **Cache-Control Header**: 
  - ข้อมูลปัจจุบัน (`/api/water-levels`, `/api/rainfall`, `/api/summary`): แคชที่ Edge CDN นาน **60 วินาที**
  - ข้อมูลกราฟย้อนหลัง (`/api/water-levels/graph`): แคชที่ Edge CDN นาน **300 วินาที (5 นาที)**
- **Fair Use**: ใช้งานได้ฟรี ไม่มีค่าใช้จ่าย สำหรับงานสาธารณประโยชน์, การวิจัย, ชุมชน และหน่วยงานราชการ/ท้องถิ่น (แนะนำให้ตั้งรอบดึงข้อมูลทุก 1-5 นาที)

---

## 🛠️ แหล่งข้อมูลและลิขสิทธิ์
- **แหล่งข้อมูลต้นทาง**: [สถาบันสารสนเทศทรัพยากรน้ำ (องค์การมหาชน) - HII](https://www.hii.or.th) ผ่าน ThaiWater API v3
- **ผู้พัฒนาระบบให้บริการ API**: [UBONWATCH (water.ubon.online)](https://water.ubon.online)
