-- 거래량 집계 테이블 (각 거래 시간대별 매수/매도량 추적)
CREATE TABLE IF NOT EXISTS trading_volume (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id INTEGER NOT NULL,
  time_window TEXT NOT NULL,  -- 거래 시간대 (예: '2024-01-15 08:00')
  buy_volume INTEGER DEFAULT 0,  -- 매수 총량
  sell_volume INTEGER DEFAULT 0,  -- 매도 총량
  net_volume INTEGER DEFAULT 0,  -- 순 거래량 (매수 - 매도)
  price_before REAL NOT NULL,  -- 이전 가격
  price_after REAL,  -- 조정 후 가격
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME,  -- 주가 반영 시각
  FOREIGN KEY (stock_id) REFERENCES stocks(id),
  UNIQUE(stock_id, time_window)
);

-- 주가 변동 설정 테이블 (관리자가 주가 변동 민감도 조절)
CREATE TABLE IF NOT EXISTS price_impact_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id INTEGER NOT NULL,
  impact_rate REAL DEFAULT 0.01,  -- 기본 영향률 1% (거래량 100주당 가격 변동률)
  max_change_rate REAL DEFAULT 0.05,  -- 최대 변동률 5%
  min_volume INTEGER DEFAULT 10,  -- 최소 거래량 (이하는 주가 미반영)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stock_id) REFERENCES stocks(id),
  UNIQUE(stock_id)
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_trading_volume_stock_id ON trading_volume(stock_id);
CREATE INDEX IF NOT EXISTS idx_trading_volume_time_window ON trading_volume(time_window);
CREATE INDEX IF NOT EXISTS idx_trading_volume_applied ON trading_volume(applied_at);
