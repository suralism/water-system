// ThaiWater Live Dashboard - จังหวัดอุบลราชธานี (เฉพาะพื้นที่เพื่อความเร็วสูงสุด & ฟีเจอร์ Interactive ล้ำสมัย)

let map;
let markerClusterGroup;
let currentBaseTileLayer = null;
let currentBaseLayerName = "voyager";
let baseTileLayers = {};
let satelliteLabelsLayer = null;

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
let currentModalTab = "graph"; // "graph" หรือ "crossSection"

// 2D River Cross-Section Simulation
let crossSectionAnimId = null;
let crossSectionWavePhase = 0;
let simOffsetM = 0;

// RainViewer Doppler Radar
let radarLayer = null;
let radarTimestamps = [];
let radarHost = "https://tilecache.rainviewer.com";
let radarCurrentIndex = 0;
let radarIsPlaying = false;
let radarPlayInterval = null;

// User GPS Location Marker
let userLocationMarker = null;
let userLocationCircle = null;

// Theme & Audio
let currentTheme = localStorage.getItem("ubon_theme") || "light";
let soundEnabled = localStorage.getItem("ubon_sound") === "true";
let audioCtx = null;

// Auto Refresh Timer (5 นาที)
const REFRESH_INTERVAL_SEC = 300;
let remainingSeconds = REFRESH_INTERVAL_SEC;
let countdownTimerInterval = null;

/**
 * แปลงระดับเทียบตลิ่ง (ต่ำกว่าตลิ่ง / ล้นตลิ่ง):
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
  applyTheme(currentTheme, false);
  updateSoundIcon();
  initMap();
  setupEventListeners();
  loadAllData();
  startCountdownTimer();
});

/**
 * 1. สร้าง Leaflet Map และระบบสลับ Multi-Tile Layers
 */
function initMap() {
  map = L.map("map", {
    center: UBON_COORDS,
    zoom: 9.5,
    zoomControl: false,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  // เลเยอร์แผนที่ต่างๆ
  baseTileLayers = {
    voyager: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> | ThaiWater จ.อุบลราชธานี',
      maxZoom: 19,
      subdomains: "abcd",
    }),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO DarkMatter</a> | ThaiWater จ.อุบลราชธานี',
      maxZoom: 19,
      subdomains: "abcd",
    }),
    satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: 'Tiles &copy; Esri &mdash; HII ThaiWater',
      maxZoom: 19,
    }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: 'Map &copy; OpenTopoMap | ThaiWater',
      maxZoom: 17,
    }),
  };

  satelliteLabelsLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    pane: "shadowPane",
  });

  // ตั้งค่าเริ่มต้นตามธีม
  const defaultLayerKey = currentTheme === "dark" ? "dark" : "voyager";
  switchBaseLayer(defaultLayerKey);

  markerClusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 35,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      const clusterColor = currentMode === "water" ? "rgba(3,105,161,0.92)" : "rgba(37,99,235,0.92)";
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
 * สลับ Layer พื้นหลังของแผนที่
 */
function switchBaseLayer(layerKey) {
  if (!baseTileLayers[layerKey]) return;

  if (currentBaseTileLayer) {
    map.removeLayer(currentBaseTileLayer);
  }
  if (satelliteLabelsLayer && map.hasLayer(satelliteLabelsLayer)) {
    map.removeLayer(satelliteLabelsLayer);
  }

  currentBaseTileLayer = baseTileLayers[layerKey];
  currentBaseLayerName = layerKey;
  currentBaseTileLayer.addTo(map);

  if (layerKey === "satellite") {
    satelliteLabelsLayer.addTo(map);
  }

  document.querySelectorAll(".map-layer-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.layer === layerKey);
  });
}

async function fetchSafeJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return await res.json();
}

/**
 * 2. ดึงข้อมูลเฉพาะ จ.อุบลราชธานี จาก Backend
 */
async function loadAllData() {
  const refreshBtn = document.getElementById("btnRefresh");
  if (refreshBtn) refreshBtn.classList.add("spinning");
  const cacheStatus = document.getElementById("cacheStatusText");
  if (cacheStatus) cacheStatus.textContent = "กำลังดึงข้อมูลสด...";

  try {
    const [waterLevelsRes, rainfallsRes, amphoesRes] = await Promise.all([
      fetchSafeJson("/api/water-levels"),
      fetchSafeJson("/api/rainfall"),
      fetchSafeJson("/api/amphoes"),
    ]);

    if (waterLevelsRes && waterLevelsRes.success) {
      allWaterLevels = waterLevelsRes.data || [];
    }
    if (rainfallsRes && rainfallsRes.success) {
      allRainfalls = rainfallsRes.data || [];
    }
    if (amphoesRes && amphoesRes.success) {
      populateAmphoeDropdown(amphoesRes.data || []);
    }

    applyFilters();
    updateRiverCorridors();
    remainingSeconds = REFRESH_INTERVAL_SEC;

    // ตรวจสอบสถานะวิกฤตและเล่นเสียงเตือนหากเปิดไว้
    checkCriticalAudioAlert();
  } catch (err) {
    console.error("Failed to load dashboard data:", err);
    if (cacheStatus) cacheStatus.textContent = "กำลังโหลดข้อมูล...";
    // ลองดึงใหม่อีกครั้งหลังจาก 2 วินาทีในกรณีเริ่มต้นระบบ
    setTimeout(() => {
      if (allWaterLevels.length === 0) {
        loadAllData();
      }
    }, 2500);
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("spinning");
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
  document.getElementById("badgeWaterCount").textContent = `${allWaterLevels.length}`;
  document.getElementById("badgeRainCount").textContent = `${allRainfalls.length}`;

  updateKPIs();
  updateLeaderboards();
  renderMapMarkers();
  renderTable();
}

/**
 * 5. อัปเดต KPIs พร้อม Count-Up Animation
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

  animateNumber("waterKpiOverflow", waterOverflow);
  animateNumber("waterKpiWarning", waterWarning);
  animateNumber("waterKpiNormal", waterNormal);
  animateNumber("waterKpiTotal", filteredWaterLevels.length);
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

  animateNumber("rainKpiVeryHeavy", rainVeryHeavy);
  animateNumber("rainKpiHeavy", rainHeavy);
  animateNumber("rainKpiTotal", filteredRainfalls.length);
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
    banner.classList.remove("warning");
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
 * แอนิเมชั่นนับตัวเลข CountUp
 */
function animateNumber(elementId, targetValue) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const current = parseInt(el.textContent.replace(/,/g, "")) || 0;
  if (current === targetValue) {
    el.textContent = targetValue.toLocaleString();
    return;
  }
  const diff = targetValue - current;
  const duration = 400;
  const steps = 15;
  const stepTime = duration / steps;
  let step = 0;

  const timer = setInterval(() => {
    step++;
    const val = Math.round(current + (diff * (step / steps)));
    el.textContent = val.toLocaleString();
    if (step >= steps) {
      clearInterval(timer);
      el.textContent = targetValue.toLocaleString();
    }
  }, stepTime);
}

/**
 * 6. อัปเดตแถบ 5 แม่น้ำสายหลักของ จ.อุบลราชธานี (River Corridors Live Gauges)
 */
