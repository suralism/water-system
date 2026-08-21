// ThaiWater Live Dashboard - จังหวัดอุบลราชธานี (เฉพาะพื้นที่เพื่อความเร็วสูงสุด)

let map;
let markerClusterGroup;
let allWaterLevels = [];
let allRainfalls = [];
let filteredWaterLevels = [];
let filteredRainfalls = [];

// Modes & Filters
let currentMode = "water"; // "water" (สถานีระดับน้ำ) หรือ "rain" (สถานีวัดน้ำฝน)
let currentView = "map";   // "map" หรือ "table"
let currentAmphoe = "";    // กรองตามอำเภอใน จ.อุบลฯ
let currentSearchQuery = "";

let currentWaterFilter = "all"; // "all" | "overflow" | "warning" | "normal"
let currentRainFilter = "all";  // "all" | "very-heavy" | "heavy" | "has-rain"

// Center coordinates for Ubon Ratchathani
const UBON_COORDS = [15.2448, 104.8473];

// Pagination
let currentPage = 1;
const PAGE_SIZE = 15;

// Chart instance
let waterChart = null;
let currentModalStation = null;
let chartRangeDays = 1;

// Auto Refresh Timer (5 นาที)
const REFRESH_INTERVAL_SEC = 300;
let remainingSeconds = REFRESH_INTERVAL_SEC;
let countdownTimerInterval = null;

/**
 * แปลงระยะพ้นตลิ่ง:
 * - ถ้าค่าสัมบูรณ์ < 1.0 เมตร (ไม่ถึง 1 เมตร) -> แสดงเป็น เซนติเมตร (ซม.) เช่น 6 ซม., -6 ซม.
 * - ถ้าค่าสัมบูรณ์ >= 1.0 เมตร -> แสดงเป็น เมตร (ม.) เช่น 4.89 ม., +4.89 ม., -1.20 ม.
 */
function formatFreeboard(val, options = {}) {
  if (val === null || val === undefined || isNaN(val)) return "-";
  const num = Number(val);
  const abs = Math.abs(num);
  const withSign = options.withSign ?? false;
  const absOnly = options.absOnly ?? false;
  const isNeg = num < 0;

  if (abs < 1.0) {
    const cm = Math.round(abs * 100);
    const sign = withSign ? (isNeg ? "-" : "+") : (isNeg ? "-" : "");
    const formattedNum = absOnly ? `${cm}` : `${sign}${cm}`;
    return options.returnObject
      ? { num: formattedNum, unit: "ซม.", val: cm }
      : `${formattedNum} ซม.`;
  } else {
    const m = abs.toFixed(2);
    const sign = withSign ? (isNeg ? "-" : "+") : (isNeg ? "-" : "");
    const formattedNum = absOnly ? `${m}` : `${sign}${m}`;
    return options.returnObject
      ? { num: formattedNum, unit: "ม.", val: m }
      : `${formattedNum} ม.`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupEventListeners();
  loadAllData();
  startCountdownTimer();
});

/**
 * 1. สร้าง Leaflet Map สำหรับ จ.อุบลราชธานี
 */
function initMap() {
  map = L.map("map", {
    center: UBON_COORDS,
    zoom: 9.5,
    zoomControl: false,
  });

  L.control.zoom({ position: "topright" }).addTo(map);

  // Light theme map tiles จาก CartoDB Positron
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> | ข้อมูล: HII ThaiWater จ.อุบลราชธานี',
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);

  markerClusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 35,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      const clusterColor = currentMode === "water" ? "rgba(3,105,161,0.9)" : "rgba(37,99,235,0.9)";
      return L.divIcon({
        html: `<div class="cluster-bubble" style="background:${clusterColor};"><span>${count}</span></div>`,
        className: "custom-cluster",
        iconSize: L.point(34, 34),
      });
    },
  });

  map.addLayer(markerClusterGroup);

  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 250);
}

/**
 * 2. ดึงข้อมูลเฉพาะ จ.อุบลราชธานี จาก Backend (ขนาดเล็กเพียง ~20KB โหลดเร็วทันที)
 */
