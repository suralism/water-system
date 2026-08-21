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
    console.log(`   ✅ โหลดข้อมูลสำเร็จ: พบสถานีระดับน้ำทั้งหมด ${waterLevels.length} สถานี:`);
    waterLevels.forEach((w, i) => {
      console.log(`   [${i + 1}] ID: ${w.station.id} | ${w.station.nameTh} | อ.${w.station.amphoeNameTh} | ลุ่มน้ำ: ${w.station.basinNameTh}`);
    });

    console.log("\n=== Testing River Matchers ===");
    const testRivers = [
      {
        id: "mun",
        name: "แม่น้ำมูล (M.7)",
        matcher: (w: any) => [3543, 2752, 11688911].includes(w.station.id) || (w.station.nameTh && (w.station.nameTh.includes("M.7") || w.station.nameTh.includes("เสรีประชาธิปไตย"))),
      },
      {
        id: "chi",
        name: "แม่น้ำชี (เขื่องใน)",
        matcher: (w: any) => [269, 504940, 11688876].includes(w.station.id) || (w.station.basinNameTh && w.station.basinNameTh.includes("ชี")),
      },
      {
        id: "sebai",
        name: "ลำเซบาย / ลำเซบก",
        matcher: (w: any) => [11688743, 504962, 11688888].includes(w.station.id) || (w.station.nameTh && (w.station.nameTh.includes("เซบาย") || w.station.nameTh.includes("เซบก") || w.station.nameTh.includes("ป่าก่อ"))),
      },
      {
        id: "domyai",
        name: "ลำโดมใหญ่",
        matcher: (w: any) => [3533, 2707, 11688882].includes(w.station.id) || (w.station.nameTh && (w.station.nameTh.includes("โดมใหญ่") || w.station.nameTh.includes("นาเยีย") || w.station.nameTh.includes("คำสำราญ"))),
      },
      {
        id: "khong",
        name: "โขงเจียม / ปากมูล",
        matcher: (w: any) => [740540, 3544].includes(w.station.id) || (w.station.amphoeNameTh && w.station.amphoeNameTh.includes("โขงเจียม")),
      }
    ];

    testRivers.forEach(r => {
      const match = waterLevels.find(r.matcher);
      if (match) {
        console.log(`✅ ${r.name} -> Match: [ID ${match.station.id}] ${match.station.nameTh} (${match.station.amphoeNameTh}) | ระดับน้ำ: ${match.waterlevelMsl} ม.รทก. | พ้นตลิ่ง: ${match.freeboardM}`);
      } else {
        console.error(`❌ ${r.name} -> NOT FOUND!`);
      }
    });

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