function updateRiverCorridors() {
  const container = document.getElementById("riverCorridorCards");
  if (!container || allWaterLevels.length === 0) return;

  const rivers = [
    {
      id: "mun",
      name: "แม่น้ำมูล (M.7)",
      icon: "🌊",
      keyMatcher: (w) => [3543, 2752, 11688911].includes(w.station.id) || (w.station.nameTh && (w.station.nameTh.includes("M.7") || w.station.nameTh.includes("เสรีประชาธิปไตย"))),
    },
    {
      id: "chi",
      name: "แม่น้ำชี (เขื่องใน)",
      icon: "💧",
      keyMatcher: (w) => [269, 504940, 11688876].includes(w.station.id) || (w.station.basinNameTh && w.station.basinNameTh.includes("ชี")),
    },
    {
      id: "sebai",
      name: "ลำเซบาย / ลำเซบก",
      icon: "🏞️",
      keyMatcher: (w) => [11688743, 504962, 11688888].includes(w.station.id) || (w.station.nameTh && (w.station.nameTh.includes("เซบาย") || w.station.nameTh.includes("เซบก") || w.station.nameTh.includes("ป่าก่อ"))),
    },
    {
      id: "domyai",
      name: "ลำโดมใหญ่ (เดชอุดม/นาเยีย)",
      icon: "🌿",
      keyMatcher: (w) => [2707, 3533, 11688882].includes(w.station.id) || (w.station.nameTh && (w.station.nameTh.includes("โดมใหญ่") || w.station.nameTh.includes("คำสำราญ") || w.station.nameTh.includes("นาเยีย"))),
    },
    {
      id: "khong",
      name: "โขงเจียม / ปากมูล",
      icon: "🌅",
      keyMatcher: (w) => [740540, 3544].includes(w.station.id) || (w.station.amphoeNameTh && w.station.amphoeNameTh.includes("โขงเจียม")),
    }
  ];

  let html = "";

  rivers.forEach((river) => {
    const station = allWaterLevels.find(river.keyMatcher);
    if (!station) return;

    const st = station.station;
    const isOverflow = station.freeboardM !== null && station.freeboardM < 0;
    const isWarning = (station.freeboardM !== null && station.freeboardM <= 0.5) || (station.situationLevel !== null && station.situationLevel >= 4);

    let statusClass = "normal";
    let statusLabel = "ปกติ";
    if (isOverflow) {
      statusClass = "danger";
      statusLabel = "ล้นตลิ่ง";
    } else if (isWarning) {
      statusClass = "warning";
      statusLabel = "เฝ้าระวัง";
    }

    const fbText = formatFreeboard(station.freeboardM, { absOnly: true });
    
    // คำนวณร้อยละความจุลำน้ำ
    let capacityPct = 70;
    if (station.freeboardM !== null) {
      if (station.freeboardM < 0) {
        capacityPct = Math.min(125, 100 + Math.round(Math.abs(station.freeboardM) * 20));
      } else {
        capacityPct = Math.max(20, Math.round(100 - (station.freeboardM * 12)));
      }
    }

    const gaugeColorClass = isOverflow ? "danger" : isWarning ? "warning" : "normal";

    html += `
      <div class="rc-card ${statusClass}" onclick="focusStationOnMap(${st.id}); openWaterModal(${st.id});">
        <div class="rc-card-top">
          <div>
            <div class="rc-river-name">${river.icon} ${river.name}</div>
            <div class="rc-station-sub">${st.nameTh || "สถานี " + st.id} (${st.amphoeNameTh ? 'อ.' + st.amphoeNameTh : '-'})</div>
          </div>
          <span class="rc-status-tag ${statusClass}">${statusLabel}</span>
        </div>

        <div class="rc-metrics-row">
          <div>
            <span class="rc-water-val">${station.waterlevelMsl !== null ? station.waterlevelMsl.toFixed(2) : "-"}</span>
            <span class="rc-water-unit">ม.รทก.</span>
          </div>
          <div class="rc-freeboard-text ${statusClass}">
            ${isOverflow ? 'ล้นตลิ่ง ' : 'ต่ำกว่าตลิ่ง '}${fbText}
          </div>
        </div>

        <div class="rc-gauge-bar-wrap">
          <div class="rc-gauge-bar">
            <div class="rc-gauge-fill ${gaugeColorClass}" style="width: ${Math.min(100, capacityPct)}%;"></div>
          </div>
          <div class="rc-gauge-labels">
            <span>ความจุลำน้ำ: <strong>${capacityPct}%</strong></span>
            <span>ตลิ่ง: ${station.minBankMsl !== null ? station.minBankMsl.toFixed(2) : "-"} ม.</span>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

/**
 * 7. อัปเดต Leaderboard ด้านข้างแผนที่
 */
function updateLeaderboards() {
  const targetWater = currentAmphoe
    ? allWaterLevels.filter((w) => w.station.amphoeNameTh === currentAmphoe)
    : allWaterLevels;

  const overflowList = targetWater
    .filter((w) => w.freeboardM !== null && w.freeboardM < 0)
    .sort((a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0));

  const warningList = targetWater
    .filter((w) =>
      (w.freeboardM !== null && w.freeboardM >= 0 && w.freeboardM <= 0.5) ||
      (w.situationLevel !== null && w.situationLevel >= 4 && (w.freeboardM === null || w.freeboardM >= 0))
    )
    .sort((a, b) => (a.freeboardM ?? 0) - (b.freeboardM ?? 0));

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
    
    let statusText = "";
    if (isOverflow) {
      statusText = `ล้นตลิ่ง ${fbText}`;
    } else if (item.freeboardM !== null && item.freeboardM <= 0.5) {
      statusText = `เฝ้าระวัง (เหลือ ${fbText})`;
    } else {
      statusText = `เตือนภัย HII (ระดับ ${item.situationLevel ?? 4})`;
    }

    const obsTime = item.observedAt
      ? new Date(item.observedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
      : "-";

    const diffText = item.freeboardM !== null ? (isOverflow ? `ล้น ${fbText}` : `เหลือ ${fbText}`) : "-";

    return `
      <div class="sidebar-warning-box ${isOverflow ? 'danger' : 'warning'}">
        <div class="sw-header">
          <div>
            <div class="sw-title">${st.nameTh || "สถานี " + st.id}</div>
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
            <span class="sw-m-val ${isOverflow ? 'danger' : 'warning'}">${diffText}</span>
          </div>
        </div>

        <div class="sw-actions">
          <span class="sw-time"><i data-lucide="clock" class="icon-xs"></i> ${obsTime} น.</span>
          <div class="sw-btn-group">
            <button class="sw-btn sw-btn-map" onclick="focusStationOnMap(${st.id})">
              <i data-lucide="map-pin" class="icon-xs"></i> แผนที่
            </button>
            <button class="sw-btn sw-btn-graph" onclick="openWaterModal(${st.id})">
              <i data-lucide="waves" class="icon-xs"></i> กราฟ & จำลอง
            </button>
          </div>
        </div>
      </div>
    `;
  }

  let html = "";

  if (overflowList.length > 0 || warningList.length > 0) {
    if (overflowList.length > 0) {
      html += overflowList.map((item) => renderSidebarCard(item, "overflow")).join("");
    }
    if (warningList.length > 0) {
      html += warningList.map((item) => renderSidebarCard(item, "warning")).join("");
    }
  }

  if (totalRisky === 0) {
    html += `
      <div class="sidebar-allclear">
        <i data-lucide="shield-check"></i>
        <span>✅ ทุกสถานีระดับน้ำปกติ (ต่ำกว่าตลิ่ง > 0.5 ม.)</span>
      </div>
    `;
  }

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
            <span class="leader-name">${item.station.nameTh || "สถานี " + item.station.id}</span>
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

  // Rainfall Leaderboard
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
            <span class="leader-name">${item.station.nameTh || "สถานี " + item.station.id}</span>
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
 * 8. วาดหมุดสถานีลงบนแผนที่ (Render Map Markers)
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

      if (item.freeboardM !== null && item.freeboardM < 0) {
        markerColor = "#ef4444"; // ล้นตลิ่ง (red)
        statusText = `🚨 น้ำล้นตลิ่ง (${fbText})`;
        isDanger = true;
      } else if (
        (item.freeboardM !== null && item.freeboardM <= 0.5) ||
        (item.situationLevel !== null && item.situationLevel >= 4)
      ) {
        markerColor = "#f59e0b"; // เฝ้าระวัง (orange)
        statusText = item.freeboardM !== null ? `⚠️ เฝ้าระวัง (เหลือ ${fbText})` : `⚠️ เตือนภัย HII (ระดับ ${item.situationLevel ?? 4})`;
      } else {
        statusText = "✅ ระดับน้ำปกติ";
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

      const diffText = item.freeboardM !== null ? (item.freeboardM < 0 ? `ล้น ${fbText}` : `เหลือ ${fbText}`) : "-";
      const diffColor = item.freeboardM !== null && item.freeboardM < 0 ? '#dc2626' : (item.freeboardM !== null && item.freeboardM <= 0.5 ? '#d97706' : '#16a34a');

      const popupHtml = `
        <div class="map-popup-card">
          <div class="popup-header">
            <span class="popup-tag" style="${tagStyle}">${statusText}</span>
            <h4>${item.station.nameTh || "สถานี " + item.station.id}</h4>
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
              <span class="pdv" style="color:${diffColor}; font-weight:700;">
                ${diffText}
              </span>
            </div>
            <div class="popup-data-item">
              <span class="pdl">เวลาตรวจวัด</span>
              <span class="pdv" style="font-size:0.85rem; color:#475569;">${obsTime} น.</span>
            </div>
          </div>
          <button onclick="openWaterModal(${item.station.id})" class="popup-graph-btn">🌊 ดูกราฟ & แบบจำลอง 2D</button>
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
      const r1h  = item.rain1h  ?? 0;
      const hasRecentRain = r1h > 0;

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

      let leafletMarker;

      if (hasRecentRain) {
        const iconSize = r1h >= 10 ? 36 : r1h >= 5 ? 32 : 28;
        const iconColor = r24 >= 90 ? '#dc2626' : r24 >= 35 ? '#d97706' : '#2563eb';
        const rippleColor = iconColor + '55';

        const divHtml = `
          <div class="rain-marker-wrap" style="position:relative; width:${iconSize}px; height:${iconSize}px; display:flex; align-items:center; justify-content:center;">
            <span style="position:absolute; width:${iconSize}px; height:${iconSize}px; border-radius:50%; background:${rippleColor}; animation:rain-ripple 1s ease-out infinite;"></span>
            <span style="position:relative; z-index:2; width:${iconSize - 8}px; height:${iconSize - 8}px; border-radius:50%; background:${iconColor}; border:2px solid #fff; display:flex; align-items:center; justify-content:center; color:#fff; font-size:12px;">🌧️</span>
          </div>
        `;

        leafletMarker = L.marker([lat, lon], {
          icon: L.divIcon({
            html: divHtml,
            className: 'rain-divicon',
            iconSize: [iconSize, iconSize],
            iconAnchor: [iconSize / 2, iconSize / 2],
          }),
          zIndexOffset: 500,
        });
      } else {
        leafletMarker = L.circleMarker([lat, lon], {
          radius: r24 >= 35 ? 8 : 6,
          fillColor: markerColor,
          color: '#ffffff',
          weight: 1.5,
          opacity: 0.9,
          fillOpacity: 0.75,
        });
      }

      const obsTime = item.observedAt ? new Date(item.observedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '-';

      const rainTagStyle = r24 >= 90
        ? 'background:#fef2f2; color:#991b1b; border:1px solid #fca5a5;'
        : r24 >= 35
          ? 'background:#fffbeb; color:#92400e; border:1px solid #fcd34d;'
          : r24 > 0
            ? 'background:#eff6ff; color:#1e40af; border:1px solid #93c5fd;'
            : 'background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0;';

      const popupHtml = `
        <div class="map-popup-card">
          <div class="popup-header">
            <span class="popup-tag" style="${rainTagStyle}">${statusText}</span>
            <h4>${hasRecentRain ? '🌧️' : '🌂'} ${item.station.nameTh || 'สถานี ' + item.station.id}</h4>
            <p class="popup-loc">อ.${item.station.amphoeNameTh || ''} จ.อุบลราชธานี • ${item.station.basinNameTh || ''}</p>
          </div>
          <div class="popup-data-grid">
            <div class="popup-data-item">
              <span class="pdl">ฝน 1 ชม. ล่าสุด</span>
              <span class="pdv" style="color:${hasRecentRain ? '#1d4ed8' : '#94a3b8'}; font-weight:${hasRecentRain ? '800' : '600'}">
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
  if (radarLayer && map && map.hasLayer(markerClusterGroup)) {
    map.removeLayer(markerClusterGroup);
  }
}

/**
 * 9. เรดาร์ตรวจจับกลุ่มฝนสด RainViewer Doppler
 */
async function loadRadarData() {
  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    const data = await res.json();
    if (data && data.radar && data.radar.past) {
      radarHost = data.host || "https://tilecache.rainviewer.com";
      radarTimestamps = data.radar.past;
      if (data.radar.nowcast) {
        radarTimestamps = radarTimestamps.concat(data.radar.nowcast);
      }
      radarCurrentIndex = radarTimestamps.length - 1;
      const slider = document.getElementById("radarSlider");
      if (slider) {
        slider.max = radarTimestamps.length - 1;
        slider.value = radarCurrentIndex;
      }
      updateRadarDisplay();
    }
  } catch (err) {
    console.warn("RainViewer radar data not available:", err);
    document.getElementById("radarTimeDisplay").textContent = "ไม่สามารถเชื่อมต่อเรดาร์ได้";
  }
}

function updateRadarDisplay() {
  if (!radarTimestamps || radarTimestamps.length === 0) return;
  const frame = radarTimestamps[radarCurrentIndex];
  if (!frame) return;

  const date = new Date(frame.time * 1000);
  const timeStr = date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) + " น.";
  const timeDisplay = document.getElementById("radarTimeDisplay");
  if (timeDisplay) timeDisplay.textContent = `${timeStr} (${radarCurrentIndex + 1}/${radarTimestamps.length})`;

  const slider = document.getElementById("radarSlider");
  if (slider) slider.value = radarCurrentIndex;

  const radarUrl = `${radarHost}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`;
  
  if (radarLayer && map.hasLayer(radarLayer)) {
    radarLayer.setUrl(radarUrl);
  } else {
    if (radarLayer) {
      map.removeLayer(radarLayer);
    }
    radarLayer = L.tileLayer(radarUrl, {
      opacity: 0.72,
      zIndex: 400,
      tileSize: 512,
      zoomOffset: -1,
      minNativeZoom: 0,
      maxNativeZoom: 7, // RainViewer Free API ให้ข้อมูลเรดาร์ที่ Zoom 0-7 เท่านั้น (เกิน 7 จะขึ้น Zoom Level Not Supported)
      maxZoom: 19,       // ให้ Leaflet ขยายภาพต่ออัตโนมัติที่ Zoom 8-19 อย่างคมชัด
    }).addTo(map);
  }
}

function toggleRadar(forceState) {
  const radarBtn = document.getElementById("btnToggleRadar");
  const radarNavBtn = document.getElementById("btnToggleRadarNav");
  const playerBar = document.getElementById("radarPlayerBar");
  const waterMapLegend = document.getElementById("waterMapLegend");
  const rainMapLegend = document.getElementById("rainMapLegend");

  const willEnable = forceState !== undefined ? forceState : !radarLayer;

  if (willEnable) {
    if (radarBtn) radarBtn.classList.add("active");
    if (radarNavBtn) radarNavBtn.classList.add("active");
    if (playerBar) playerBar.classList.remove("hidden");

    // ซ่อนสัญลักษณ์สถานี (Legend) เมื่อเปิดดูเรดาร์กลุ่มฝน เพื่อไม่ให้บังแผนที่
    if (rainMapLegend) rainMapLegend.classList.add("hidden");
    if (waterMapLegend) waterMapLegend.classList.add("hidden");

    // ซ่อน Markers ทั้งหมดบนแผนที่เพื่อดูเรดาร์กลุ่มฝนได้อย่างชัดเจน
    if (map && markerClusterGroup && map.hasLayer(markerClusterGroup)) {
      map.removeLayer(markerClusterGroup);
    }

    if (radarTimestamps.length === 0) {
      loadRadarData();
    } else {
      updateRadarDisplay();
    }
  } else {
    if (radarBtn) radarBtn.classList.remove("active");
    if (radarNavBtn) radarNavBtn.classList.remove("active");
    if (playerBar) playerBar.classList.add("hidden");
    if (radarLayer) {
      map.removeLayer(radarLayer);
      radarLayer = null;
    }
    stopRadarPlay();

    // แสดง Markers กลับมาบนแผนที่
    if (map && markerClusterGroup && !map.hasLayer(markerClusterGroup)) {
      map.addLayer(markerClusterGroup);
    }

    // แสดงสัญลักษณ์สถานี (Legend) กลับมาตามโหมดที่เปิดอยู่ (น้ำ / ฝน)
    if (waterMapLegend) waterMapLegend.classList.toggle("hidden", currentMode !== "water");
    if (rainMapLegend) rainMapLegend.classList.toggle("hidden", currentMode !== "rain");
  }
}

function playRadarAnimation() {
  if (radarIsPlaying) {
    stopRadarPlay();
    return;
  }
  radarIsPlaying = true;
  const playIcon = document.getElementById("radarPlayIcon");
  if (playIcon) playIcon.setAttribute("data-lucide", "pause");
  if (typeof lucide !== "undefined") lucide.createIcons();

  radarPlayInterval = setInterval(() => {
    radarCurrentIndex = (radarCurrentIndex + 1) % radarTimestamps.length;
    updateRadarDisplay();
  }, 750);
}

function stopRadarPlay() {
  radarIsPlaying = false;
  if (radarPlayInterval) clearInterval(radarPlayInterval);
  const playIcon = document.getElementById("radarPlayIcon");
  if (playIcon) playIcon.setAttribute("data-lucide", "play");
  if (typeof lucide !== "undefined") lucide.createIcons();
}

/**
 * 10. GPS "เช็คความเสี่ยงน้ำท่วมใกล้บ้านฉัน" (Nearby Flood Risk Checker)
 */
function checkNearbyRisk() {
  const box = document.getElementById("gpsProximityBox");
  const title = document.getElementById("gpsTitleText");
  const sub = document.getElementById("gpsSubText");
  const grid = document.getElementById("gpsResultsGrid");

  if (!navigator.geolocation) {
    alert("อุปกรณ์หรือเบราว์เซอร์ของคุณไม่รองรับ Geolocation");
    return;
  }

  box.classList.remove("hidden");
  title.textContent = "กำลังค้นหาพิกัด GPS ของคุณ...";
  sub.textContent = "โปรดอนุญาตการเข้าถึงตำแหน่งที่ตั้งในเบราว์เซอร์";
  grid.innerHTML = `<div class="p-3 text-center text-muted" style="grid-column:1/-1;">กำลังรับพิกัดดาวเทียม GPS...</div>`;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const uLat = pos.coords.latitude;
      const uLon = pos.coords.longitude;
      processUserLocation(uLat, uLon);
    },
    (err) => {
      title.textContent = "ไม่สามารถระบุพิกัดได้";
      sub.textContent = err.message || "โปรดเปิดสิทธิ์เข้าถึง Location";
      grid.innerHTML = `<div class="p-3 text-center text-danger" style="grid-column:1/-1;">เกิดข้อผิดพลาดในการดึงตำแหน่งพิกัด: ${err.message}</div>`;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function calcDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function processUserLocation(uLat, uLon) {
  const title = document.getElementById("gpsTitleText");
  const sub = document.getElementById("gpsSubText");
  const grid = document.getElementById("gpsResultsGrid");

  // หาสถานีวัดระดับน้ำที่ใกล้ที่สุด
  let closestWater = null;
  let minWaterDist = Infinity;
  allWaterLevels.forEach((w) => {
    if (w.station.lat && w.station.lon) {
      const d = calcDistanceKm(uLat, uLon, w.station.lat, w.station.lon);
      if (d < minWaterDist) {
        minWaterDist = d;
        closestWater = w;
      }
    }
  });

  // หาสถานีวัดน้ำฝนที่ใกล้ที่สุด
  let closestRain = null;
  let minRainDist = Infinity;
  allRainfalls.forEach((r) => {
    if (r.station.lat && r.station.lon) {
      const d = calcDistanceKm(uLat, uLon, r.station.lat, r.station.lon);
      if (d < minRainDist) {
        minRainDist = d;
        closestRain = r;
      }
    }
  });

  // ประเมินระดับความเสี่ยง
  let overallRisk = "safe";
  let riskText = "ระดับความเสี่ยง: ปลอดภัย (ปกติ)";
  if (closestWater && closestWater.freeboardM !== null && closestWater.freeboardM < 0) {
    overallRisk = "danger";
    riskText = "🚨 มีความเสี่ยงสูง! สถานีใกล้คุณระดับน้ำล้นตลิ่ง";
  } else if (closestWater && closestWater.freeboardM !== null && closestWater.freeboardM <= 0.5) {
    overallRisk = "warning";
    riskText = "⚠️ ควรเฝ้าระวัง สถานีใกล้คุณระดับน้ำสูงใกล้ตลิ่ง";
  } else if (closestRain && (closestRain.rain24h ?? 0) >= 90) {
    overallRisk = "danger";
    riskText = "🚨 มีฝนตกหนักมากในพื้นที่ใกล้คุณ";
  }

  title.textContent = riskText;
  sub.textContent = `พิกัดของคุณ: ${uLat.toFixed(4)}, ${uLon.toFixed(4)} • สรุปสถานะจุดตรวจวัดใกล้เคียง`;

  let html = "";

  if (closestWater) {
    const isOver = closestWater.freeboardM !== null && closestWater.freeboardM < 0;
    const fbText = formatFreeboard(closestWater.freeboardM, { absOnly: true });
    html += `
      <div class="gps-item-card" onclick="focusStationOnMap(${closestWater.station.id})">
        <div class="gps-item-top">
          <span class="gps-type-tag">🌊 สถานีระดับน้ำใกล้ที่สุด</span>
          <span class="gps-dist-badge">${minWaterDist.toFixed(1)} กม.</span>
        </div>
        <div class="gps-item-name">${closestWater.station.nameTh || "สถานี " + closestWater.station.id}</div>
        <div class="gps-item-meta">อ.${closestWater.station.amphoeNameTh || "-"} • ${closestWater.station.basinNameTh || "-"}</div>
        <div class="gps-item-stats">
          <div>
            <span class="gps-item-val">${closestWater.waterlevelMsl !== null ? closestWater.waterlevelMsl.toFixed(2) : "-"}</span>
            <small style="color:var(--text-muted);">ม.รทก.</small>
          </div>
          <span class="gps-status-pill ${isOver ? 'danger' : closestWater.freeboardM <= 0.5 ? 'warning' : 'safe'}">
            ${isOver ? 'ล้นตลิ่ง ' : 'ต่ำกว่าตลิ่ง '}${fbText}
          </span>
        </div>
      </div>
    `;
  }

  if (closestRain) {
    const r24 = closestRain.rain24h ?? 0;
    html += `
      <div class="gps-item-card" onclick="focusStationOnMap(${closestRain.station.id})">
        <div class="gps-item-top">
          <span class="gps-type-tag">🌧️ สถานีวัดน้ำฝนใกล้ที่สุด</span>
          <span class="gps-dist-badge">${minRainDist.toFixed(1)} กม.</span>
        </div>
        <div class="gps-item-name">${closestRain.station.nameTh || "สถานี " + closestRain.station.id}</div>
        <div class="gps-item-meta">อ.${closestRain.station.amphoeNameTh || "-"}</div>
        <div class="gps-item-stats">
          <div>
            <span class="gps-item-val" style="color:var(--rain-color);">${r24.toFixed(1)}</span>
            <small style="color:var(--text-muted);">มม. (24 ชม.)</small>
          </div>
          <span class="gps-status-pill ${r24 >= 90 ? 'danger' : r24 >= 35 ? 'warning' : 'safe'}">
            ${r24 >= 90 ? 'ฝนหนักมาก' : r24 >= 35 ? 'ฝนหนัก' : r24 > 0 ? 'มีฝนตก' : 'ไม่มีฝน'}
          </span>
        </div>
      </div>
    `;
  }

  grid.innerHTML = html;

  // วาดหมุด User บนแผนที่
  if (userLocationMarker) map.removeLayer(userLocationMarker);
  if (userLocationCircle) map.removeLayer(userLocationCircle);

  userLocationCircle = L.circle([uLat, uLon], {
    radius: 3000,
    color: "#0ea5e9",
    fillColor: "#0ea5e9",
    fillOpacity: 0.1,
    weight: 1.5,
  }).addTo(map);

  const userIcon = L.divIcon({
    html: `
      <div style="position:relative; width:28px; height:28px; display:flex; align-items:center; justify-content:center;">
        <span style="position:absolute; width:28px; height:28px; border-radius:50%; background:rgba(14,165,233,0.4); animation:rain-ripple 1.2s infinite;"></span>
        <span style="width:14px; height:14px; border-radius:50%; background:#0284c7; border:3px solid #fff; box-shadow:0 2px 8px rgba(0,0,0,0.3);"></span>
      </div>
    `,
    className: "user-loc-divicon",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  const isOver = closestWater && closestWater.freeboardM !== null && closestWater.freeboardM < 0;
  const isWarn = closestWater && closestWater.freeboardM !== null && closestWater.freeboardM <= 0.5;
  const fbText = closestWater ? formatFreeboard(closestWater.freeboardM, { absOnly: true }) : "-";
  const userWaterStatus = closestWater ? (isOver ? `🚨 ล้น ${fbText}` : (isWarn ? `⚠️ เฝ้าระวัง (เหลือ ${fbText})` : `✅ ปกติ (เหลือ ${fbText})`)) : "-";
  const userWaterColor = isOver ? '#dc2626' : (isWarn ? '#d97706' : '#16a34a');

  const userPopupHtml = `
    <div class="map-popup-card user-loc-popup">
      <div class="popup-header">
        <span class="popup-tag" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd;">
          📍 ตำแหน่งของคุณ
        </span>
        <h4>พิกัดปัจจุบัน</h4>
        <p class="popup-loc">${uLat.toFixed(4)}, ${uLon.toFixed(4)}</p>
      </div>
      <div class="popup-data-grid" style="margin-bottom:4px;">
        <div class="popup-data-item">
          <span class="pdl">สถานีน้ำใกล้สุด</span>
          <span class="pdv" style="font-size:0.82rem; color:#0369a1;" title="${closestWater?.station.nameTh || '-'}">
            ${closestWater ? (closestWater.station.nameTh || 'สถานี ' + closestWater.station.id) : '-'}
          </span>
        </div>
        <div class="popup-data-item">
          <span class="pdl">ระยะห่าง</span>
          <span class="pdv" style="color:#2563eb;">${minWaterDist.toFixed(1)} กม.</span>
        </div>
        <div class="popup-data-item" style="grid-column:span 2; margin-top:2px;">
          <span class="pdl">สถานะระดับน้ำจุดใกล้เคียง</span>
          <span class="pdv" style="color:${userWaterColor}; font-size:0.86rem; font-weight:700;">
            ${userWaterStatus}
          </span>
        </div>
      </div>
    </div>
  `;

  userLocationMarker = L.marker([uLat, uLon], { icon: userIcon }).addTo(map);
  userLocationMarker.bindPopup(userPopupHtml, { maxWidth: 300 }).openPopup();

  map.flyTo([uLat, uLon], 12, { duration: 1 });
}

/**
 * 11. Modal & แบบจำลองหน้าตัดตลิ่ง 2D (Cross-Section & Physics Simulator)
 */
async function openWaterModal(stationId) {
  const stationWater = allWaterLevels.find((w) => w.station.id === Number(stationId));
  if (!stationWater) return;

  const st = stationWater.station;
  currentModalStation = {
    id: Number(stationId),
    nameTh: st.nameTh ?? "",
    amphoeNameTh: st.amphoeNameTh ?? "",
    basinNameTh: st.basinNameTh ?? "",
    waterlevelMsl: stationWater.waterlevelMsl,
    minBankMsl: stationWater.minBankMsl,
    waterlevelLocalM: stationWater.waterlevelLocalM,
    freeboardM: stationWater.freeboardM,
    situationLevel: stationWater.situationLevel,
  };

  simOffsetM = 0;
  const slider = document.getElementById("simWaterSlider");
  if (slider) slider.value = "0";
  const badge = document.getElementById("simOffsetBadge");
  if (badge) badge.textContent = "+0.00 ม. (ค่าจริง)";

  document.getElementById("modalStationId").textContent = `ID: ${stationId}`;
  document.getElementById("modalStationName").textContent = st.nameTh || "สถานี " + stationId;
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

  // เริ่มโหลดกราฟและเตรียมแบบจำลอง 2D
  await loadStationGraph();
  startCrossSectionSimulation();
}

function startCrossSectionSimulation() {
  if (crossSectionAnimId) cancelAnimationFrame(crossSectionAnimId);

  function renderLoop() {
    drawCrossSection();
    crossSectionWavePhase += 0.05;
    crossSectionAnimId = requestAnimationFrame(renderLoop);
  }
  renderLoop();
}

function stopCrossSectionSimulation() {
  if (crossSectionAnimId) {
    cancelAnimationFrame(crossSectionAnimId);
    crossSectionAnimId = null;
  }
}

function drawCrossSection() {
  const canvas = document.getElementById("crossSectionCanvas");
  if (!canvas || !currentModalStation) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";

  // ค่าระดับน้ำจริง + ค่าจำลองจาก Slider
  const actualWaterLevel = currentModalStation.waterlevelMsl ?? 100;
  const bankLevel = currentModalStation.minBankMsl ?? (actualWaterLevel + 2);
  const bedLevel = bankLevel - 7; // สมมติท้องน้ำลึก 7 เมตรจากตลิ่ง

  const simulatedWaterLevel = actualWaterLevel + simOffsetM;
  const currentFreeboard = bankLevel - simulatedWaterLevel;
  const isOverflow = currentFreeboard < 0;
  const isWarning = currentFreeboard <= 0.5 && !isOverflow;

  // อัปเดต Capacity Badge
  const capacityPct = Math.round(((simulatedWaterLevel - bedLevel) / (bankLevel - bedLevel)) * 100);
  const capValEl = document.getElementById("csCapacityVal");
  const capBadgeEl = document.getElementById("csCapacityBadge");
  if (capValEl && capBadgeEl) {
    capValEl.textContent = `${capacityPct}% (${isOverflow ? 'น้ำล้นตลิ่ง' : isWarning ? 'เฝ้าระวัง' : 'ปกติ'})`;
    capBadgeEl.className = `cs-capacity-badge ${isOverflow ? 'overflow' : isWarning ? 'warning' : ''}`;
  }

  // 1. Sky / Background Gradient
  const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
  if (isDark) {
    skyGrad.addColorStop(0, "#0b1329");
    skyGrad.addColorStop(1, "#111c38");
  } else {
    skyGrad.addColorStop(0, "#e0f2fe");
    skyGrad.addColorStop(1, "#f8fafc");
  }
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, width, height);

  // คำนวณพิกัด Y
  const bankY = 70;
  const bedY = height - 40;
  const bankRange = bedY - bankY;
  
  // ระดับน้ำ Y
  const waterRatio = Math.max(0, Math.min(1.3, (simulatedWaterLevel - bedLevel) / (bankLevel - bedLevel)));
  const waterSurfaceY = bedY - (waterRatio * bankRange);

  // 2. วาดพื้นดินตลิ่งซ้ายและขวา (Embankment Ground)
  ctx.fillStyle = isDark ? "#451a03" : "#78350f";
  ctx.beginPath();
  // ตลิ่งซ้าย
  ctx.moveTo(0, bankY);
  ctx.lineTo(130, bankY);
  ctx.bezierCurveTo(170, bankY + 20, 210, bedY, 260, bedY);
  // ท้องน้ำ
  ctx.lineTo(width - 260, bedY);
  // ตลิ่งขวา
  ctx.bezierCurveTo(width - 210, bedY, width - 170, bankY + 20, width - 130, bankY);
  ctx.lineTo(width, bankY);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  // ขอบหญ้าบนตลิ่ง
  ctx.fillStyle = isDark ? "#065f46" : "#15803d";
  ctx.fillRect(0, bankY - 4, 132, 5);
  ctx.fillRect(width - 132, bankY - 4, 132, 5);

  // 3. วาดผิวน้ำพร้อมคลื่น Sine Wave Physics
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(100, height);
  ctx.lineTo(100, waterSurfaceY);

  // วาดลูกคลื่น
  for (let x = 100; x <= width - 100; x += 5) {
    const wave = Math.sin((x * 0.035) + crossSectionWavePhase) * 3 + Math.cos((x * 0.07) - crossSectionWavePhase) * 1.5;
    ctx.lineTo(x, waterSurfaceY + wave);
  }

  ctx.lineTo(width - 100, height);
  ctx.closePath();

  // Water Body Gradient
  const waterGrad = ctx.createLinearGradient(0, waterSurfaceY, 0, height);
  if (isOverflow) {
    waterGrad.addColorStop(0, "rgba(239, 68, 68, 0.85)");
    waterGrad.addColorStop(1, "rgba(185, 28, 28, 0.95)");
  } else if (isWarning) {
    waterGrad.addColorStop(0, "rgba(245, 158, 11, 0.85)");
    waterGrad.addColorStop(1, "rgba(180, 83, 9, 0.95)");
  } else {
    waterGrad.addColorStop(0, "rgba(14, 165, 233, 0.82)");
    waterGrad.addColorStop(1, "rgba(2, 132, 199, 0.95)");
  }
  ctx.fillStyle = waterGrad;
  ctx.fill();
  ctx.restore();

  // 4. วาดทุ่นลอยน้ำ / เรือจำลอง (Floating Marker)
  const boatX = width / 2;
  const boatWave = Math.sin((boatX * 0.035) + crossSectionWavePhase) * 3;
  const boatY = waterSurfaceY + boatWave;

  ctx.save();
  ctx.translate(boatX, boatY);
  ctx.rotate(Math.cos(crossSectionWavePhase) * 0.08);

  // ทุ่น/เรือ
  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.arc(0, -2, 10, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ef4444";
  ctx.fillRect(-2, -14, 4, 12);
  ctx.beginPath();
  ctx.moveTo(2, -14);
  ctx.lineTo(12, -9);
  ctx.lineTo(2, -4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 5. วาดเส้นระดับตลิ่ง (Bank Level Line)
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(40, bankY);
  ctx.lineTo(width - 40, bankY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = isDark ? "#fca5a5" : "#dc2626";
  ctx.font = "bold 12px 'Sarabun', sans-serif";
  ctx.fillText(`🚨 ระดับตลิ่ง: ${bankLevel.toFixed(2)} ม.รทก.`, 45, bankY - 8);

  // 6. เสาวัดระดับน้ำ (Staff Gauge) บนตลิ่ง
  const gaugeX = 140;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(gaugeX, bankY - 30, 16, bedY - bankY + 40);
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(gaugeX, bankY - 30, 16, bedY - bankY + 40);

  // ขีดบอกระยะบนเสา
  ctx.fillStyle = "#0f172a";
  for (let gy = bankY - 20; gy < bedY + 10; gy += 12) {
    ctx.fillRect(gaugeX + 8, gy, 8, 2);
  }

  // 7. ป้ายแสดงระดับน้ำปัจจุบัน
  ctx.fillStyle = isOverflow ? "#dc2626" : isWarning ? "#d97706" : "#0284c7";
  ctx.font = "bold 13px 'Sarabun', sans-serif";
  const waterLabel = `ระดับน้ำ: ${simulatedWaterLevel.toFixed(2)} ม.รทก. (${currentFreeboard >= 0 ? 'ต่ำกว่าตลิ่ง ' + currentFreeboard.toFixed(2) + ' ม.' : 'ล้นตลิ่ง ' + Math.abs(currentFreeboard).toFixed(2) + ' ม.'})`;
  ctx.fillText(waterLabel, width / 2 - 120, waterSurfaceY - 14);
}

/**
 * 12. Social Share Snapshot Infographic Card Generator
 */
let appLogoImage = null;

function getAppLogoImage() {
  if (appLogoImage) return Promise.resolve(appLogoImage);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = "logo.jpg";
    img.onload = () => {
      appLogoImage = img;
      resolve(img);
    };
    img.onerror = () => {
      resolve(null);
    };
  });
}

async function openSnapshotModal() {
  document.getElementById("snapshotModalBackdrop").classList.add("open");
  await getAppLogoImage();
  generateSnapshotCard();
}

function generateSnapshotCard() {
  const canvas = document.getElementById("snapshotCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  
  canvas.width = 1200;
  canvas.height = 675;
  const width = canvas.width;
  const height = canvas.height;

  // Helper สำหรับวาดกล่องโค้งมนแบบ Glassmorphism
  function drawRoundedRect(x, y, w, h, radius, fillStyle, strokeStyle, lineWidth = 1) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 1. Background Gradient (Deep Modern Navy / Space Blue)
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, "#070d1e");
  bgGrad.addColorStop(0.35, "#0b1528");
  bgGrad.addColorStop(0.7, "#0f1c35");
  bgGrad.addColorStop(1, "#080e1c");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // 2. Ambient Glow & Lighting Effects
  const glow1 = ctx.createRadialGradient(150, 100, 10, 150, 100, 420);
  glow1.addColorStop(0, "rgba(56, 189, 248, 0.16)");
  glow1.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, width, height);

  const glow2 = ctx.createRadialGradient(width - 180, 180, 20, width - 180, 180, 480);
  glow2.addColorStop(0, "rgba(244, 114, 182, 0.15)"); // Subtle pink bloom matching lotus logo
  glow2.addColorStop(1, "rgba(244, 114, 182, 0)");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, width, height);

  const glow3 = ctx.createRadialGradient(width / 2, height - 40, 20, width / 2, height - 40, 380);
  glow3.addColorStop(0, "rgba(16, 185, 129, 0.08)");
  glow3.addColorStop(1, "rgba(16, 185, 129, 0)");
  ctx.fillStyle = glow3;
  ctx.fillRect(0, 0, width, height);

  // Subtle Wave Decorative Lines at bottom
  ctx.save();
  ctx.fillStyle = "rgba(14, 165, 233, 0.04)";
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 30) {
    ctx.lineTo(x, height - 85 + Math.sin(x * 0.012) * 20);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(59, 130, 246, 0.03)";
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 30) {
    ctx.lineTo(x, height - 55 + Math.cos(x * 0.015) * 18);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 3. HEADER AREA (y: 28 to 110)
  // Live Status Badge
  drawRoundedRect(45, 34, 140, 26, 13, "rgba(239, 68, 68, 0.18)", "rgba(239, 68, 68, 0.5)", 1.2);
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(58, 47, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fca5a5";
  ctx.font = "bold 12px 'Sarabun', sans-serif";
  ctx.fillText("LIVE REPORT", 70, 51);

  // Top-Right: Official Brand Card with Logo Image
  const brandCardW = 285;
  const brandCardH = 68;
  const brandCardX = width - brandCardW - 45;
  const brandCardY = 28;

  drawRoundedRect(brandCardX, brandCardY, brandCardW, brandCardH, 16, "rgba(255, 255, 255, 0.05)", "rgba(244, 114, 182, 0.35)", 1.2);

  // Draw Circular Cropped Logo Image
  const logoSize = 54;
  const logoX = brandCardX + 8;
  const logoY = brandCardY + (brandCardH - logoSize) / 2;

  if (appLogoImage) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.clip();
    ctx.drawImage(appLogoImage, logoX, logoY, logoSize, logoSize);
    ctx.restore();

    // Subtle pink ring border matching the lotus theme
    ctx.beginPath();
    ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(244, 114, 182, 0.8)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Brand text next to logo
  const textX = logoX + logoSize + 12;
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 15px 'Sarabun', sans-serif";
  ctx.fillText("UBON WATCH", textX, brandCardY + 28);

  ctx.fillStyle = "#f472b6";
  ctx.font = "700 13.5px 'Sarabun', sans-serif";
  ctx.fillText(": อุบลช่วยกัน", textX + 98, brandCardY + 28);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 11px 'Sarabun', sans-serif";
  ctx.fillText("แจ้งข่าว • แจ้งเหตุ • เตือนภัยน้ำ", textX, brandCardY + 50);

  // Main Title
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 23px 'Sarabun', sans-serif";
  ctx.fillText("รายงานสรุปสถานการณ์น้ำ & ปริมาณฝน จ.อุบลราชธานี", 45, 86);

  // Subtitle / Date / Time
  const now = new Date();
  const dateStr = now.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) + " น.";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "500 13px 'Sarabun', sans-serif";
  ctx.fillText(`ข้อมูล ณ วันที่ ${dateStr} เวลา ${timeStr} • สถาบันสารสนเทศทรัพยากรน้ำ (HII) / ThaiWater`, 45, 108);

  // 4. KPI STATS CARDS (4 Cards Grid, y: 125, h: 100)
  let overflowCount = 0;
  let warningCount = 0;
  let normalCount = 0;
  allWaterLevels.forEach((w) => {
    if (w.freeboardM !== null && w.freeboardM < 0) overflowCount++;
    else if (w.freeboardM !== null && w.freeboardM <= 0.5) warningCount++;
    else normalCount++;
  });

  const sortedRain = [...allRainfalls]
    .filter((r) => r.rain24h !== null && r.rain24h > 0)
    .sort((a, b) => (b.rain24h ?? 0) - (a.rain24h ?? 0));
  const topRain = sortedRain[0];
  const maxRainVal = topRain?.rain24h !== null && topRain?.rain24h !== undefined ? topRain.rain24h.toFixed(1) : "0.0";
  const topRainName = topRain ? `${topRain.station.nameTh || topRain.station.id} (อ.${topRain.station.amphoeNameTh || "-"})` : "ไม่มีฝนสะสม";

  const kpis = [
    {
      label: "น้ำล้นตลิ่ง (วิกฤต)",
      val: overflowCount,
      unit: "สถานี",
      sub: overflowCount > 0 ? "ต้องเฝ้าระวังสูงสุด 🚨" : "ไม่มีจุดวิกฤต",
      color: "#ef4444",
      bg: "rgba(239, 68, 68, 0.12)",
      border: "rgba(239, 68, 68, 0.35)",
    },
    {
      label: "เฝ้าระวังน้ำสูง",
      val: warningCount,
      unit: "สถานี",
      sub: "ต่ำกว่าตลิ่ง ≤ 0.5 ม.",
      color: "#f59e0b",
      bg: "rgba(245, 158, 11, 0.12)",
      border: "rgba(245, 158, 11, 0.35)",
    },
    {
      label: "ระดับน้ำปกติ",
      val: normalCount,
      unit: "สถานี",
      sub: "อยู่ในเกณฑ์ปลอดภัย ✅",
      color: "#10b981",
      bg: "rgba(16, 185, 129, 0.12)",
      border: "rgba(16, 185, 129, 0.35)",
    },
    {
      label: "ฝนสะสม 24 ชม. สูงสุด",
      val: maxRainVal,
      unit: "มม.",
      sub: topRainName.length > 22 ? topRainName.slice(0, 20) + "..." : topRainName,
      color: "#38bdf8",
      bg: "rgba(56, 189, 248, 0.12)",
      border: "rgba(56, 189, 248, 0.35)",
    },
  ];

  const cardW = 262;
  const cardH = 100;
  const cardY = 125;
  const gap = 20;

  kpis.forEach((kpi, idx) => {
    const cx = 45 + idx * (cardW + gap);
    drawRoundedRect(cx, cardY, cardW, cardH, 12, kpi.bg, kpi.border, 1.2);

    // Accent left strip
    ctx.fillStyle = kpi.color;
    ctx.beginPath();
    ctx.roundRect(cx, cardY + 12, 4, cardH - 24, 2);
    ctx.fill();

    // Title
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "600 12.5px 'Sarabun', sans-serif";
    ctx.fillText(kpi.label, cx + 18, cardY + 26);

    // Big Value
    ctx.fillStyle = kpi.color;
    ctx.font = "800 32px 'Sarabun', sans-serif";
    ctx.fillText(String(kpi.val), cx + 18, cardY + 65);

    // Unit
    const valWidth = ctx.measureText(String(kpi.val)).width;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 13px 'Sarabun', sans-serif";
    ctx.fillText(kpi.unit, cx + 22 + valWidth, cardY + 63);

    // Subtitle
    ctx.fillStyle = "#94a3b8";
    ctx.font = "400 11px 'Sarabun', sans-serif";
    ctx.fillText(kpi.sub, cx + 18, cardY + 87);
  });

  // 5. TWO COLUMNS DETAIL SECTION (y: 245 to 575)
  const colY = 245;
  const colH = 330;
  const col1W = 545;
  const col2W = 545;
  const col1X = 45;
  const col2X = 610;

  // --- COLUMN 1: สถานีระดับน้ำสำคัญ (Left) ---
  drawRoundedRect(col1X, colY, col1W, colH, 14, "rgba(255, 255, 255, 0.03)", "rgba(255, 255, 255, 0.08)", 1);

  // Column 1 Header
  ctx.fillStyle = "#38bdf8";
  ctx.font = "700 15px 'Sarabun', sans-serif";
  ctx.fillText("🌊 จุดตรวจวัดระดับน้ำสำคัญ & เสี่ยงล้นตลิ่ง", col1X + 18, colY + 30);
  ctx.fillStyle = "#64748b";
  ctx.font = "400 12px 'Sarabun', sans-serif";
  ctx.fillText("ระยะพ้นตลิ่ง (ม.)", col1X + col1W - 110, colY + 30);

  // Top Water Stations (prioritize overflow -> warning -> first stations)
  const sortedWater = [...allWaterLevels].sort((a, b) => {
    const aOver = a.freeboardM !== null && a.freeboardM < 0 ? -100 : (a.freeboardM ?? 999);
    const bOver = b.freeboardM !== null && b.freeboardM < 0 ? -100 : (b.freeboardM ?? 999);
    return aOver - bOver;
  }).slice(0, 4);

  sortedWater.forEach((st, idx) => {
    const rowY = colY + 48 + idx * 68;
    const isOver = st.freeboardM !== null && st.freeboardM < 0;
    const isWarn = !isOver && st.freeboardM !== null && st.freeboardM <= 0.5;

    let rowBg = "rgba(255, 255, 255, 0.02)";
    let rowBorder = "rgba(255, 255, 255, 0.05)";
    let badgeBg = "rgba(16, 185, 129, 0.15)";
    let badgeBorder = "rgba(16, 185, 129, 0.4)";
    let badgeColor = "#10b981";
    let badgeText = "ปกติ";

    if (isOver) {
      rowBg = "rgba(239, 68, 68, 0.08)";
      rowBorder = "rgba(239, 68, 68, 0.25)";
      badgeBg = "rgba(239, 68, 68, 0.2)";
      badgeBorder = "rgba(239, 68, 68, 0.5)";
      badgeColor = "#ef4444";
      badgeText = `ล้นตลิ่ง ${Math.abs(st.freeboardM).toFixed(2)} ม.`;
    } else if (isWarn) {
      rowBg = "rgba(245, 158, 11, 0.08)";
      rowBorder = "rgba(245, 158, 11, 0.25)";
      badgeBg = "rgba(245, 158, 11, 0.2)";
      badgeBorder = "rgba(245, 158, 11, 0.5)";
      badgeColor = "#f59e0b";
      badgeText = `เฝ้าระวัง (${st.freeboardM.toFixed(2)} ม.)`;
    } else if (st.freeboardM !== null) {
      badgeText = `ต่ำกว่าตลิ่ง ${st.freeboardM.toFixed(2)} ม.`;
    }

    drawRoundedRect(col1X + 14, rowY, col1W - 28, 58, 8, rowBg, rowBorder, 1);

    // Station Name
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 13.5px 'Sarabun', sans-serif";
    const stName = `${idx + 1}. ${st.station.oldcode ? '[' + st.station.oldcode + '] ' : ''}${st.station.nameTh || 'สถานี ' + st.station.id}`;
    const cleanName = stName.length > 32 ? stName.slice(0, 30) + "..." : stName;
    ctx.fillText(cleanName, col1X + 26, rowY + 24);

    // Amphoe & Basin
    ctx.fillStyle = "#94a3b8";
    ctx.font = "400 11.5px 'Sarabun', sans-serif";
    ctx.fillText(`อ.${st.station.amphoeNameTh || "-"} • ระดับน้ำ: ${st.waterlevelMsl !== null ? st.waterlevelMsl.toFixed(2) + ' ม.รทก.' : '-'}`, col1X + 26, rowY + 45);

    // Status Badge on Right
    drawRoundedRect(col1X + col1W - 165, rowY + 16, 140, 26, 6, badgeBg, badgeBorder, 1);
    ctx.fillStyle = badgeColor;
    ctx.font = "700 11.5px 'Sarabun', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(badgeText, col1X + col1W - 95, rowY + 33);
    ctx.textAlign = "left";
  });

  // --- COLUMN 2: สถานีปริมาณฝนสะสมสูงสุด 24 ชม. (Right) ---
  drawRoundedRect(col2X, colY, col2W, colH, 14, "rgba(255, 255, 255, 0.03)", "rgba(255, 255, 255, 0.08)", 1);

  // Column 2 Header
  ctx.fillStyle = "#38bdf8";
  ctx.font = "700 15px 'Sarabun', sans-serif";
  ctx.fillText("🌧️ สถานีปริมาณน้ำฝนสะสมสูงสุด (24 ชม.)", col2X + 18, colY + 30);
  ctx.fillStyle = "#64748b";
  ctx.font = "400 12px 'Sarabun', sans-serif";
  ctx.fillText("ฝน 24 ชม. (มม.)", col2X + col2W - 105, colY + 30);

  const top4Rain = sortedRain.slice(0, 4);

  if (top4Rain.length === 0) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "500 14px 'Sarabun', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ไม่มีรายงานฝนตกสะสมในพื้นที่ จ.อุบลราชธานี ในรอบ 24 ชม.", col2X + col2W / 2, colY + colH / 2);
    ctx.textAlign = "left";
  } else {
    top4Rain.forEach((r, idx) => {
      const rowY = colY + 48 + idx * 68;
      const rainVal = r.rain24h ?? 0;
      let rainColor = "#38bdf8";
      let rainLabel = "ฝนเล็กน้อย";
      if (rainVal >= 90) { rainColor = "#ef4444"; rainLabel = "ฝนหนักมาก"; }
      else if (rainVal >= 35) { rainColor = "#f59e0b"; rainLabel = "ฝนหนัก"; }
      else if (rainVal >= 10) { rainColor = "#10b981"; rainLabel = "ฝนปานกลาง"; }

      drawRoundedRect(col2X + 14, rowY, col2W - 28, 58, 8, "rgba(255, 255, 255, 0.02)", "rgba(255, 255, 255, 0.05)", 1);

      // Station Name
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 13.5px 'Sarabun', sans-serif";
      const rName = `${idx + 1}. ${r.station.nameTh || 'สถานี ' + r.station.id}`;
      const cleanRName = rName.length > 32 ? rName.slice(0, 30) + "..." : rName;
      ctx.fillText(cleanRName, col2X + 26, rowY + 24);

      // Amphoe & Category
      ctx.fillStyle = "#94a3b8";
      ctx.font = "400 11.5px 'Sarabun', sans-serif";
      ctx.fillText(`อ.${r.station.amphoeNameTh || "-"} • ระดับ: `, col2X + 26, rowY + 45);
      ctx.fillStyle = rainColor;
      ctx.font = "600 11.5px 'Sarabun', sans-serif";
      ctx.fillText(rainLabel, col2X + 160, rowY + 45);

      // Rain Value Badge
      drawRoundedRect(col2X + col2W - 130, rowY + 16, 105, 26, 6, "rgba(56, 189, 248, 0.15)", "rgba(56, 189, 248, 0.4)", 1);
      ctx.fillStyle = "#38bdf8";
      ctx.font = "800 13.5px 'Sarabun', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${rainVal.toFixed(1)} มม.`, col2X + col2W - 78, rowY + 34);
      ctx.textAlign = "left";
    });
  }

  // 6. BOTTOM STATUS / VERDICT BAR (y: 592, h: 50)
  const barY = 592;
  const barH = 50;
  let verdictBg = "rgba(16, 185, 129, 0.12)";
  let verdictBorder = "rgba(16, 185, 129, 0.35)";
  let verdictText = `✅ สรุปสถานการณ์: ระดับน้ำแม่น้ำมูล-ชีอยู่ในเกณฑ์ปกติทุกจุดตรวจวัด สภาพอากาศปกติ`;
  let verdictColor = "#10b981";

  if (overflowCount > 0) {
    verdictBg = "rgba(239, 68, 68, 0.15)";
    verdictBorder = "rgba(239, 68, 68, 0.45)";
    verdictText = `🚨 สรุปสถานการณ์: พบน้ำล้นตลิ่ง ${overflowCount} สถานี ขอให้ประชาชนพื้นที่ลุ่มต่ำริมน้ำมูลเตรียมพร้อมรับสถานการณ์`;
    verdictColor = "#ef4444";
  } else if (warningCount > 0) {
    verdictBg = "rgba(245, 158, 11, 0.15)";
    verdictBorder = "rgba(245, 158, 11, 0.45)";
    verdictText = `⚠️ สรุปสถานการณ์: ระดับน้ำอยู่ในเกณฑ์เฝ้าระวัง ${warningCount} สถานี ยังไม่มีรายงานน้ำล้นตลิ่งในพื้นที่`;
    verdictColor = "#f59e0b";
  }

  drawRoundedRect(45, barY, width - 90, barH, 10, verdictBg, verdictBorder, 1.2);

  // Verdict Text
  ctx.fillStyle = verdictColor;
  ctx.font = "700 13px 'Sarabun', sans-serif";
  ctx.fillText(verdictText, 62, barY + 31);

  // Website Link watermark
  ctx.fillStyle = "#64748b";
  ctx.font = "500 11.5px 'Sarabun', sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("🌐 water.ubon.online", width - 62, barY + 31);
  ctx.textAlign = "left";
}