async function loadAllData() {
  const refreshBtn = document.getElementById("btnRefresh");
  refreshBtn.classList.add("spinning");

  try {
    const [waterLevelsRes, rainfallsRes, amphoesRes] = await Promise.all([
      fetch("/api/water-levels").then((r) => r.json()),
      fetch("/api/rainfall").then((r) => r.json()),
      fetch("/api/amphoes").then((r) => r.json()),
    ]);

    if (waterLevelsRes.success) {
      allWaterLevels = waterLevelsRes.data;
    }
    if (rainfallsRes.success) {
      allRainfalls = rainfallsRes.data;
    }
    if (amphoesRes.success) {
      populateAmphoeDropdown(amphoesRes.data);
    }

    applyFilters();
    remainingSeconds = REFRESH_INTERVAL_SEC;
  } catch (err) {
    console.error("Failed to load dashboard data:", err);
    document.getElementById("cacheStatusText").textContent = "เชื่อมต่อล้มเหลว";
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

/**
 * 3. เติมรายชื่ออำเภอใน จ.อุบลราชธานี
 */
function populateAmphoeDropdown(amphoes) {
  const select = document.getElementById("amphoeSelect");
  const currentVal = select.value;
  select.innerHTML = `<option value="">ทุกอำเภอใน จ.อุบลราชธานี (${amphoes.length} อำเภอ)</option>`;

  amphoes.forEach((aName) => {
    const opt = document.createElement("option");
    opt.value = aName;
    opt.textContent = `อ.${aName}`;
    if (aName === currentVal) opt.selected = true;
    select.appendChild(opt);
  });
}

/**
 * 4. กรองข้อมูลเฉพาะใน จ.อุบลราชธานี (Apply Filters)
 */
function applyFilters() {
  const query = currentSearchQuery.trim().toLowerCase();
  const amphoe = currentAmphoe;

  // Filter Water Level Stations
  filteredWaterLevels = allWaterLevels.filter((item) => {
    if (amphoe && item.station.amphoeNameTh !== amphoe) return false;
    if (query) {
      const match =
        (item.station.nameTh && item.station.nameTh.toLowerCase().includes(query)) ||
        (item.station.amphoeNameTh && item.station.amphoeNameTh.toLowerCase().includes(query)) ||
        (item.station.basinNameTh && item.station.basinNameTh.toLowerCase().includes(query)) ||
        String(item.station.id).includes(query);
      if (!match) return false;
    }
    if (currentWaterFilter === "overflow") {
      return item.freeboardM !== null && item.freeboardM < 0;
    } else if (currentWaterFilter === "warning") {
      return (
        (item.freeboardM !== null && item.freeboardM >= 0 && item.freeboardM <= 0.5) ||
        (item.situationLevel !== null && item.situationLevel >= 4)
      );
    } else if (currentWaterFilter === "normal") {
      return (
        (item.freeboardM === null || item.freeboardM > 0.5) &&
        (item.situationLevel === null || item.situationLevel < 4)
      );
    }
    return true;
  });

  // Filter Rainfall Stations
  filteredRainfalls = allRainfalls.filter((item) => {
    if (amphoe && item.station.amphoeNameTh !== amphoe) return false;
    if (query) {
      const match =
        (item.station.nameTh && item.station.nameTh.toLowerCase().includes(query)) ||
        (item.station.amphoeNameTh && item.station.amphoeNameTh.toLowerCase().includes(query)) ||
        (item.station.basinNameTh && item.station.basinNameTh.toLowerCase().includes(query)) ||
        String(item.station.id).includes(query);
      if (!match) return false;
    }
    const rain24 = item.rain24h ?? 0;
    if (currentRainFilter === "very-heavy") {
      return rain24 >= 90;
    } else if (currentRainFilter === "heavy") {
      return rain24 >= 35 && rain24 < 90;
    } else if (currentRainFilter === "has-rain") {
      return rain24 > 0;
    }
    return true;
  });

  // อัปเดตตัวเลข Badge บนแถบเลือกโหมดหลัก
  document.getElementById("badgeWaterCount").textContent = `${allWaterLevels.length} สถานี`;
  document.getElementById("badgeRainCount").textContent = `${allRainfalls.length} สถานี`;

  updateKPIs();
  updateLeaderboards();
  renderMapMarkers();
  renderTable();
}

/**
 * 5. อัปเดต KPIs เฉพาะ จ.อุบลราชธานี
 */
function updateKPIs() {
  const amphoeLabel = currentAmphoe ? `อ.${currentAmphoe} จ.อุบลฯ` : "จ.อุบลราชธานี";

  // 5.1 Water Level KPIs
  let waterOverflow = 0;
  let waterWarning = 0;
  let waterNormal = 0;

  for (const item of filteredWaterLevels) {
    if (item.freeboardM !== null && item.freeboardM < 0) {
      waterOverflow++;
    } else if (
      (item.freeboardM !== null && item.freeboardM <= 0.5) ||
      (item.situationLevel !== null && item.situationLevel >= 4)
    ) {
      waterWarning++;
    } else {
      waterNormal++;
    }
  }

  document.getElementById("waterKpiOverflow").textContent = waterOverflow.toLocaleString();
  document.getElementById("waterKpiWarning").textContent = waterWarning.toLocaleString();
  document.getElementById("waterKpiNormal").textContent = waterNormal.toLocaleString();
  document.getElementById("waterKpiTotal").textContent = filteredWaterLevels.length.toLocaleString();
  document.getElementById("waterKpiProvinceLabel").textContent = `ใน ${amphoeLabel}`;

  // 5.2 Rainfall KPIs
  let rainVeryHeavy = 0;
  let rainHeavy = 0;
  let rainActiveCount = 0;

  for (const item of filteredRainfalls) {
    const r24 = item.rain24h ?? 0;
    if (r24 >= 90) rainVeryHeavy++;
    else if (r24 >= 35) rainHeavy++;
    if (r24 > 0) rainActiveCount++;
  }

  const sortedRain = [...filteredRainfalls].filter((r) => (r.rain24h ?? 0) > 0).sort((a, b) => (b.rain24h ?? 0) - (a.rain24h ?? 0));
  const maxRain = sortedRain[0];

  document.getElementById("rainKpiVeryHeavy").textContent = rainVeryHeavy.toLocaleString();
  document.getElementById("rainKpiHeavy").textContent = rainHeavy.toLocaleString();
  document.getElementById("rainKpiTotal").textContent = filteredRainfalls.length.toLocaleString();
  document.getElementById("rainKpiActiveCount").textContent = `มีฝนตก ${rainActiveCount.toLocaleString()} สถานี (${amphoeLabel})`;

  if (maxRain) {
    document.getElementById("rainKpiMaxVal").textContent = Number(maxRain.rain24h).toFixed(1);
    document.getElementById("rainKpiMaxStation").textContent = `${maxRain.station.nameTh ?? ""} (${maxRain.station.amphoeNameTh ? 'อ.' + maxRain.station.amphoeNameTh : ''})`;
  } else {
    document.getElementById("rainKpiMaxVal").textContent = "0.0";
    document.getElementById("rainKpiMaxStation").textContent = "ไม่มีฝนตก";
  }

  const nowStr = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("cacheStatusText").textContent = `อุบลฯ สด (${nowStr} น.)`;

  // Alert Banner
  const banner = document.getElementById("dangerAlertBanner");
  const bannerText = document.getElementById("dangerAlertText");
  if (waterOverflow > 0) {
    bannerText.textContent = `🚨 มี ${waterOverflow} สถานีระดับน้ำล้นตลิ่ง ใน จ.อุบลราชธานี – โปรดติดตามสถานการณ์อย่างใกล้ชิด`;
    banner.classList.remove("hidden");
  } else if (waterWarning > 0) {
    bannerText.textContent = `⚠️ มี ${waterWarning} สถานีระดับน้ำใกล้ตลิ่ง ใน จ.อุบลราชธานี – ควรเฝ้าระวัง`;
    banner.className = "alert-banner warning";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
    banner.className = "alert-banner hidden";
  }
}

/**
 * 6. อัปเดต Leaderboard ด้านข้าง (เฉพาะ จ.อุบลราชธานี)
 */
/**
 * 6. อัปเดต Leaderboard / Watchlist ด้านข้างแผนที่ (เฉพาะ จ.อุบลราชธานี)
 */
function updateLeaderboards() {
  // 6.1 Water Level Sidebar (เฝ้าระวัง & น้ำล้นตลิ่ง & จัดอันดับ)
  const targetWater = currentAmphoe
    ? allWaterLevels.filter((w) => w.station.amphoeNameTh === currentAmphoe)
    : allWaterLevels;

  // 1. น้ำล้นตลิ่ง (freeboardM < 0)
  const overflowList = targetWater
    .filter((w) => w.freeboardM !== null && w.freeboardM < 0)
    .sort((a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0));

  // 2. เฝ้าระวังน้ำสูง (freeboardM 0 - 0.5m หรือ situationLevel >= 4)
  const warningList = targetWater
    .filter((w) =>
      (w.freeboardM !== null && w.freeboardM >= 0 && w.freeboardM <= 0.5) ||
      (w.situationLevel !== null && w.situationLevel >= 4 && (w.freeboardM === null || w.freeboardM >= 0))
    )
    .sort((a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0));

  // 3. สถานีอื่นๆ เรียงตามระยะใกล้ตลิ่ง
  const riskyIds = new Set([...overflowList, ...warningList].map((s) => s.station.id));
  const normalList = targetWater
    .filter((w) => !riskyIds.has(w.station.id) && w.freeboardM !== null)
    .sort((a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0));

  const totalRisky = overflowList.length + warningList.length;
  const badgeEl = document.getElementById("waterSideBadge");
  badgeEl.textContent = totalRisky > 0 ? `${totalRisky} สถานี` : "ปกติ";
  badgeEl.className = totalRisky > 0 ? "badge danger" : "badge normal";

  const waterContainer = document.getElementById("waterLeaderList");

  function renderSidebarCard(item, type) {
    const isOverflow = type === "overflow";
    const st = item.station;
    const fbText = formatFreeboard(item.freeboardM, { absOnly: true });
    const fbObj = formatFreeboard(item.freeboardM, { withSign: true, returnObject: true });
    
    let statusText = "";
    if (isOverflow) {
      statusText = `🚨 ล้นตลิ่ง ${fbText}`;
    } else if (item.freeboardM !== null && item.freeboardM <= 0.5) {
      statusText = `⚠️ ต่ำกว่าตลิ่ง ${fbText}`;
    } else {
      statusText = `⚠️ เตือนภัย HII (ระดับ ${item.situationLevel ?? 4})`;
    }

    const obsTime = item.observedAt
      ? new Date(item.observedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
      : "-";

    return `
      <div class="sidebar-warning-box ${isOverflow ? 'danger' : 'warning'}">
        <div class="sw-header">
          <div>
            <div class="sw-title">🌊 ${st.nameTh || "สถานี " + st.id}</div>
            <div class="sw-sub">อ.${st.amphoeNameTh || "-"} • ${st.basinNameTh || "-"}</div>
          </div>
          <span class="sw-pill ${isOverflow ? 'danger' : 'warning'}">${statusText}</span>
        </div>

        <div class="sw-metrics-row">
          <div class="sw-metric-item">
            <span class="sw-m-label">ระดับน้ำจริง</span>
            <span class="sw-m-val blue">${item.waterlevelMsl !== null ? item.waterlevelMsl.toFixed(2) : "-"}</span>
          </div>
          <div class="sw-metric-item">
            <span class="sw-m-label">ระดับตลิ่ง</span>
            <span class="sw-m-val">${item.minBankMsl !== null ? item.minBankMsl.toFixed(2) : "-"}</span>
          </div>
          <div class="sw-metric-item">
            <span class="sw-m-label">ระยะพ้นตลิ่ง</span>
            <span class="sw-m-val ${isOverflow ? 'danger' : 'warning'}">${fbObj.num} ${fbObj.unit}</span>
          </div>
        </div>

        <div class="sw-actions">
          <span class="sw-time"><i data-lucide="clock" class="icon-xs"></i> ${obsTime} น.</span>
          <div class="sw-btn-group">
            <button class="sw-btn sw-btn-map" onclick="focusStationOnMap(${st.id})">
              <i data-lucide="map-pin" class="icon-xs"></i> แผนที่
            </button>
            <button class="sw-btn sw-btn-graph" onclick="openWaterModal(${st.id})">
              <i data-lucide="line-chart" class="icon-xs"></i> กราฟ
            </button>
          </div>
        </div>
      </div>
    `;
  }

  let html = "";

  // 1. รายการสถานีวิกฤต & เฝ้าระวัง (แสดงเป็นการ์ดลอยสะอาดตา ไม่ต้องมีแถบคั่นซ้อน)
  if (overflowList.length > 0 || warningList.length > 0) {
    if (overflowList.length > 0) {
      html += overflowList.map((item) => renderSidebarCard(item, "overflow")).join("");
    }
    if (warningList.length > 0) {
      html += warningList.map((item) => renderSidebarCard(item, "warning")).join("");
    }
  }

  // หากไม่มีสถานีวิกฤตเลย
  if (totalRisky === 0) {
    html += `
      <div class="sidebar-allclear">
        <i data-lucide="shield-check"></i>
        <span>✅ ทุกสถานีระดับน้ำปกติ (ต่ำกว่าตลิ่ง > 0.5 ม.)</span>
      </div>
    `;
  }

  // 2. สถานีอื่นๆ เรียงตามระยะใกล้ตลิ่ง (แสดงเป็นแถวเรียบหรู)
  if (normalList.length > 0) {
    html += `
      <div class="sidebar-section-divider">
        <span>สถานีระดับน้ำปกติ</span>
        <span class="normal-count-badge">${normalList.length} สถานี</span>
      </div>
    `;
    html += normalList.map((item) => {
      const freeboardStr = formatFreeboard(item.freeboardM, { withSign: true });
      return `
        <div class="leader-item" onclick="focusStationOnMap(${item.station.id})">
          <div class="leader-meta">
            <span class="leader-name">🌊 ${item.station.nameTh || "สถานี " + item.station.id}</span>
            <span class="leader-location">อ.${item.station.amphoeNameTh || "-"} • ${item.station.basinNameTh || ""}</span>
          </div>
          <div class="leader-stat">
            <span class="leader-val">${freeboardStr}</span>
            <span class="leader-sub">ต่ำกว่าตลิ่ง</span>
          </div>
        </div>
      `;
    }).join("");
  }

  waterContainer.innerHTML = html;

  // 6.2 Rainfall Leaderboard
  const rainList = [...filteredRainfalls]
    .filter((r) => (r.rain24h ?? 0) > 0)
    .sort((a, b) => (b.rain24h ?? 0) - (a.rain24h ?? 0))
    .slice(0, 15);

  const rainContainer = document.getElementById("rainLeaderList");
  if (rainList.length === 0) {
    rainContainer.innerHTML = `<div class="p-3 text-center text-muted" style="font-size:0.8rem;">ไม่มีฝนตกในพื้นที่นี้</div>`;
  } else {
    rainContainer.innerHTML = rainList.map((item) => {
      return `
        <div class="leader-item" onclick="focusStationOnMap(${item.station.id})">
          <div class="leader-meta">
            <span class="leader-name">🌧️ ${item.station.nameTh || "สถานี " + item.station.id}</span>
            <span class="leader-location">อ.${item.station.amphoeNameTh || "-"}</span>
          </div>
          <div class="leader-stat">
            <span class="leader-val rain">${Number(item.rain24h).toFixed(1)}</span>
            <span class="leader-sub">มม. (24 ชม.)</span>
          </div>
        </div>
      `;
    }).join("");
  }

  if (typeof lucide !== "undefined") lucide.createIcons();
}

/**
 * โฟกัสและซูมไปยังสถานีบนแผนที่
 */
function focusStationOnMap(stationId) {
  const stationIdNum = Number(stationId);
  const st = currentMode === "water"
    ? allWaterLevels.find((w) => w.station.id === stationIdNum)
    : allRainfalls.find((r) => r.station.id === stationIdNum);

  if (!st || !st.station.lat || !st.station.lon) return;

  // เลื่อนไปที่มุมมองแผนที่หากอยู่ในมุมมองตาราง
  if (currentView !== "map") {
    const btnMap = document.getElementById("btnViewMap");
    if (btnMap) btnMap.click();
  }

  map.flyTo([st.station.lat, st.station.lon], 13, { duration: 0.8 });

  // บนมือถือ เมื่อกดเลือกสถานี ให้เลื่อนหน้าจอลงมาที่แผนที่อัตโนมัติ
  if (window.innerWidth <= 767) {
    const mapWrapper = document.querySelector(".map-wrapper");
    if (mapWrapper) {
      mapWrapper.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // หาและเปิด popup ของ marker
  setTimeout(() => {
    markerClusterGroup.eachLayer((layer) => {
      const latlng = layer.getLatLng ? layer.getLatLng() : null;
      if (latlng && Math.abs(latlng.lat - st.station.lat) < 0.0001 && Math.abs(latlng.lng - st.station.lon) < 0.0001) {
        layer.openPopup();
      }
    });
  }, 900);
}

/**
 * 7. วาดหมุดสถานีลงบนแผนที่ (เฉพาะ จ.อุบลราชธานี)
 */
function renderMapMarkers() {
  markerClusterGroup.clearLayers();
  const markers = [];

  if (currentMode === "water") {
    filteredWaterLevels.forEach((item) => {
      const lat = item.station.lat;
      const lon = item.station.lon;
      if (!lat || !lon) return;

      let markerColor = "#06b6d4"; // ปกติ (cyan)
      let statusText = "ปกติ (ต่ำกว่าตลิ่ง)";
      let isDanger = false;

      const fbText = formatFreeboard(item.freeboardM, { absOnly: true });
      const fbSigned = formatFreeboard(item.freeboardM, { withSign: true });

      if (item.freeboardM !== null && item.freeboardM < 0) {
        markerColor = "#ef4444"; // ล้นตลิ่ง (red)
        statusText = `🚨 น้ำล้นตลิ่ง (${fbText})`;
        isDanger = true;
      } else if (
        (item.freeboardM !== null && item.freeboardM <= 0.5) ||
        (item.situationLevel !== null && item.situationLevel >= 4)
      ) {
        markerColor = "#f59e0b"; // เฝ้าระวัง (orange)
        statusText = `⚠️ เฝ้าระวังน้ำสูง (พ้นตลิ่ง ${item.freeboardM !== null ? fbSigned : "N/A"})`;
      }

      const circleMarker = L.circleMarker([lat, lon], {
        radius: isDanger ? 9 : 7,
        fillColor: markerColor,
        color: "#ffffff",
        weight: 1.5,
        opacity: 0.9,
        fillOpacity: 0.85,
      });

      const obsTime = item.observedAt ? new Date(item.observedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "-";

      const tagStyle = isDanger
        ? 'background:#fef2f2; color:#991b1b; border:1px solid #fca5a5;'
        : item.freeboardM !== null && item.freeboardM <= 0.5
          ? 'background:#fffbeb; color:#92400e; border:1px solid #fcd34d;'
          : 'background:#f0fdf4; color:#14532d; border:1px solid #86efac;';

      const popupHtml = `
        <div class="map-popup-card">
          <div class="popup-header">
            <span class="popup-tag" style="${tagStyle}">${statusText}</span>
            <h4>🌊 ${item.station.nameTh || "สถานี " + item.station.id}</h4>
            <p class="popup-loc">อ.${item.station.amphoeNameTh || ''} จ.อุบลราชธานี • ${item.station.basinNameTh || ''}</p>
          </div>
          <div class="popup-data-grid">
            <div class="popup-data-item">
              <span class="pdl">ระดับน้ำ (ม.รทก.)</span>
              <span class="pdv" style="color:#0369a1;">${item.waterlevelMsl !== null ? item.waterlevelMsl.toFixed(2) : "-"}</span>
            </div>
            <div class="popup-data-item">
              <span class="pdl">ระดับตลิ่ง</span>
              <span class="pdv">${item.minBankMsl !== null ? item.minBankMsl.toFixed(2) : "-"}</span>
            </div>
            <div class="popup-data-item">
              <span class="pdl">ระยะพ้นตลิ่ง</span>
              <span class="pdv" style="color:${item.freeboardM !== null && item.freeboardM < 0 ? '#dc2626' : '#16a34a'}; font-weight:700;">${fbSigned}</span>
            </div>
            <div class="popup-data-item">
              <span class="pdl">เวลาวัด</span>
              <span class="pdv" style="font-size:0.85rem; color:#475569;">${obsTime}</span>
            </div>
          </div>
          <button onclick="openWaterModal(${item.station.id})" class="popup-graph-btn">📈 ดูกราฟย้อนหลัง</button>
        </div>
      `;

      circleMarker.bindPopup(popupHtml);
      markers.push(circleMarker);
    });
  } else {
    filteredRainfalls.forEach((item) => {
      const lat = item.station.lat;
      const lon = item.station.lon;
      if (!lat || !lon) return;

      const r24  = item.rain24h ?? 0;
      const r1h  = item.rain1h  ?? 0;   // ฝนใน 1 ชม. ล่าสุด
      const hasRecentRain = r1h > 0;    // กำลังมีฝนตกอยู่ขณะนี้

      // -------- สีและสถานะ 24 ชม. --------
      let markerColor = "#94a3b8";
      let statusText  = "ไม่มีฝน (0.0 มม.)";

      if (r24 >= 90) {
        markerColor = "#dc2626";
        statusText  = `🚨 ฝนตกหนักมาก (${r24.toFixed(1)} มม.)`;
      } else if (r24 >= 35) {
        markerColor = "#d97706";
        statusText  = `⚠️ ฝนตกหนัก (${r24.toFixed(1)} มม.)`;
      } else if (r24 >= 10) {
        markerColor = "#16a34a";
        statusText  = `🌧️ ฝนปานกลาง (${r24.toFixed(1)} มม.)`;
      } else if (r24 > 0) {
        markerColor = "#2563eb";
        statusText  = `🌦️ ฝนเล็กน้อย (${r24.toFixed(1)} มม.)`;
      }

      // -------- สร้าง Icon --------
      let leafletMarker;

      if (hasRecentRain) {
        // ======================================================
        // สถานีที่มีฝนตกใน 1 ชม. ล่าสุด → DivIcon แบบพิเศษ
        // ======================================================
        const intensity = r1h >= 10 ? 'heavy' : r1h >= 5 ? 'moderate' : 'light';
        const iconColor  = r24 >= 90 ? '#dc2626' : r24 >= 35 ? '#d97706' : '#2563eb';
        const rippleColor = iconColor + '55';  // โปร่งแสง 33%

        // ขนาด Icon ตามความเข้ม
        const iconSize   = r1h >= 10 ? 36 : r1h >= 5 ? 32 : 28;
        const fontSize   = r1h >= 10 ? '15px' : r1h >= 5 ? '14px' : '13px';
        const animSpeed  = r1h >= 10 ? '0.7s' : r1h >= 5 ? '0.9s' : '1.1s';

        const divHtml = `
          <div class="rain-marker-wrap" style="
            position: relative;
            width: ${iconSize}px;
            height: ${iconSize}px;
            display: flex;
            align-items: center;
            justify-content: center;
          ">
            <!-- Ripple animation -->
            <span style="
              position: absolute;
              width: ${iconSize}px;
              height: ${iconSize}px;
              border-radius: 50%;
              background: ${rippleColor};
              animation: rain-ripple ${animSpeed} ease-out infinite;
            "></span>
            <!-- Core circle -->
            <span style="
              position: relative;
              z-index: 2;
              width: ${iconSize - 8}px;
              height: ${iconSize - 8}px;
              border-radius: 50%;
              background: ${iconColor};
              border: 2px solid rgba(255,255,255,0.9);
              display: flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 2px 8px ${iconColor}66;
              font-size: ${fontSize};
              line-height: 1;
            ">🌧️</span>
          </div>
        `;

        leafletMarker = L.marker([lat, lon], {
          icon: L.divIcon({
            html: divHtml,
            className: 'rain-divicon',
            iconSize:   [iconSize, iconSize],
            iconAnchor: [iconSize / 2, iconSize / 2],
          }),
          zIndexOffset: 500,   // อยู่บนสถานีที่ไม่มีฝน
        });

      } else {
        // ======================================================
        // สถานีที่ไม่มีฝนใน 1 ชม. → CircleMarker ธรรมดา
        // ======================================================
        leafletMarker = L.circleMarker([lat, lon], {
          radius:      r24 >= 35 ? 8 : 6,
          fillColor:   markerColor,
          color:       '#ffffff',
          weight:      1.5,
          opacity:     0.9,
          fillOpacity: 0.75,
        });
      }

      // -------- Popup --------
      const obsTime = item.observedAt
        ? new Date(item.observedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
        : '-';

      const rainTagStyle = r24 >= 90
        ? 'background:#fef2f2; color:#991b1b; border:1px solid #fca5a5;'
        : r24 >= 35
          ? 'background:#fffbeb; color:#92400e; border:1px solid #fcd34d;'
          : r24 > 0
            ? 'background:#eff6ff; color:#1e40af; border:1px solid #93c5fd;'
            : 'background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0;';

      // แบนเนอร์ฝน 1 ชม. (แสดงเมื่อมีฝนล่าสุด)
      const rain1hBanner = hasRecentRain ? `
        <div style="
          display: flex;
          align-items: center;
          gap: 8px;
          background: #eff6ff;
          border: 1px solid #93c5fd;
          border-radius: 8px;
          padding: 8px 12px;
          margin: 8px 0;
        ">
          <span style="font-size: 1.5rem; animation: rain-ripple 1s ease-out infinite;">🌧️</span>
          <div>
            <div style="font-size: 0.67rem; color: #1e40af; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;">กำลังมีฝนตกอยู่ขณะนี้</div>
            <div style="font-size: 1.1rem; font-weight: 800; color: #1d4ed8; font-family: monospace;">${r1h.toFixed(1)} มม. / 1 ชม.</div>
          </div>
        </div>
      ` : '';

      const popupHtml = `
        <div class="map-popup-card">
          <div class="popup-header">
            <span class="popup-tag" style="${rainTagStyle}">${statusText}</span>
            <h4>${hasRecentRain ? '🌧️' : '🌂'} ${item.station.nameTh || 'สถานี ' + item.station.id}</h4>
            <p class="popup-loc">อ.${item.station.amphoeNameTh || ''} จ.อุบลราชธานี • ${item.station.basinNameTh || ''}</p>
          </div>
          ${rain1hBanner}
          <div class="popup-data-grid">
            <div class="popup-data-item">
              <span class="pdl">ฝน 1 ชม. ล่าสุด</span>
              <span class="pdv" style="color:${hasRecentRain ? '#1d4ed8' : '#94a3b8'}; font-weight: ${hasRecentRain ? '800' : '600'}">
                ${r1h > 0 ? r1h.toFixed(1) + ' มม.' : '0.0 มม.'}
              </span>
            </div>
            <div class="popup-data-item">
              <span class="pdl">ฝนสะสม 24 ชม.</span>
              <span class="pdv" style="color:#2563eb;">${item.rain24h !== null ? item.rain24h.toFixed(1) : '-'} มม.</span>
            </div>
            <div class="popup-data-item" style="grid-column:span 2;">
              <span class="pdl">เวลาวัด</span>
              <span class="pdv" style="font-size:0.85rem; color:#475569;">${obsTime} น.</span>
            </div>
          </div>
        </div>
      `;

      leafletMarker.bindPopup(popupHtml, { maxWidth: 300 });
      markers.push(leafletMarker);
    });
  }

  markerClusterGroup.addLayers(markers);
}

/**
 * 8. แสดงข้อมูลในตาราง
 */
function renderTable() {
  document.getElementById("tableWaterCount").textContent = filteredWaterLevels.length.toLocaleString();
  document.getElementById("tableRainCount").textContent = filteredRainfalls.length.toLocaleString();

  if (currentMode === "water") {
    document.getElementById("tabWaterLevel").classList.add("active");
    document.getElementById("tabRainfall").classList.remove("active");
    document.getElementById("waterTableContainer").classList.remove("hidden");
    document.getElementById("rainTableContainer").classList.add("hidden");
    renderWaterTablePage();
  } else {
    document.getElementById("tabRainfall").classList.add("active");
    document.getElementById("tabWaterLevel").classList.remove("active");
    document.getElementById("rainTableContainer").classList.remove("hidden");
    document.getElementById("waterTableContainer").classList.add("hidden");
    renderRainTablePage();
  }
}

function renderWaterTablePage() {
  const total = filteredWaterLevels.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > maxPage) currentPage = maxPage;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredWaterLevels.slice(start, start + PAGE_SIZE);
  const tbody = document.getElementById("waterTableBody");

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-4 text-muted">ไม่พบข้อมูลสถานีระดับน้ำในเงื่อนไขนี้</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map((item) => {
      const fbText = formatFreeboard(item.freeboardM, { absOnly: true });
      const fbSigned = formatFreeboard(item.freeboardM, { withSign: true });

      let statusBadge = `<span class="status-tag normal">ปกติ</span>`;
      if (item.freeboardM !== null && item.freeboardM < 0) {
        statusBadge = `<span class="status-tag overflow">ล้นตลิ่ง (-${fbText})</span>`;
      } else if (
        (item.freeboardM !== null && item.freeboardM <= 0.5) ||
        (item.situationLevel !== null && item.situationLevel >= 4)
      ) {
        statusBadge = `<span class="status-tag warning">เฝ้าระวัง</span>`;
      }

      const obsTime = item.observedAt ? new Date(item.observedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "-";

      return `
        <tr>
          <td><span class="modal-station-id">${item.station.id}</span></td>
          <td><strong>🌊 ${item.station.nameTh || "-"}</strong></td>
          <td>อ.${item.station.amphoeNameTh || "-"}</td>
          <td>${item.station.basinNameTh || "-"}</td>
          <td><strong style="color:#06b6d4;">${item.waterlevelMsl !== null ? item.waterlevelMsl.toFixed(2) : "-"}</strong></td>
          <td>${item.minBankMsl !== null ? item.minBankMsl.toFixed(2) : "-"}</td>
          <td><span style="color:${item.freeboardM !== null && item.freeboardM < 0 ? '#f87171' : '#10b981'}; font-weight:700;">${fbSigned}</span></td>
          <td>${statusBadge}</td>
          <td>${obsTime}</td>
          <td>
            <button class="btn-view-graph" onclick="openWaterModal(${item.station.id})">
              📈 กราฟย้อนหลัง
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  updatePaginationControls(total, maxPage);
}

function renderRainTablePage() {
  const total = filteredRainfalls.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > maxPage) currentPage = maxPage;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredRainfalls.slice(start, start + PAGE_SIZE);
  const tbody = document.getElementById("rainTableBody");

  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">ไม่พบข้อมูลสถานีวัดน้ำฝนในเงื่อนไขนี้</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map((item) => {
      const rain24 = item.rain24h !== null ? item.rain24h : 0;
      let intensityBadge = `<span class="status-tag normal" style="background:rgba(100,116,139,0.2); color:#94a3b8;">ไม่มีฝน</span>`;
      if (rain24 >= 90) {
        intensityBadge = `<span class="status-tag overflow">ฝนตกหนักมาก (&ge;90 มม.)</span>`;
      } else if (rain24 >= 35) {
        intensityBadge = `<span class="status-tag warning">ฝนตกหนัก (35-90 มม.)</span>`;
      } else if (rain24 >= 10) {
        intensityBadge = `<span class="status-tag normal" style="background:rgba(16,185,129,0.15); color:#34d399;">ฝนปานกลาง (10-35 มม.)</span>`;
      } else if (rain24 > 0) {
        intensityBadge = `<span class="status-tag normal" style="background:rgba(6,182,212,0.15); color:#38bdf8;">ฝนเล็กน้อย (&lt;10 มม.)</span>`;
      }

      const obsTime = item.observedAt ? new Date(item.observedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "-";

      return `
        <tr>
          <td><span class="modal-station-id">${item.station.id}</span></td>
          <td><strong>🌧️ ${item.station.nameTh || "-"}</strong></td>
          <td>อ.${item.station.amphoeNameTh || "-"}</td>
          <td>${item.station.basinNameTh || "-"}</td>
          <td>${item.rain1h !== null ? item.rain1h.toFixed(1) : "-"}</td>
          <td><strong style="color:#60a5fa; font-size:0.95rem;">${item.rain24h !== null ? item.rain24h.toFixed(1) : "-"}</strong></td>
          <td>${intensityBadge}</td>
          <td>${obsTime}</td>
        </tr>
      `;
    }).join("");
  }

  updatePaginationControls(total, maxPage);
}

function updatePaginationControls(total, maxPage) {
  document.getElementById("paginationInfo").textContent = `หน้า ${currentPage} จาก ${maxPage} (ทั้งหมด ${total.toLocaleString()} สถานีใน จ.อุบลฯ)`;
  document.getElementById("btnPrevPage").disabled = currentPage <= 1;
  document.getElementById("btnNextPage").disabled = currentPage >= maxPage;
}

/**
 * 9. เปิด Modal กราฟสถานีวัดระดับน้ำ
 */
async function openWaterModal(stationId) {
  const stationWater = allWaterLevels.find((w) => w.station.id === Number(stationId));
  if (!stationWater) return;

  const st = stationWater.station;
  currentModalStation = {
    id: Number(stationId),
    nameTh: st.nameTh ?? "",
    amphoeNameTh: st.amphoeNameTh ?? "",
    minBankMsl: stationWater.minBankMsl,
  };

  document.getElementById("modalStationId").textContent = `ID: ${stationId}`;
  document.getElementById("modalStationName").textContent = `🌊 ${st.nameTh || "สถานี " + stationId}`;
  document.getElementById("modalStationLocation").textContent = `${st.amphoeNameTh ? 'อ.' + st.amphoeNameTh : ''} จ.อุบลราชธานี (ลุ่มน้ำ: ${st.basinNameTh || '-'})`;

  document.getElementById("modalWaterLevelMsl").textContent = stationWater.waterlevelMsl !== null ? stationWater.waterlevelMsl.toFixed(2) : "-";
  document.getElementById("modalMinBankMsl").textContent = stationWater.minBankMsl !== null ? stationWater.minBankMsl.toFixed(2) : "-";
  document.getElementById("modalWaterLocalM").textContent = stationWater.waterlevelLocalM !== null ? stationWater.waterlevelLocalM.toFixed(2) : "-";

  const freeboardEl = document.getElementById("modalFreeboardM");
  const freeboardUnitEl = document.getElementById("modalFreeboardUnit");
  if (stationWater.freeboardM !== null) {
    const fbObj = formatFreeboard(stationWater.freeboardM, { withSign: true, returnObject: true });
    freeboardEl.textContent = fbObj.num;
    if (freeboardUnitEl) freeboardUnitEl.textContent = fbObj.unit;
    freeboardEl.style.color = stationWater.freeboardM < 0 ? "#f87171" : "#10b981";
  } else {
    freeboardEl.textContent = "-";
    if (freeboardUnitEl) freeboardUnitEl.textContent = "ม.";
    freeboardEl.style.color = "#fff";
  }

  const statusPill = document.getElementById("modalStatusPill");
  if (stationWater.freeboardM !== null && stationWater.freeboardM < 0) {
    statusPill.textContent = "🚨 ล้นตลิ่ง";
    statusPill.className = "status-pill badge danger";
  } else if (stationWater.freeboardM !== null && stationWater.freeboardM <= 0.5) {
    statusPill.textContent = "⚠️ เฝ้าระวังน้ำสูง";
    statusPill.className = "status-pill badge warning";
  } else {
    statusPill.textContent = "✅ ระดับปกติ";
    statusPill.className = "status-pill badge normal";
  }

  document.getElementById("stationModalBackdrop").classList.add("open");
  await loadStationGraph();
}

/**
 * 10. ดึงและเรนเดอร์กราฟประวัติระดับน้ำย้อนหลัง (Time-series)
 */
async function loadStationGraph() {
  if (!currentModalStation) return;

  const chartLoader = document.getElementById("chartLoader");
  chartLoader.classList.remove("hidden");

  try {
    const today = new Date();
    const startDateObj = new Date(today.getTime() - chartRangeDays * 24 * 60 * 60 * 1000);

    const pad = (n) => String(n).padStart(2, "0");
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const fmtDateTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const startDate = fmtDate(startDateObj);
    const endDate = fmtDateTime(today);

    const res = await fetch(`/api/water-levels/graph?station_id=${currentModalStation.id}&start_date=${startDate}&end_date=${encodeURIComponent(endDate)}`);
    const json = await res.json();

    if (json.success && json.data) {
      renderChart(json.data);
    }
  } catch (err) {
    console.error("Error loading graph:", err);
  } finally {
    chartLoader.classList.add("hidden");
  }
}

function renderChart(graphResult) {
  const ctx = document.getElementById("waterLevelChart").getContext("2d");
  if (waterChart) waterChart.destroy();

  const points = graphResult.points || [];
  const labels = [];
  const waterLevelValues = [];
  const minBankValues = [];
  const warningValues = [];

  const minBank = graphResult.minBankMsl ?? currentModalStation?.minBankMsl;
  const warningLevel = graphResult.warningLevelMsl;

  points.forEach((pt) => {
    const d = pt.observedAt ? new Date(pt.observedAt) : (pt.rawDatetime ? new Date(pt.rawDatetime.replace(" ", "T") + "+07:00") : null);
    const labelStr = d ? `${padZero(d.getHours())}:${padZero(d.getMinutes())} (${d.getDate()}/${d.getMonth()+1})` : pt.rawDatetime;
    
    labels.push(labelStr);
    waterLevelValues.push(pt.waterlevelMsl);

    if (minBank !== null && minBank !== undefined) {
      minBankValues.push(minBank);
    }
    if (warningLevel !== null && warningLevel !== undefined) {
      warningValues.push(warningLevel);
    }
  });

  const datasets = [
    {
      label: "ระดับน้ำจริง (ม.รทก.)",
      data: waterLevelValues,
      borderColor: "#0369a1",
      backgroundColor: "rgba(3, 105, 161, 0.08)",
      fill: true,
      tension: 0.25,
      spanGaps: true,
      pointRadius: points.length > 50 ? 1 : 3,
      pointHoverRadius: 6,
      borderWidth: 2,
      pointBackgroundColor: "#0369a1",
    }
  ];

  if (minBankValues.length > 0) {
    datasets.push({
      label: `ระดับตลิ่ง (${minBank.toFixed(2)} ม.รทก.)`,
      data: minBankValues,
      borderColor: "#dc2626",
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      borderWidth: 2,
    });
  }

  if (warningValues.length > 0 && warningLevel !== minBank) {
    datasets.push({
      label: `ระดับเตือนภัย (${warningLevel.toFixed(2)} ม.รทก.)`,
      data: warningValues,
      borderColor: "#d97706",
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
      borderWidth: 1.5,
    });
  }

  waterChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          labels: { color: "#475569", font: { family: "Sarabun, sans-serif", size: 12 } }
        },
        tooltip: {
          backgroundColor: "rgba(255,255,255,0.97)",
          titleColor: "#0f172a",
          bodyColor: "#475569",
          borderColor: "#e2e8f0",
          borderWidth: 1,
          boxShadow: "0 4px 16px rgba(0,0,0,.1)",
          callbacks: {
            label: function(context) {
              const val = context.parsed.y;
              if (val === null || val === undefined) return `${context.dataset.label}: ไม่มีข้อมูล`;
              return `${context.dataset.label}: ${val.toFixed(2)} ม.รทก.`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: "#f1f5f9", drawBorder: false },
          ticks: { color: "#94a3b8", font: { size: 10 }, maxTicksLimit: 12 }
        },
        y: {
          grid: { color: "#f1f5f9", drawBorder: false },
          ticks: { color: "#64748b", font: { family: "Sarabun, sans-serif", size: 11 } }
        }
      }
    }
  });
}

function padZero(n) {
  return String(n).padStart(2, "0");
}

/**
 * 11. Event Listeners Setup
 */
function setupEventListeners() {
  // Mode Switcher (1. ระดับน้ำ vs 2. ปริมาณน้ำฝน)
  const modeBtnWater = document.getElementById("modeBtnWater");
  const modeBtnRain = document.getElementById("modeBtnRain");

  const waterKpiGrid = document.getElementById("waterKpiGrid");
  const rainKpiGrid = document.getElementById("rainKpiGrid");

  const waterFilterPills = document.getElementById("waterFilterPills");
  const rainFilterPills = document.getElementById("rainFilterPills");

  const waterMapLegend = document.getElementById("waterMapLegend");
  const rainMapLegend = document.getElementById("rainMapLegend");

  const waterLeaderCard = document.getElementById("waterLeaderCard");
  const rainLeaderCard = document.getElementById("rainLeaderCard");

  function switchMode(newMode) {
    currentMode = newMode;
    currentPage = 1;

    modeBtnWater.classList.toggle("active", newMode === "water");
    modeBtnRain.classList.toggle("active", newMode === "rain");

    waterKpiGrid.classList.toggle("hidden", newMode !== "water");
    rainKpiGrid.classList.toggle("hidden", newMode !== "rain");

    waterFilterPills.classList.toggle("hidden", newMode !== "water");
    rainFilterPills.classList.toggle("hidden", newMode !== "rain");

    waterMapLegend.classList.toggle("hidden", newMode !== "water");
    rainMapLegend.classList.toggle("hidden", newMode !== "rain");

    waterLeaderCard.classList.toggle("hidden", newMode !== "water");
    rainLeaderCard.classList.toggle("hidden", newMode !== "rain");

    applyFilters();
  }

  modeBtnWater.addEventListener("click", () => switchMode("water"));
  modeBtnRain.addEventListener("click", () => switchMode("rain"));

  // Click on Alert Banner -> Focus first critical station on map
  const dangerBanner = document.getElementById("dangerAlertBanner");
  if (dangerBanner) {
    dangerBanner.style.cursor = "pointer";
    dangerBanner.title = "คลิกเพื่อดูสถานีวิกฤตบนแผนที่";
    dangerBanner.addEventListener("click", () => {
      const firstDanger = allWaterLevels.find((w) => w.freeboardM !== null && w.freeboardM < 0) ||
                          allWaterLevels.find((w) => w.freeboardM !== null && w.freeboardM <= 0.5);
      if (firstDanger) {
        switchMode("water");
        focusStationOnMap(firstDanger.station.id);
        const mapEl = document.getElementById("mapViewContainer");
        if (mapEl) mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  // Click on Water KPI Cards to filter
  document.querySelector(".kpi-card.danger-card")?.addEventListener("click", () => {
    switchMode("water");
    const pill = document.querySelector('#waterFilterPills .pill[data-filter="overflow"]');
    if (pill) pill.click();
  });
  document.querySelector(".kpi-card.warning-card")?.addEventListener("click", () => {
    switchMode("water");
    const pill = document.querySelector('#waterFilterPills .pill[data-filter="warning"]');
    if (pill) pill.click();
  });

  // Search input
  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("btnClearSearch");

  searchInput.addEventListener("input", (e) => {
    currentSearchQuery = e.target.value;
    clearBtn.classList.toggle("hidden", !currentSearchQuery);
    currentPage = 1;
    applyFilters();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    currentSearchQuery = "";
    clearBtn.classList.add("hidden");
    document.querySelectorAll("#ubonRiverChips .chip-btn").forEach((c) => c.classList.remove("active"));
    currentPage = 1;
    applyFilters();
  });

  // River Filter Chips
  document.querySelectorAll("#ubonRiverChips .chip-btn").forEach((chip) => {
    chip.addEventListener("click", () => {
      const searchTerm = chip.dataset.search;
      const isAlreadyActive = chip.classList.contains("active");

      document.querySelectorAll("#ubonRiverChips .chip-btn").forEach((c) => c.classList.remove("active"));

      if (!isAlreadyActive) {
        chip.classList.add("active");
        searchInput.value = searchTerm;
        currentSearchQuery = searchTerm;
        clearBtn.classList.remove("hidden");
      } else {
        searchInput.value = "";
        currentSearchQuery = "";
        clearBtn.classList.add("hidden");
      }
      currentPage = 1;
      applyFilters();
    });
  });

  // Amphoe select dropdown (ใน จ.อุบลราชธานี)
  document.getElementById("amphoeSelect").addEventListener("change", (e) => {
    currentAmphoe = e.target.value;
    currentPage = 1;
    applyFilters();
  });

  // Water Status Filter Pills
  document.querySelectorAll("#waterFilterPills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#waterFilterPills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentWaterFilter = pill.dataset.filter;
      currentPage = 1;
      applyFilters();
    });
  });

  // Rain Status Filter Pills
  document.querySelectorAll("#rainFilterPills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#rainFilterPills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentRainFilter = pill.dataset.filter;
      currentPage = 1;
      applyFilters();
    });
  });

  // View Switcher (Map vs Table)
  const btnMap = document.getElementById("btnViewMap");
  const btnTable = document.getElementById("btnViewTable");
  const mapContainer = document.getElementById("mapViewContainer");
  const tableContainer = document.getElementById("tableViewContainer");

  btnMap.addEventListener("click", () => {
    btnMap.classList.add("active");
    btnTable.classList.remove("active");
    mapContainer.classList.add("active");
    tableContainer.classList.remove("active");
    currentView = "map";
    setTimeout(() => map.invalidateSize(), 100);
  });

  btnTable.addEventListener("click", () => {
    btnTable.classList.add("active");
    btnMap.classList.remove("active");
    tableContainer.classList.add("active");
    mapContainer.classList.remove("active");
    currentView = "table";
    renderTable();
  });

  // Table Tabs
  document.getElementById("tabWaterLevel").addEventListener("click", () => {
    switchMode("water");
  });

  document.getElementById("tabRainfall").addEventListener("click", () => {
    switchMode("rain");
  });

  // Pagination
  document.getElementById("btnPrevPage").addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });

  document.getElementById("btnNextPage").addEventListener("click", () => {
    currentPage++;
    renderTable();
  });

  // Refresh Button
  document.getElementById("btnRefresh").addEventListener("click", async () => {
    const btn = document.getElementById("btnRefresh");
    btn.classList.add("spinning");
    try {
      await fetch("/api/refresh", { method: "POST" });
      await loadAllData();
    } finally {
      btn.classList.remove("spinning");
    }
  });

  // Modal Close
  document.getElementById("btnCloseModal").addEventListener("click", closeModal);
  document.getElementById("stationModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "stationModalBackdrop") closeModal();
  });

  // Chart Range Buttons
  document.querySelectorAll(".btn-range").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-range").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      chartRangeDays = Number(btn.dataset.days);
      loadStationGraph();
    });
  });
}

function closeModal() {
  document.getElementById("stationModalBackdrop").classList.remove("open");
}

/**
 * 12. Countdown Timer สำหรับ Auto Refresh
 */
function startCountdownTimer() {
  if (countdownTimerInterval) clearInterval(countdownTimerInterval);
  countdownTimerInterval = setInterval(() => {
    remainingSeconds--;
    if (remainingSeconds <= 0) {
      remainingSeconds = REFRESH_INTERVAL_SEC;
      loadAllData();
    }
    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    document.getElementById("countdownTimer").textContent = `${padZero(mins)}:${padZero(secs)}`;
  }, 1000);
}
