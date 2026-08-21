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
  console.log("\n🎉 ALL UNIT & INTEGRATION LOGIC TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
