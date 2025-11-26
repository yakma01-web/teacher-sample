-- 예약 주가 변경 테이블
CREATE TABLE IF NOT EXISTS pending_price_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id INTEGER NOT NULL,
  new_price REAL NOT NULL,
  changed_by TEXT NOT NULL,  -- 관리자 username
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' or 'applied'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME,
  FOREIGN KEY (stock_id) REFERENCES stocks(id)
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_pending_price_updates_status ON pending_price_updates(status);
CREATE INDEX IF NOT EXISTS idx_pending_price_updates_stock_id ON pending_price_updates(stock_id);
