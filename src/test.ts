import { toIso, fetchWaterLevel, fetchRainfall, fetchWaterLevelGraph } from "./thaiwater.js";
import { ThaiWaterService } from "./cache-service.js";
import assert from "node:assert/strict";

async function runTests() {
  console.log("=== 1. Testing toIso() Timezone Conversions ===");
  const iso1 = toIso("2026-08-21 09:00");
  assert.equal(iso1, "2026-08-21T02:00:00.000Z", "Should convert +07:00 to UTC correctly");
  
  const iso2 = toIso("2026-08-21 09:00:00");
  assert.equal(iso2, "2026-08-21T02:00:00.000Z", "Should convert full timestamp correctly");

  assert.equal(toIso(""), null, "Empty string should return null");
  assert.equal(toIso(null), null, "Null should return null");
  assert.equal(toIso(undefined), null, "Undefined should return null");
  console.log("✔ toIso() tests passed.");

  console.log("\n=== 2. Testing Graph API URL & Encoding (%20 for space) ===");
  let capturedUrl = "";
  const mockFetch: typeof fetch = async (input: any) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ data: { graph_data: [] } }), { status: 200 });
  };

  await fetchWaterLevelGraph(
    {
      stationId: 123,
      startDate: "2026-08-20",
      endDate: "2026-08-21 09:00",
    },
    { fetchFn: mockFetch }
  );

  assert.ok(capturedUrl.includes("end_date=2026-08-21%2009:00"), `URL must encode space as %20. Got: ${capturedUrl}`);
  assert.ok(!capturedUrl.includes("end_date=2026-08-21+09:00"), "URL must NOT encode space as +");
  console.log("✔ Graph URL Encoding tests passed.");

  console.log("\n=== 3. Testing Water Level Edge Cases (min_bank <= 0, (0,0) coords, etc.) ===");
  const mockWaterLevelPayload = {
    waterlevel_data: {
      data: [
        // Case A: Normal station with min_bank
        {
          id: 1,
          waterlevel_msl: "15.5",
          waterlevel_m: "3.2",
          waterlevel_datetime: "2026-08-21 09:00",
          situation_level: 2,
          station: {
            id: 101,
            tele_station_lat: "18.78",
            tele_station_long: "98.98",
            min_bank: "20.0",
            tele_station_name: { th: "สถานีทดสอบ 1", en: "Test Station 1" }
          },
          geocode: {
            province_code: 50,
            province_name: { th: "เชียงใหม่" },
            amphoe_name: { th: "เมืองเชียงใหม่" }
          }
        },
        // Case B: min_bank <= 0 (Should be null, freeboardM should be null)
        {
          id: 2,
          waterlevel_msl: "10.0",
          waterlevel_m: "2.0",
          waterlevel_datetime: "2026-08-21 09:00",
          station: {
            id: 102,
            tele_station_lat: "13.75",
            tele_station_long: "100.50",
            min_bank: 0,
            tele_station_name: { th: "สถานีทดสอบ 2", en: "Test Station 2" }
          },
          geocode: {
            province_code: "10",
            province_name: { th: "กรุงเทพมหานคร" }
          }
        },
        // Case C: Invalid coordinates (0, 0) -> Should be dropped
        {
          id: 3,
          waterlevel_msl: "5.0",
          station: {
            id: 103,
            tele_station_lat: 0,
            tele_station_long: 0,
            min_bank: 10
          }
        },
        // Case D: Null coordinates -> Should be dropped
        {
          id: 4,
          waterlevel_msl: "5.0",
          station: {
            id: 104,
            tele_station_lat: null,
            tele_station_long: null
          }
        }
      ]
    }
  };

  const mockWaterLevelFetch: typeof fetch = async () => {
    return new Response(JSON.stringify(mockWaterLevelPayload), { status: 200 });
  };

  const parsedWL = await fetchWaterLevel({ fetchFn: mockWaterLevelFetch, targetProvinceCode: null });
  assert.equal(parsedWL.length, 2, "Should drop stations with (0,0) or null coordinates");
  
  // Verify Case A
  assert.equal(parsedWL[0].station.provinceCode, "50", "Province code 50 should be string '50'");
  assert.equal(parsedWL[0].minBankMsl, 20.0);
  assert.equal(parsedWL[0].freeboardM, 4.5, "freeboardM = 20.0 - 15.5 = 4.5");
  assert.equal(parsedWL[0].observedAt, "2026-08-21T02:00:00.000Z");

  // Verify Case B (min_bank = 0 -> null)
  assert.equal(parsedWL[1].minBankMsl, null, "min_bank = 0 should be normalized to null");
  assert.equal(parsedWL[1].freeboardM, null, "freeboardM should be null when minBankMsl is null");
  console.log("✔ Water Level parsing & edge-case tests passed.");

  console.log("\n=== 4. Testing ThaiWaterService Cache & Deduplication ===");
  let callCount = 0;
  const countingFetch: typeof fetch = async (url: any) => {
    callCount++;
    if (String(url).includes("waterlevel_load")) {
      return new Response(JSON.stringify(mockWaterLevelPayload), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const service = new ThaiWaterService({ ttlMs: 1000 }, { fetchFn: countingFetch, targetProvinceCode: null });
  
  // Concurrent calls should be deduplicated (single-flight)
  const [resA, resB] = await Promise.all([
    service.getWaterLevel(),
    service.getWaterLevel()
  ]);

  assert.equal(callCount, 1, "Concurrent requests should only fetch once");
  assert.equal(resA.length, 2);
  assert.equal(resB.length, 2);

  // Cached call
  await service.getWaterLevel();
  assert.equal(callCount, 1, "Subsequent call within TTL should return cached data");

  console.log("✔ Cache & Deduplication tests passed.");

  console.log("\n=== 5. Testing Station Data Deduplication (RID Dual-Feed & Multi-Agency) ===");
  const mockDuplicatePayload = {
    waterlevel_data: {
      data: [
        // Duplicate Pair 1: Primary Feed (Fresh date, valid min_bank)
        {
          id: 1001,
          waterlevel_msl: "108.39",
          waterlevel_m: "3.20",
          waterlevel_datetime: "2026-08-21 22:00",
          situation_level: 2,
          station: {
            id: 2752,
            tele_station_oldcode: "M.7",
            tele_station_lat: "15.222630",
            tele_station_long: "104.859131",
            min_bank: "112.0",
            tele_station_name: { th: "สะพานเสรีประชาธิปไตย", en: "Seri Bridge" }
          },
          agency: { agency_shortname: { th: "ชป." } },
          geocode: { province_code: 34, province_name: { th: "อุบลราชธานี" } }
        },
        // Duplicate Pair 1: Secondary Feed (Stale date, min_bank = 0)
        {
          id: 1002,
          waterlevel_msl: "108.06",
          waterlevel_m: "3.10",
          waterlevel_datetime: "2026-08-19 16:00",
          situation_level: 2,
          station: {
            id: 11688911,
            tele_station_oldcode: "ridhydro_M.7",
            tele_station_lat: "15.222628",
            tele_station_long: "104.859130",
            min_bank: 0,
            tele_station_name: { th: "สะพานเสรีประชาธิปไตย", en: "Seri Bridge" }
          },
          agency: { agency_shortname: { th: "ชป." } },
          geocode: { province_code: 34, province_name: { th: "อุบลราชธานี" } }
        },
        // Multi-agency Case: Station A at Piboon Bridge (RID)
        {
          id: 1003,
          waterlevel_msl: "107.79",
          waterlevel_m: "2.50",
          waterlevel_datetime: "2026-08-21 22:00",
          situation_level: 2,
          station: {
            id: 2755,
            tele_station_oldcode: "M.11B",
            tele_station_lat: "15.249920",
            tele_station_long: "105.239243",
            min_bank: "112.0",
            tele_station_name: { th: "บ้านโพธิ์ตาก", en: "Ban Pho Tak" }
          },
          agency: { agency_shortname: { th: "ชป." } },
          geocode: { province_code: 34, province_name: { th: "อุบลราชธานี" } }
        },
        // Multi-agency Case: Station B at Piboon Bridge (HII / สสน. - 24 meters apart, different name)
        {
          id: 1004,
          waterlevel_msl: "107.54",
          waterlevel_m: "2.40",
          waterlevel_datetime: "2026-08-21 23:30",
          situation_level: 2,
          station: {
            id: 281,
            tele_station_oldcode: "MUN011",
            tele_station_lat: "15.249705",
            tele_station_long: "105.239300",
            min_bank: "112.41",
            tele_station_name: { th: "พิบูลมังสาหาร", en: "Phibun Mangsahan" }
          },
          agency: { agency_shortname: { th: "สสน." } },
          geocode: { province_code: 34, province_name: { th: "อุบลราชธานี" } }
        }
      ]
    }
  };

  const mockDedupeFetch: typeof fetch = async () => {
    return new Response(JSON.stringify(mockDuplicatePayload), { status: 200 });
  };

  const dedupedResults = await fetchWaterLevel({
    fetchFn: mockDedupeFetch,
    targetProvinceCode: "34",
    deduplicate: true,
  });

  // Out of 4 items:
  // - 2752 vs 11688911 (M.7 vs ridhydro_M.7) should be merged to 1 station (keeping 2752 with min_bank 112 & latest date)
  // - 2755 (บ้านโพธิ์ตาก) and 281 (พิบูลมังสาหาร) are distinct agencies/names, so both must be preserved!
  // Total resulting stations should be 3
  assert.equal(dedupedResults.length, 3, "Deduplication should merge duplicate RID feed and retain distinct multi-agency stations");

  const seriStation = dedupedResults.find((s) => s.station.nameTh?.includes("สะพานเสรีประชาธิปไตย"));
  assert.ok(seriStation, "Seri Bridge station must exist");
  assert.equal(seriStation?.station.id, 2752, "Must choose primary station ID (2752) over stale feed (11688911)");
  assert.equal(seriStation?.minBankMsl, 112.0, "Must retain valid minBankMsl (112.0)");
  assert.equal(seriStation?.observedAt, "2026-08-21T15:00:00.000Z", "Must retain latest observation timestamp");

  const phoTakStation = dedupedResults.find((s) => s.station.nameTh?.includes("บ้านโพธิ์ตาก"));
  const phibunStation = dedupedResults.find((s) => s.station.nameTh?.includes("พิบูลมังสาหาร"));
  assert.ok(phoTakStation, "Ban Pho Tak (RID) must be preserved");
  assert.ok(phibunStation, "Phibun Mangsahan (HII) must be preserved");

  console.log("✔ Station Data Deduplication tests passed.");

  console.log("\n🎉 ALL UNIT & INTEGRATION LOGIC TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