function downloadSnapshot() {
  const canvas = document.getElementById("snapshotCanvas");
  if (!canvas) return;
  const link = document.createElement("a");
  link.download = `UBONWATCH_Water_Status_${Date.now()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

async function copySnapshotToClipboard() {
  const canvas = document.getElementById("snapshotCanvas");
  if (!canvas) return;
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      alert("✅ คัดลอกภาพสรุปสถานการณ์ลงคลิปบอร์ดแล้ว! สามารถกดวาง (Ctrl+V) เพื่อแชร์ได้ทันที");
    } catch (err) {
      downloadSnapshot();
    }
  });
}

/**
 * 13. ระบบเสียงแจ้งเตือนสังเคราะห์ (Web Audio API)
 */
function playAlertTone(type = "chime") {
  if (!soundEnabled) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const now = audioCtx.currentTime;
    if (type === "warning" || type === "danger") {
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc1.type = "sine";
      osc2.type = "triangle";

      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.exponentialRampToValueAtTime(587.33, now + 0.25);
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.5);

      osc2.frequency.setValueAtTime(440, now);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(audioCtx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.6);
      osc2.stop(now + 0.6);
    } else {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.1);
      osc.frequency.setValueAtTime(783.99, now + 0.2);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.5);
    }
  } catch (e) {
    console.warn("Audio alert error:", e);
  }
}

function checkCriticalAudioAlert() {
  const hasOverflow = allWaterLevels.some((w) => w.freeboardM !== null && w.freeboardM < 0);
  if (hasOverflow && soundEnabled) {
    playAlertTone("warning");
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem("ubon_sound", soundEnabled ? "true" : "false");
  updateSoundIcon();
  if (soundEnabled) {
    playAlertTone("chime");
  }
}

function updateSoundIcon() {
  const btn = document.getElementById("btnToggleSound");
  if (!btn) return;
  btn.classList.toggle("sound-off", !soundEnabled);
  btn.innerHTML = soundEnabled
    ? `<i data-lucide="volume-2" class="icon-xs"></i>`
    : `<i data-lucide="volume-x" class="icon-xs"></i>`;
  if (typeof lucide !== "undefined") lucide.createIcons();
}

/**
 * 14. ระบบสลับโหมดมืด/สว่าง (Theme Switcher)
 */
function toggleTheme() {
  const newTheme = currentTheme === "light" ? "dark" : "light";
  applyTheme(newTheme, true);
}

function applyTheme(theme, updateMap = true) {
  currentTheme = theme;
  localStorage.setItem("ubon_theme", theme);
  document.documentElement.setAttribute("data-theme", theme);

  const themeIcon = document.getElementById("themeIcon");
  if (themeIcon) {
    themeIcon.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
    if (typeof lucide !== "undefined") lucide.createIcons();
  }

  if (updateMap && map) {
    if (theme === "dark" && currentBaseLayerName === "voyager") {
      switchBaseLayer("dark");
    } else if (theme === "light" && currentBaseLayerName === "dark") {
      switchBaseLayer("voyager");
    }
  }
}

/**
 * 15. ดึงและเรนเดอร์กราฟประวัติระดับน้ำย้อนหลัง (Time-series)
 */
async function loadStationGraph() {
  if (!currentModalStation) return;

  const chartLoader = document.getElementById("chartLoader");
  if (chartLoader) chartLoader.classList.remove("hidden");

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
    if (chartLoader) chartLoader.classList.add("hidden");
  }
}

function renderChart(graphResult) {
  const canvas = document.getElementById("waterLevelChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
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

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";

  const datasets = [
    {
      label: "ระดับน้ำจริง (ม.รทก.)",
      data: waterLevelValues,
      borderColor: isDark ? "#38bdf8" : "#0369a1",
      backgroundColor: isDark ? "rgba(56, 189, 248, 0.15)" : "rgba(3, 105, 161, 0.08)",
      fill: true,
      tension: 0.25,
      spanGaps: true,
      pointRadius: points.length > 50 ? 1 : 3,
      pointHoverRadius: 6,
      borderWidth: 2.5,
      pointBackgroundColor: isDark ? "#38bdf8" : "#0369a1",
    }
  ];

  if (minBankValues.length > 0) {
    datasets.push({
      label: `ระดับตลิ่ง (${minBank.toFixed(2)} ม.รทก.)`,
      data: minBankValues,
      borderColor: "#ef4444",
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
      borderColor: "#f59e0b",
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
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: isDark ? "#cbd5e1" : "#475569", font: { family: "Sarabun, sans-serif", size: 12 } }
        },
        tooltip: {
          backgroundColor: isDark ? "rgba(15, 23, 42, 0.95)" : "rgba(255,255,255,0.97)",
          titleColor: isDark ? "#f8fafc" : "#0f172a",
          bodyColor: isDark ? "#cbd5e1" : "#475569",
          borderColor: isDark ? "#334155" : "#e2e8f0",
          borderWidth: 1,
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
          grid: { color: isDark ? "#1e293b" : "#f1f5f9", drawBorder: false },
          ticks: { color: isDark ? "#64748b" : "#94a3b8", font: { size: 10 }, maxTicksLimit: 12 }
        },
        y: {
          grid: { color: isDark ? "#1e293b" : "#f1f5f9", drawBorder: false },
          ticks: { color: isDark ? "#94a3b8" : "#64748b", font: { family: "Sarabun, sans-serif", size: 11 } }
        }
      }
    }
  });
}

/**
 * 16. แสดงข้อมูลในตาราง
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
          <td><strong>${item.station.nameTh || "-"}</strong></td>
          <td>อ.${item.station.amphoeNameTh || "-"}</td>
          <td>${item.station.basinNameTh || "-"}</td>
          <td><strong style="color:var(--brand-primary);">${item.waterlevelMsl !== null ? item.waterlevelMsl.toFixed(2) : "-"}</strong></td>
          <td>${item.minBankMsl !== null ? item.minBankMsl.toFixed(2) : "-"}</td>
          <td><span style="color:${item.freeboardM !== null && item.freeboardM < 0 ? 'var(--danger)' : 'var(--success)'}; font-weight:700;">${fbSigned}</span></td>
          <td>${statusBadge}</td>
          <td>${obsTime}</td>
          <td>
            <button class="btn-view-graph" onclick="openWaterModal(${item.station.id})">
              🌊 กราฟ & จำลอง
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
          <td><strong>${item.station.nameTh || "-"}</strong></td>
          <td>อ.${item.station.amphoeNameTh || "-"}</td>
          <td>${item.station.basinNameTh || "-"}</td>
          <td>${item.rain1h !== null ? item.rain1h.toFixed(1) : "-"}</td>
          <td><strong style="color:var(--rain-color); font-size:0.95rem;">${item.rain24h !== null ? item.rain24h.toFixed(1) : "-"}</strong></td>
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
 * 17. โฟกัสและซูมไปยังสถานีบนแผนที่
 */
function focusStationOnMap(stationId) {
  const stationIdNum = Number(stationId);
  const st = currentMode === "water"
    ? allWaterLevels.find((w) => w.station.id === stationIdNum)
    : allRainfalls.find((r) => r.station.id === stationIdNum);

  if (!st || !st.station.lat || !st.station.lon) return;

  if (currentView !== "map") {
    const btnMap = document.getElementById("btnViewMap");
    if (btnMap) btnMap.click();
  }

  map.flyTo([st.station.lat, st.station.lon], 13, { duration: 0.8 });

  if (window.innerWidth <= 767) {
    const mapWrapper = document.querySelector(".map-wrapper");
    if (mapWrapper) {
      mapWrapper.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

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
 * 18. Event Listeners Setup
 */
function setupEventListeners() {
  // Mode Switcher
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

    const isRadarActive = Boolean(radarLayer);
    waterMapLegend.classList.toggle("hidden", newMode !== "water" || isRadarActive);
    rainMapLegend.classList.toggle("hidden", newMode !== "rain" || isRadarActive);

    waterLeaderCard.classList.toggle("hidden", newMode !== "water");
    rainLeaderCard.classList.toggle("hidden", newMode !== "rain");

    applyFilters();
  }

  modeBtnWater.addEventListener("click", () => switchMode("water"));
  modeBtnRain.addEventListener("click", () => switchMode("rain"));

  // Alert Banner Click -> Focus first critical station
  const dangerBanner = document.getElementById("dangerAlertBanner");
  if (dangerBanner) {
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

  // Interactive Tools in Navbar
  document.getElementById("btnToggleTheme")?.addEventListener("click", toggleTheme);
  document.getElementById("btnToggleSound")?.addEventListener("click", toggleSound);
  document.getElementById("btnFindNearest")?.addEventListener("click", checkNearbyRisk);
  document.getElementById("btnGpsMap")?.addEventListener("click", checkNearbyRisk);
  document.getElementById("btnCloseGps")?.addEventListener("click", () => {
    document.getElementById("gpsProximityBox").classList.add("hidden");
  });

  document.getElementById("btnToggleRadarNav")?.addEventListener("click", () => toggleRadar());
  document.getElementById("btnToggleRadar")?.addEventListener("click", () => toggleRadar());
  document.getElementById("btnCloseRadar")?.addEventListener("click", () => toggleRadar(false));
  document.getElementById("btnRadarPlay")?.addEventListener("click", playRadarAnimation);
  document.getElementById("radarSlider")?.addEventListener("input", (e) => {
    radarCurrentIndex = parseInt(e.target.value);
    updateRadarDisplay();
  });

  document.getElementById("btnResetMap")?.addEventListener("click", () => {
    map.flyTo(UBON_COORDS, 9.5, { duration: 0.8 });
  });

  // Map Layer Buttons
  document.querySelectorAll(".map-layer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchBaseLayer(btn.dataset.layer);
    });
  });

  // Social Share Snapshot Modal
  document.getElementById("btnShareSnapshot")?.addEventListener("click", openSnapshotModal);
  document.getElementById("btnCloseSnapshotModal")?.addEventListener("click", () => {
    document.getElementById("snapshotModalBackdrop").classList.remove("open");
  });
  document.getElementById("snapshotModalBackdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "snapshotModalBackdrop") {
      document.getElementById("snapshotModalBackdrop").classList.remove("open");
    }
  });
  document.getElementById("btnDownloadSnapshot")?.addEventListener("click", downloadSnapshot);
  document.getElementById("btnCopySnapshot")?.addEventListener("click", copySnapshotToClipboard);

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

  // Amphoe select dropdown
  document.getElementById("amphoeSelect").addEventListener("change", (e) => {
    currentAmphoe = e.target.value;
    currentPage = 1;
    applyFilters();
  });

  // Filter Pills
  document.querySelectorAll("#waterFilterPills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#waterFilterPills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentWaterFilter = pill.dataset.filter;
      currentPage = 1;
      applyFilters();
    });
  });

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
  document.getElementById("tabWaterLevel").addEventListener("click", () => switchMode("water"));
  document.getElementById("tabRainfall").addEventListener("click", () => switchMode("rain"));

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

  // Modal Close & Tab Switching
  document.getElementById("btnCloseModal").addEventListener("click", closeModal);
  document.getElementById("stationModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "stationModalBackdrop") closeModal();
  });

  const btnTabGraph = document.getElementById("btnModalTabGraph");
  const btnTabCross = document.getElementById("btnModalTabCrossSection");
  const graphSection = document.getElementById("modalGraphSection");
  const crossSection = document.getElementById("modalCrossSectionContainer");

  btnTabGraph?.addEventListener("click", () => {
    btnTabGraph.classList.add("active");
    btnTabCross.classList.remove("active");
    graphSection.classList.remove("hidden");
    crossSection.classList.add("hidden");
    currentModalTab = "graph";
    stopCrossSectionSimulation();
  });

  btnTabCross?.addEventListener("click", () => {
    btnTabCross.classList.add("active");
    btnTabGraph.classList.remove("active");
    crossSection.classList.remove("hidden");
    graphSection.classList.add("hidden");
    currentModalTab = "crossSection";
    startCrossSectionSimulation();
  });

  // Simulator Range Slider
  const simSlider = document.getElementById("simWaterSlider");
  const simBadge = document.getElementById("simOffsetBadge");
  const btnResetSim = document.getElementById("btnResetSim");

  simSlider?.addEventListener("input", (e) => {
    simOffsetM = parseFloat(e.target.value);
    const sign = simOffsetM >= 0 ? "+" : "";
    if (simBadge) {
      simBadge.textContent = `${sign}${simOffsetM.toFixed(2)} ม. ${simOffsetM === 0 ? '(ค่าจริง)' : '(จำลอง)'}`;
    }
  });

  btnResetSim?.addEventListener("click", () => {
    simOffsetM = 0;
    if (simSlider) simSlider.value = "0";
    if (simBadge) simBadge.textContent = "+0.00 ม. (ค่าจริง)";
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
  stopCrossSectionSimulation();
}

function padZero(n) {
  return String(n).padStart(2, "0");
}

/**
 * 19. Countdown Timer สำหรับ Auto Refresh
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
