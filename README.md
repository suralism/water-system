# 🌊 UBONWATCH / ThaiWater Ingestion & Alert System

ระบบติดตามและเตือนภัยระดับน้ำ & ปริมาณน้ำฝนแบบ Real-time พัฒนาบน **Cloudflare Workers (Edge Serverless) + Cloudflare D1 (SQLite Database)** เชื่อมต่อข้อมูลจาก **ThaiWater API v3** (สถาบันสารสนเทศทรัพยากรน้ำ - HII)

---

## 📦 ฟีเจอร์หลักของระบบ (Key Features)

1. **🗺️ Interactive Web GIS Map:**
   * แผนที่ระดับน้ำและปริมาณน้ำฝนสด พร้อมระบบ Marker Clustering และสลับ Base Map หลากหลายแบบ
   * 🌧️ **เรดาร์กลุ่มฝนสด (Rain Radar Layer):** เชื่อมต่อภาพเรดาร์ตรวจอากาศแบบ Real-time
   * 📍 **วิเคราะห์ความเสี่ยงใกล้บ้าน (GPS Near Me):** ตรวจหาตำแหน่งผู้ใช้และสรุปสถานะสถานีน้ำและน้ำฝนที่ใกล้ที่สุดทันที
2. **🌊 แบบจำลองหน้าตัดตลิ่ง 2D (Cross-Section & Physics Simulator):**
   * กราฟิกจำลองการขึ้น-ลงของระดับน้ำเทียบกับตลิ่งจริง
   * สไลเดอร์จำลองมวลน้ำเพิ่มขึ้น/ลดลงแบบ Interactive
3. **📈 กราฟระดับน้ำย้อนหลัง + Cloudflare D1 Cache:**
   * เก็บประวัติระดับน้ำและน้ำฝนย้อนหลังลง **D1 SQLite** แบบ Idempotent Upsert (ป้องกันข้อมูลซ้ำซ้อน 100%)
   * ดึงกราฟย้อนหลัง 24 ชม., 48 ชม., 7 วัน, 15 วัน, 30 วัน รวดเร็วระดับ $\le 15$ ms
   * มี **Cron Trigger (`*/5 * * * *`)** ซิงค์ข้อมูลล่าสุดอัตโนมัติทุก 5 นาที
4. **📸 Social Share Infographic Card Generator:**
   * สร้างภาพสรุปสถานการณ์น้ำระดับ **HD (1200 × 675 px / สัดส่วน 16:9)** ด้วย HTML Canvas
   * ฝังโลโก้หน่วยงาน, ตัวเลขสถิติ KPI, สถานีแม่น้ำสำคัญ, จุดฝนตกหนัก พร้อมลายน้ำเว็บไซต์ สำหรับแชร์ลง LINE / Facebook / Twitter
5. **⚡ Smart Caching & Request Deduplication (Single-Flight):**
   * ป้องกันการยิง API ต้นทางซ้ำซ้อน รองรับผู้ใช้งานพร้อมกันจำนวนมากได้อย่างลื่นไหล

---

## 🚀 การติดตั้งและรันในเครื่อง (Local Development)

```bash
# 1. ติดตั้ง Dependencies
npm install

# 2. ทดสอบระบบ Unit Tests & Database
npm test
npm run test:db

# 3. รันเซิร์ฟเวอร์ Local Dev
npm run dev
# เข้าใช้งานที่: http://127.0.0.1:8787
```

---

## 🏢 ขั้นตอนการ Fork / Clone ไป Deploy ให้หน่วยงานหรือจังหวัดอื่น

ระบบถูกออกแบบให้เป็น **Multi-tenant / Configurable** สามารถนำไปประยุกต์ใช้กับจังหวัดหรือลุ่มน้ำอื่นๆ ได้อย่างง่ายดาย:

