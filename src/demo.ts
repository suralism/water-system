import {
  fetchWaterLevel,
  fetchRainfall,
  fetchWaterLevelGraph,
  ThaiWaterService,
} from "./index.js";

async function main() {
  console.log("==================================================");
  console.log("🌊 ThaiWater Ingestion & Service Demo");
  console.log("==================================================\n");

  const service = new ThaiWaterService({
    ttlMs: 5 * 60 * 1000, // แคช 5 นาที
  });

  try {
    console.log("1. กำลังดึงข้อมูลระดับน้ำ (Water Level Snapshot)...");
    const waterLevels = await service.getWaterLevel();
    console.log(`   ✅ โหลดข้อมูลสำเร็จ: พบสถานีระดับน้ำทั้งหมด ${waterLevels.length} สถานี`);
    if (waterLevels.length > 0) {
      console.log("   📌 ตัวอย่างสถานีแรก:");
      console.log(JSON.stringify(waterLevels[0], null, 2));
    }

    console.log("\n2. กำลังดึงข้อมูลปริมาณน้ำฝน (Rainfall Snapshot)...");
    const rainfalls = await service.getRainfall();
    console.log(`   ✅ โหลดข้อมูลสำเร็จ: พบสถานีน้ำฝนทั้งหมด ${rainfalls.length} สถานี`);
    if (rainfalls.length > 0) {
      console.log("   📌 ตัวอย่างสถานีแรก:");
      console.log(JSON.stringify(rainfalls[0], null, 2));
    }

    // ทดสอบดึงตามจังหวัด (เช่น กทม. provinceCode: "10" หรือ เชียงใหม่ "50")
    console.log("\n3. ทดสอบกรองสถานีตามจังหวัด (เชียงใหม่ - รหัส 50)...");
    const cmStations = await service.getWaterLevelsByProvince("50");
    console.log(`   ✅ สถานีระดับน้ำใน จ.เชียงใหม่: ${cmStations.length} สถานี`);
    if (cmStations.length > 0) {
      const s = cmStations[0];
      console.log(`   -> [${s.station.id}] ${s.station.nameTh} (${s.station.amphoeNameTh}) | ระดับน้ำ: ${s.waterlevelMsl} ม.รทก. | ระยะพ้นตลิ่ง: ${s.freeboardM ?? "N/A"} ม.`);
    }

    // ทดสอบดึง Time-series Graph
    if (waterLevels.length > 0) {
      const sampleStationId = waterLevels[0].station.id;
      const today = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const yyyy = today.getFullYear();
      const mm = pad(today.getMonth() + 1);
      const dd = pad(today.getDate());
      const startDate = `${yyyy}-${mm}-${dd}`;
      const endDate = `${yyyy}-${mm}-${dd} 23:59`;

      console.log(`\n4. ทดสอบดึง Time-series Graph สำหรับ Station ID: ${sampleStationId}...`);
      try {
        const graphData = await service.getWaterLevelGraph({
          stationId: sampleStationId,
          startDate,
          endDate,
        });
        console.log(`   ✅ ได้รับจุดกราฟจำนวน ${graphData.points.length} จุด`);
        if (graphData.points.length > 0) {
          console.log("   📌 ตัวอย่างจุดข้อมูลกราฟล่าสุด:");
          console.log(JSON.stringify(graphData.points[graphData.points.length - 1], null, 2));
        }
      } catch (err: any) {
        console.log(`   ⚠️ ไม่สามารถดึงกราฟของสถานี ${sampleStationId} ได้: ${err.message}`);
      }
    }

    console.log("\n5. ตรวจสอบสถานะ In-memory Cache...");
    console.log(service.getCacheStatus());

    console.log("\n✨ ทำงานเสร็จสมบูรณ์เรียบร้อย!");
  } catch (err) {
    console.error("เกิดข้อผิดพลาดในการรัน Demo:", err);
  }
}

main();
