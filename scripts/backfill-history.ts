/**
 * Full History Backfill Script
 * ดึงข้อมูลระดับน้ำย้อนหลังทุกปีจาก ThaiWater API แล้วเขียนลง Cloudflare D1
 * ผ่าน `wrangler d1 execute --file` เป็นชุดๆ (INSERT OR IGNORE ป้องกันข้อมูลซ้ำ)
 *
 * หมายเหตุด้านความปลอดภัย: คำสั่ง execFileSync ใช้ string literal ล้วน (โปรแกรม, ชื่อ DB,
 * flags และ path ของไฟล์ SQL เป็น literal path คงที่ที่ถูก overwrite ทุก chunk)
 * — ไม่มี dynamic CLI argument เด็ดขาด จึงปลอดภัยจาก option injection
 *
 * ต้องรันจาก root ของโปรเจกต์เท่านั้น (เช่นผ่าน npm script)
 *
 * ใช้งาน: tsx scripts/backfill-history.ts [startYear] [--local]
 *   tsx scripts/backfill-history.ts 2019          → เขียนลง D1 production (remote)
 *   tsx scripts/backfill-history.ts 2019 --local  → เขียนลง local D1 (ของ wrangler dev)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fetchWaterLevel, fetchWaterLevelGraph } from "../src/thaiwater.js";

const localMode = process.argv.includes("--local");
const yearArg = process.argv.slice(2).find((a) => a !== "--local");
const START_YEAR = Number(yearArg ?? "2019");
const CHUNK_DIR = ".backfill-tmp";
const ROWS_PER_STATEMENT = 100; // จุดข้อมูลต่อ 1 ประโยค INSERT
const STATEMENTS_PER_FILE = 50; // ประโยคต่อ 1 ไฟล์ (5,000 rows/ไฟล์)

const pad = (n: number) => String(n).padStart(2, "0");
const q = (v: unknown) => (v === null || v === undefined ? "NULL" : String(v));

function sqlStr(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function executeChunk(): void {
  // ทุก argument เป็น string literal — ไม่มีค่า dynamic ที่ตีความเป็น option ได้
  if (localMode) {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "ubonwater-db", "--local", "-y", "--file", ".backfill-tmp/chunk.sql"],
      { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }
    );
  } else {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "ubonwater-db", "--remote", "-y", "--file", ".backfill-tmp/chunk.sql"],
      { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }
    );
  }
}

async function main() {
  console.log(`=== Full History Backfill (ปี ${START_YEAR} → ปัจจุบัน) → ${localMode ? "LOCAL D1" : "REMOTE D1 (production)"} ===\n`);

  // 1. ดึงรายการสถานีทั้งหมดของ จ.อุบลราชธานี
  const stations = await fetchWaterLevel({ targetProvinceCode: "34", deduplicate: true });
  console.log(`พบสถานีทั้งหมด ${stations.length} สถานี\n`);

  mkdirSync(CHUNK_DIR, { recursive: true });
  const nowIso = new Date().toISOString();

  const currentYear = new Date().getFullYear();
  let totalRows = 0;
  let buffer: string[] = [];
  let chunkCount = 0;

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const statements: string[] = [];
    for (let i = 0; i < buffer.length; i += ROWS_PER_STATEMENT) {
      const rows = buffer.slice(i, i + ROWS_PER_STATEMENT);
      statements.push(
        `INSERT OR IGNORE INTO water_level_history (station_id, observed_at, waterlevel_msl, waterlevel_local_m, freeboard_m, situation_level, storage_percent, discharge, created_at) VALUES\n  ${rows.join(",\n  ")};`
      );
    }
    writeFileSync(".backfill-tmp/chunk.sql", statements.join("\n"));
    try {
      executeChunk();
      totalRows += buffer.length;
      console.log(`  ✅ chunk #${chunkCount}: บันทึกแล้ว ${totalRows} rows สะสม`);
    } catch (err: any) {
      console.error(`  ❌ chunk #${chunkCount} ล้มเหลว:`, err.stderr?.toString()?.slice(0, 500) || err.message);
    }
    chunkCount++;
    buffer = [];
  };

  for (let year = START_YEAR; year <= currentYear; year++) {
    const startDate = `${year}-01-01`;
    const endDate =
      year === currentYear
        ? `${currentYear}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())} ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`
        : `${year}-12-31 23:59`;

    console.log(`\n📅 ปี ${year} (${startDate} → ${endDate})`);

    for (const st of stations) {
      let points: Awaited<ReturnType<typeof fetchWaterLevelGraph>>["points"] = [];
      let minBank: number | null = null;
      try {
        const graph = await fetchWaterLevelGraph({ stationId: st.station.id, startDate, endDate });
        points = graph.points;
        minBank = graph.minBankMsl ?? st.minBankMsl ?? null;
      } catch (err: any) {
        console.error(`  ⚠️ สถานี ${st.station.id} (${st.station.nameTh}): ${err.message}`);
        continue;
      }

      let rowsForStation = 0;
      for (const p of points) {
        if (!p.observedAt) continue;
        if (p.waterlevelMsl === null && p.discharge === null) continue; // ข้าม grid ช่องว่าง
        const freeboard =
          minBank !== null && p.waterlevelMsl !== null
            ? Math.round((minBank - p.waterlevelMsl) * 100) / 100
            : null;
        buffer.push(
          `(${q(st.station.id)}, ${sqlStr(p.observedAt)}, ${q(p.waterlevelMsl)}, ${q(p.waterlevelLocalM)}, ${q(freeboard)}, ${q(p.situationLevel ?? null)}, NULL, ${q(p.discharge)}, ${sqlStr(nowIso)})`
        );
        rowsForStation++;
      }

      console.log(`  • สถานี ${st.station.id} ${st.station.nameTh}: ${rowsForStation} จุดข้อมูล`);
      if (buffer.length >= ROWS_PER_STATEMENT * STATEMENTS_PER_FILE) flushBuffer();
    }
  }

  flushBuffer();
  rmSync(CHUNK_DIR, { recursive: true, force: true });
  console.log(`\n🎉 เสร็จสมบูรณ์! บันทึกทั้งหมด ${totalRows} rows (${chunkCount} chunks SQL)`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
