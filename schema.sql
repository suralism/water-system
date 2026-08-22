-- 1. ตารางข้อมูลสถานีและระดับวิกฤต (Stations & Thresholds)
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY,
    oldcode TEXT,
    name_th TEXT,
    name_en TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    province_code TEXT,
    province_name_th TEXT,
    amphoe_name_th TEXT,
    tumbon_name_th TEXT,
    basin_name_th TEXT,
    agency_name_th TEXT,
    min_bank_msl REAL,
    warning_level_msl REAL,
    critical_level_msl REAL,
    ground_level_msl REAL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stations_province ON stations(province_code);
CREATE INDEX IF NOT EXISTS idx_stations_amphoe ON stations(amphoe_name_th);

-- 2. ตารางประวัติระดับน้ำแบบ Time-Series (Water Level History)
-- Primary Key ป้องกันข้อมูล ณ เวลาเดียวกันของสถานีเดียวกันซ้ำ 100%
CREATE TABLE IF NOT EXISTS water_level_history (
    station_id INTEGER NOT NULL,
    observed_at TEXT NOT NULL,          -- ISO-8601 UTC String (e.g. 2026-08-22T02:00:00.000Z)
    waterlevel_msl REAL,                -- ระดับน้ำ ม.รทก.
    waterlevel_local_m REAL,            -- ระดับน้ำเทียบท้องน้ำ (ม.)
    freeboard_m REAL,                   -- ระยะพ้นตลิ่ง (ม.)
    situation_level INTEGER,            -- ระดับสถานการณ์ 1-5
    storage_percent REAL,               -- % ความจุ
    discharge REAL,                     -- อัตราการไหล ลบ.ม./วิ
    created_at TEXT NOT NULL,
    PRIMARY KEY (station_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_water_hist_station_time ON water_level_history(station_id, observed_at ASC);

-- 3. ตารางประวัติน้ำฝนแบบ Time-Series (Rainfall History)
CREATE TABLE IF NOT EXISTS rainfall_history (
    station_id INTEGER NOT NULL,
    observed_at TEXT NOT NULL,          -- ISO-8601 UTC String
    rain24h REAL,                       -- ฝนสะสม 24 ชม. (มม.)
    rain1h REAL,                        -- ฝนสะสม 1 ชม. (มม.)
    created_at TEXT NOT NULL,
    PRIMARY KEY (station_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_rain_hist_station_time ON rainfall_history(station_id, observed_at ASC);