### ขั้นตอนที่ 1: เตรียมฐานข้อมูล Cloudflare D1 ใหม่
1. สร้างฐานข้อมูล D1 ใหม่บน Cloudflare:
   ```bash
   npx wrangler d1 create <agency>-water-db
   ```
   *(จะได้รับ `database_id` เช่น `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)*
2. แก้ไขไฟล์ `wrangler.toml`:
   ```toml
   name = "<agency>-water-system"  # ชื่อ Worker ของหน่วยงาน

   [[d1_databases]]
   binding = "DB"
   database_name = "<agency>-water-db"
   database_id = "ใส่-database_id-ที่ได้จากข้อ-1"

   # (กรณีมี Custom Domain)
   # routes = [
   #   { pattern = "water.youragency.go.th", custom_domain = true }
   # ]
   ```
3. รัน Migration เพื่อสร้างโครงสร้างตาราง (Schema):
   ```bash
   npx wrangler d1 execute <agency>-water-db --remote --file=./schema.sql
   ```

---

### ขั้นตอนที่ 2: ปรับเปลี่ยนจังหวัด/พิกัดพื้นที่เป้าหมาย
1. **Backend (`src/thaiwater.ts`):**
   * ปรับเงื่อนไขการกรองจังหวัด `provinceCode` หรือชื่อจังหวัดเป้าหมาย
2. **Frontend (`public/app.js`):**
   * **พิกัดศูนย์กลางแผนที่:** แก้ไขค่า `UBON_COORDS = [lat, lon]` ให้ตรงกับจังหวัดใหม่
   * **แถบ 5 แม่น้ำสายหลัก (`MAIN_RIVERS`):** ปรับชื่อแม่น้ำและรหัสสถานีสำคัญให้ตรงกับพื้นที่ใหม่
   * **ลายน้ำบนการ์ด Infographic:** เปลี่ยนโดเมนท้ายการ์ดให้เป็นเว็บของหน่วยงานใหม่

---

### ขั้นตอนที่ 3: ปรับเปลี่ยนโลโก้ & แบรนดิ้ง (Branding)
1. นำไฟล์ภาพโลโก้ของหน่วยงานมาวางทับที่:
   * `public/logo.jpg` (หรือ `.png`)
2. แก้ไขชื่อระบบ, สโลแกน และ OpenGraph Meta Tags ใน:
   * `public/index.html` (แถบ Navbar, `<title>`, `<meta property="og:...">`)
   * `public/app.js` (ในฟังก์ชัน `generateSnapshotCard()`)

---

### ขั้นตอนที่ 4: Build & Deploy ขึ้น Cloudflare Production
1. Build TypeScript:
   ```bash
   npm run build
   ```
2. Deploy ไปยัง Cloudflare:
   ```bash
   npm run deploy
   ```
3. **ดึงข้อมูลประวัติย้อนหลัง 30 วันเข้าฐานข้อมูล (ครั้งแรก):**
   ```bash
   curl -X POST https://<worker-subdomain>.workers.dev/api/admin/backfill-graphs?days=30
   ```

---

## 📡 สรุป API Endpoints

| Endpoint | Method | คำอธิบาย |
| :--- | :---: | :--- |
| `/api/water-levels` | `GET` | รายการสถานีวัดระดับน้ำทั้งหมด พร้อมระยะพ้นตลิ่งและสถานะความเสี่ยง |
| `/api/rainfall` | `GET` | รายการสถานีวัดน้ำฝนทั้งหมด พร้อมปริมาณฝนสะสม 24 ชม. และ 1 ชม. |
| `/api/amphoes` | `GET` | รายชื่ออำเภอที่มีการติดตั้งสถานีตรวจวัด |
| `/api/water-levels/graph?station_id=XX&days=N` | `GET` | ข้อมูลกราฟระดับน้ำย้อนหลัง $N$ วัน (ดึงจาก D1 Database ความเร็วสูง) |
| `/api/admin/sync-d1` | `POST` | สั่งซิงค์ Snapshot ปัจจุบันลง D1 ทันที |
| `/api/admin/backfill-graphs?days=30` | `POST` | ดึงข้อมูลประวัติย้อนหลังทุกสถานีเข้าเก็บใน D1 |

---

## 🗄️ โครงสร้างฐานข้อมูล (D1 SQLite Schema)

* **`stations`:** ตารางข้อมูลสถานีตรวจวัด (ID, ชื่อไทย/อังกฤษ, ละติจูด, ลองจิจูด, รหัสจังหวัด, อำเภอ, ลุ่มน้ำ)
* **`water_level_history`:** ประวัติระดับน้ำแบบ Time-series (Primary Key: `station_id + observed_at`)
* **`rainfall_history`:** ประวัติปริมาณน้ำฝนสะสมแบบ Time-series (Primary Key: `station_id + observed_at`)

---

## 📄 แหล่งข้อมูลอ้างอิง
* **สถาบันสารสนเทศทรัพยากรน้ำ (องค์การมหาชน) - HII:** [https://www.hii.or.th](https://www.hii.or.th)
* **ThaiWater Open API v3:** [https://api-v3.thaiwater.net](https://api-v3.thaiwater.net)

