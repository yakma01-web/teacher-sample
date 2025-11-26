import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS 설정
app.use('/api/*', cors())

// Static files
app.use('/static/*', serveStatic({ root: './public' }))

// ==================== 유틸리티 함수 ====================

// 한국 시간(KST, UTC+9) 가져오기
function getKoreanTime(): Date {
  // 현재 UTC 시간을 가져와서 한국 시간(UTC+9)으로 변환
  const now = new Date()
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000)
  const kst = new Date(utc + (9 * 60 * 60 * 1000))
  return kst
}

// 베타 테스트 기간 확인 함수 (2025년 11월 16일 20:00까지)
function isBetaTestPeriod(): boolean {
  const now = getKoreanTime() // 한국 시간 기준
  const betaEndDate = new Date('2025-11-16T20:00:00') // 한국 시간 20:00
  // betaEndDate는 이미 한국 시간 기준이므로 직접 비교
  const nowKst = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds())
  return nowKst < betaEndDate
}

// 거래 가능 시간 체크 함수 (항상 거래 가능)
function isTradingTime(): { allowed: boolean; message?: string; isBeta?: boolean } {
  // 모든 유저 24시간 거래 가능
  return { 
    allowed: true, 
    message: '✅ 24시간 거래 가능!' 
  }
}

// 현재 거래 시간 윈도우 가져오기 (예: '2024-01-15 08:00')
function getCurrentTimeWindow(): string {
  const now = getKoreanTime() // 한국 시간 기준
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:00`
}

// 거래량 집계 및 저장 함수
async function aggregateTradingVolume(db: D1Database, stockId: number, type: 'BUY' | 'SELL', quantity: number) {
  try {
    const timeWindow = getCurrentTimeWindow()
    
    // 현재 주가 조회 (Foreign Key 체크)
    const stock = await db.prepare(
      'SELECT current_price FROM stocks WHERE id = ?'
    ).bind(stockId).first()
    
    if (!stock) {
      console.error(`[aggregateTradingVolume] Stock not found: stockId=${stockId}`)
      return
    }
    
    // 거래량 집계 레코드 확인
    const existing = await db.prepare(
      'SELECT * FROM trading_volume WHERE stock_id = ? AND time_window = ?'
    ).bind(stockId, timeWindow).first()
    
    if (existing) {
      // 기존 레코드 업데이트
      if (type === 'BUY') {
        await db.prepare(`
          UPDATE trading_volume 
          SET buy_volume = buy_volume + ?, 
              net_volume = (buy_volume + ?) - sell_volume
          WHERE stock_id = ? AND time_window = ?
        `).bind(quantity, quantity, stockId, timeWindow).run()
      } else {
        await db.prepare(`
          UPDATE trading_volume 
          SET sell_volume = sell_volume + ?, 
              net_volume = buy_volume - (sell_volume + ?)
          WHERE stock_id = ? AND time_window = ?
        `).bind(quantity, quantity, stockId, timeWindow).run()
      }
    } else {
      // 새 레코드 생성
      const buyVolume = type === 'BUY' ? quantity : 0
      const sellVolume = type === 'SELL' ? quantity : 0
      const netVolume = buyVolume - sellVolume
      
      await db.prepare(`
        INSERT INTO trading_volume 
        (stock_id, time_window, buy_volume, sell_volume, net_volume, price_before)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(stockId, timeWindow, buyVolume, sellVolume, netVolume, stock.current_price).run()
    }
  } catch (error) {
    console.error('[aggregateTradingVolume] Error:', error, `stockId=${stockId}, type=${type}, quantity=${quantity}`)
    // 에러가 발생해도 거래는 완료되도록 함 (거래량 집계는 부수적 기능)
  }
}

// 주가 자동 업데이트 함수 (거래량 기반)
async function updateStockPrices(db: D1Database) {
  try {
    const timeWindow = getCurrentTimeWindow()
    
    // 미적용 거래량 데이터 조회
    const volumes = await db.prepare(`
      SELECT tv.*, s.current_price, s.code, s.name,
             COALESCE(pis.impact_rate, 0.01) as impact_rate,
             COALESCE(pis.max_change_rate, 0.05) as max_change_rate,
             COALESCE(pis.min_volume, 10) as min_volume
      FROM trading_volume tv
      JOIN stocks s ON tv.stock_id = s.id
      LEFT JOIN price_impact_settings pis ON tv.stock_id = pis.stock_id
      WHERE tv.time_window = ? AND tv.applied_at IS NULL
    `).bind(timeWindow).all()
    
    if (!volumes.results || volumes.results.length === 0) {
      return { updated: 0, message: '업데이트할 거래량 데이터가 없습니다.' }
    }
    
    let updatedCount = 0
    
    for (const vol of volumes.results) {
      try {
        // Foreign Key 체크: 주식이 존재하는지 확인
        const stockExists = await db.prepare(
          'SELECT id FROM stocks WHERE id = ?'
        ).bind(vol.stock_id).first()
        
        if (!stockExists) {
          console.error(`[updateStockPrices] Stock not found: stockId=${vol.stock_id}`)
          continue
        }
        
        // 최소 거래량 체크
        const totalVolume = vol.buy_volume + vol.sell_volume
        if (totalVolume < vol.min_volume) {
          // 거래량이 너무 적으면 주가 미반영
          await db.prepare(`
            UPDATE trading_volume 
            SET applied_at = CURRENT_TIMESTAMP, price_after = price_before
            WHERE id = ?
          `).bind(vol.id).run()
          continue
        }
        
        // 주가 변동 계산
        // 순 거래량(net_volume)에 따라 가격 변동
        // 양수면 매수 우세 -> 가격 상승, 음수면 매도 우세 -> 가격 하락
        const priceChangeRate = (vol.net_volume / 100) * vol.impact_rate
        
        // 최대 변동률 제한
        const limitedChangeRate = Math.max(
          -vol.max_change_rate,
          Math.min(vol.max_change_rate, priceChangeRate)
        )
        
        const newPrice = Math.round(vol.current_price * (1 + limitedChangeRate))
        
        // 주가 업데이트
        await db.prepare(`
          UPDATE stocks 
          SET current_price = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(newPrice, vol.stock_id).run()
        
        // 가격 변동 이력 저장
        await db.prepare(`
          INSERT INTO price_history (stock_id, price, changed_by)
          VALUES (?, ?, ?)
        `).bind(vol.stock_id, newPrice, 'AUTO_UPDATE').run()
        
        // 거래량 데이터 업데이트
        await db.prepare(`
          UPDATE trading_volume 
          SET price_after = ?, applied_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(newPrice, vol.id).run()
        
        updatedCount++
      } catch (error) {
        console.error(`[updateStockPrices] Error updating stock ${vol.stock_id}:`, error)
        // 개별 주식 업데이트 실패해도 다른 주식은 계속 처리
      }
    }
    
    return { 
      updated: updatedCount, 
      message: `${updatedCount}개 종목의 주가가 업데이트되었습니다.` 
    }
  } catch (error) {
    console.error('[updateStockPrices] Fatal error:', error)
    return { updated: 0, message: '주가 업데이트 중 오류가 발생했습니다.', error: String(error) }
  }
}

// 현재 거래 시간 상태 조회 API
app.get('/api/trading-status', (c) => {
  const status = isTradingTime()
  const kstTime = getKoreanTime()
  return c.json({
    allowed: status.allowed,
    isBeta: status.isBeta || false,
    message: status.message || '거래 가능 시간입니다.',
    currentTime: kstTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  })
})

// ==================== 인증 API ====================

// 학생/교사 로그인
app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json()
  
  const user = await c.env.DB.prepare(
    'SELECT id, username, name, user_type, cash, password_changed FROM users WHERE username = ? AND password = ?'
  ).bind(username, password).first()
  
  if (!user) {
    return c.json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' }, 401)
  }
  
  return c.json({ user })
})

// 비밀번호 변경
app.post('/api/auth/change-password', async (c) => {
  const { userId, oldPassword, newPassword } = await c.req.json()
  
  // 현재 비밀번호 확인
  const user = await c.env.DB.prepare(
    'SELECT id FROM users WHERE id = ? AND password = ?'
  ).bind(userId, oldPassword).first()
  
  if (!user) {
    return c.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, 400)
  }
  
  // 비밀번호 변경
  await c.env.DB.prepare(
    'UPDATE users SET password = ?, password_changed = 1 WHERE id = ?'
  ).bind(newPassword, userId).run()
  
  return c.json({ success: true, message: '비밀번호가 변경되었습니다.' })
})

// 학생 회원가입
app.post('/api/auth/register', async (c) => {
  const { username, password, name } = await c.req.json()
  
  // 중복 체크
  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(username).first()
  
  if (existing) {
    return c.json({ error: '이미 존재하는 아이디입니다.' }, 400)
  }
  
  // 사용자 생성
  const result = await c.env.DB.prepare(
    'INSERT INTO users (username, password, name, cash) VALUES (?, ?, ?, ?)'
  ).bind(username, password, name, 1000000.0).run()
  
  const user = await c.env.DB.prepare(
    'SELECT id, username, name, cash FROM users WHERE id = ?'
  ).bind(result.meta.last_row_id).first()
  
  return c.json({ user })
})

// 관리자 로그인
app.post('/api/auth/admin-login', async (c) => {
  const { username, password } = await c.req.json()
  
  const admin = await c.env.DB.prepare(
    'SELECT id, username FROM admins WHERE username = ? AND password = ?'
  ).bind(username, password).first()
  
  if (!admin) {
    return c.json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' }, 401)
  }
  
  return c.json({ admin })
})

// ==================== 주식 API ====================

// 모든 주식 목록 조회 (예약된 주가 포함)
app.get('/api/stocks', async (c) => {
  const stocks = await c.env.DB.prepare(
    'SELECT * FROM stocks ORDER BY id'
  ).all()
  
  // 예약된 주가 변경 가져오기
  const pending = await c.env.DB.prepare(
    'SELECT stock_id, new_price FROM pending_price_updates WHERE status = ?'
  ).bind('pending').all()
  
  // 각 주식의 이전 가격 가져오기 (price_history에서 최근 2개)
  const stocksWithData = await Promise.all(stocks.results.map(async (stock) => {
    const pendingUpdate = pending.results.find(p => p.stock_id === stock.id)
    
    // 가격 이력에서 최근 2개 가져오기 (현재 가격 제외)
    const history = await c.env.DB.prepare(
      'SELECT price FROM price_history WHERE stock_id = ? ORDER BY created_at DESC LIMIT 2'
    ).bind(stock.id).all()
    
    // 이전 가격 결정: price_history가 있으면 사용, 없으면 현재 가격 사용
    let previous_price = stock.current_price
    if (history.results && history.results.length > 0) {
      // 가장 최근 이력의 가격을 이전 가격으로 사용
      previous_price = history.results[0].price
    }
    
    return {
      ...stock,
      pending_price: pendingUpdate ? pendingUpdate.new_price : null,
      previous_price: previous_price
    }
  }))
  
  return c.json({ stocks: stocksWithData })
})

// 특정 주식 상세 조회
app.get('/api/stocks/:id', async (c) => {
  const stockId = c.req.param('id')
  
  const stock = await c.env.DB.prepare(
    'SELECT * FROM stocks WHERE id = ?'
  ).bind(stockId).first()
  
  if (!stock) {
    return c.json({ error: '주식을 찾을 수 없습니다.' }, 404)
  }
  
  // 주가 변동 이력
  const history = await c.env.DB.prepare(
    'SELECT * FROM price_history WHERE stock_id = ? ORDER BY created_at DESC LIMIT 20'
  ).bind(stockId).all()
  
  return c.json({ stock, history: history.results })
})

// 주가 업데이트 (관리자 전용 - 24시간 가능, 거래 시간에 자동 반영)
app.post('/api/stocks/:id/update-price', async (c) => {
  try {
    const stockId = c.req.param('id')
    const { price, adminUsername, forceApply } = await c.req.json()
    
    // 관리자 인증 확인
    const admin = await c.env.DB.prepare(
      'SELECT id FROM admins WHERE username = ?'
    ).bind(adminUsername).first()
    
    if (!admin) {
      return c.json({ error: '권한이 없습니다.' }, 403)
    }
    
    // Foreign Key 체크: 주식이 존재하는지 확인
    const stockExists = await c.env.DB.prepare(
      'SELECT id FROM stocks WHERE id = ?'
    ).bind(stockId).first()
    
    if (!stockExists) {
      return c.json({ error: '주식을 찾을 수 없습니다.' }, 404)
    }
    
    // 거래 시간 확인
    const tradingStatus = isTradingTime()
    
    // 강제 즉시 반영 또는 거래 시간이면 즉시 반영
    if (forceApply || tradingStatus.allowed) {
      // 즉시 반영
      await c.env.DB.prepare(
        'UPDATE stocks SET current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(price, stockId).run()
      
      // 주가 변동 이력 저장
      const changeNote = forceApply ? `${adminUsername} (강제 반영)` : adminUsername
      await c.env.DB.prepare(
        'INSERT INTO price_history (stock_id, price, changed_by) VALUES (?, ?, ?)'
      ).bind(stockId, price, changeNote).run()
      
      // 기존 예약이 있으면 삭제
      await c.env.DB.prepare(
        'DELETE FROM pending_price_updates WHERE stock_id = ? AND status = ?'
      ).bind(stockId, 'pending').run()
      
      const stock = await c.env.DB.prepare(
        'SELECT * FROM stocks WHERE id = ?'
      ).bind(stockId).first()
      
      return c.json({ 
        stock, 
        message: forceApply ? '주가가 강제로 즉시 반영되었습니다.' : '주가가 즉시 반영되었습니다.',
        applied: true,
        forced: forceApply || false
      })
    } else {
      // 거래 시간이 아니면 예약으로 저장
      // 기존 대기 중인 업데이트가 있으면 삭제
      await c.env.DB.prepare(
        'DELETE FROM pending_price_updates WHERE stock_id = ? AND status = ?'
      ).bind(stockId, 'pending').run()
      
      // 새로운 예약 추가
      await c.env.DB.prepare(
        'INSERT INTO pending_price_updates (stock_id, new_price, changed_by) VALUES (?, ?, ?)'
      ).bind(stockId, price, adminUsername).run()
      
      const stock = await c.env.DB.prepare(
        'SELECT * FROM stocks WHERE id = ?'
      ).bind(stockId).first()
      
      return c.json({ 
        stock: { ...stock, pending_price: price },
        message: '주가 변경이 예약되었습니다. 다음 거래 시간에 자동으로 반영됩니다.',
        applied: false,
        pending: true
      })
    }
  } catch (error) {
    console.error('[update-price] Error:', error)
    return c.json({ error: '주가 변경 중 오류가 발생했습니다.' }, 500)
  }
})

// 예약된 주가 변경 목록 조회
app.get('/api/pending-price-updates', async (c) => {
  const pending = await c.env.DB.prepare(`
    SELECT p.*, s.code, s.name, s.current_price
    FROM pending_price_updates p
    JOIN stocks s ON p.stock_id = s.id
    WHERE p.status = 'pending'
    ORDER BY p.created_at DESC
  `).all()
  
  return c.json({ pending: pending.results })
})

// 예약된 주가 변경 적용 (거래 시간에 자동 호출)
app.post('/api/apply-pending-prices', async (c) => {
  try {
    // 거래 시간 확인
    const tradingStatus = isTradingTime()
    if (!tradingStatus.allowed) {
      return c.json({ error: '거래 시간이 아닙니다.' }, 400)
    }
    
    // 모든 대기 중인 주가 변경 가져오기
    const pending = await c.env.DB.prepare(
      'SELECT * FROM pending_price_updates WHERE status = ? ORDER BY created_at ASC'
    ).bind('pending').all()
    
    let appliedCount = 0
    
    // 각 주가 변경 적용
    for (const update of pending.results) {
      try {
        // Foreign Key 체크: 주식이 존재하는지 확인
        const stockExists = await c.env.DB.prepare(
          'SELECT id FROM stocks WHERE id = ?'
        ).bind(update.stock_id).first()
        
        if (!stockExists) {
          console.error(`[apply-pending-prices] Stock not found: stockId=${update.stock_id}`)
          // 주식이 없으면 예약을 실패로 표시
          await c.env.DB.prepare(
            'UPDATE pending_price_updates SET status = ? WHERE id = ?'
          ).bind('failed', update.id).run()
          continue
        }
        
        // 주가 업데이트
        await c.env.DB.prepare(
          'UPDATE stocks SET current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(update.new_price, update.stock_id).run()
        
        // 주가 변동 이력 저장
        await c.env.DB.prepare(
          'INSERT INTO price_history (stock_id, price, changed_by) VALUES (?, ?, ?)'
        ).bind(update.stock_id, update.new_price, update.changed_by).run()
        
        // 예약 상태 업데이트
        await c.env.DB.prepare(
          'UPDATE pending_price_updates SET status = ?, applied_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind('applied', update.id).run()
        
        appliedCount++
      } catch (error) {
        console.error(`[apply-pending-prices] Error applying update ${update.id}:`, error)
        // 개별 업데이트 실패해도 다른 업데이트는 계속 처리
      }
    }
    
    return c.json({ 
      success: true, 
      message: `${appliedCount}개의 주가 변경이 적용되었습니다.`,
      appliedCount 
    })
  } catch (error) {
    console.error('[apply-pending-prices] Fatal error:', error)
    return c.json({ error: '예약된 주가 변경 적용 중 오류가 발생했습니다.' }, 500)
  }
})

// ==================== 사용자 주식 보유 API ====================

// 사용자 보유 주식 조회
app.get('/api/users/:userId/stocks', async (c) => {
  const userId = c.req.param('userId')
  
  const userStocks = await c.env.DB.prepare(`
    SELECT us.*, s.code, s.name, s.current_price,
           (s.current_price - us.avg_price) * us.quantity as profit,
           ((s.current_price - us.avg_price) / us.avg_price * 100) as profit_rate
    FROM user_stocks us
    JOIN stocks s ON us.stock_id = s.id
    WHERE us.user_id = ? AND us.quantity > 0
  `).bind(userId).all()
  
  return c.json({ userStocks: userStocks.results })
})

// ==================== 거래 API ====================

// 주식 매수
app.post('/api/transactions/buy', async (c) => {
  try {
    const { userId, stockId, quantity } = await c.req.json()
    
    // 거래 시간 확인
    const tradingStatus = isTradingTime()
    if (!tradingStatus.allowed) {
      return c.json({ error: tradingStatus.message }, 400)
    }
    
    // 사용자 정보 조회
    const user = await c.env.DB.prepare(
      'SELECT cash FROM users WHERE id = ?'
    ).bind(userId).first()
    
    if (!user) {
      return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404)
    }
    
    // 주식 정보 조회
    const stock = await c.env.DB.prepare(
      'SELECT current_price FROM stocks WHERE id = ?'
    ).bind(stockId).first()
    
    if (!stock) {
      return c.json({ error: '주식을 찾을 수 없습니다.' }, 404)
    }
    
    const totalAmount = stock.current_price * quantity
    
    // 잔액 확인
    if (user.cash < totalAmount) {
      return c.json({ error: '잔액이 부족합니다.' }, 400)
    }
    
    // 트랜잭션 시작
    // 1. 거래 내역 저장
    await c.env.DB.prepare(
      'INSERT INTO transactions (user_id, stock_id, type, quantity, price, total_amount) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(userId, stockId, 'BUY', quantity, stock.current_price, totalAmount).run()
    
    // 2. 사용자 잔액 차감
    await c.env.DB.prepare(
      'UPDATE users SET cash = cash - ? WHERE id = ?'
    ).bind(totalAmount, userId).run()
    
    // 3. 보유 주식 업데이트
    const existingStock = await c.env.DB.prepare(
      'SELECT quantity, avg_price FROM user_stocks WHERE user_id = ? AND stock_id = ?'
    ).bind(userId, stockId).first()
    
    if (existingStock) {
      // 기존 보유 주식이 있는 경우 평균 매입가 계산
      const totalQuantity = existingStock.quantity + quantity
      const totalValue = (existingStock.avg_price * existingStock.quantity) + (stock.current_price * quantity)
      const newAvgPrice = totalValue / totalQuantity
      
      await c.env.DB.prepare(
        'UPDATE user_stocks SET quantity = ?, avg_price = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND stock_id = ?'
      ).bind(totalQuantity, newAvgPrice, userId, stockId).run()
    } else {
      // 새로운 주식 보유
      await c.env.DB.prepare(
        'INSERT INTO user_stocks (user_id, stock_id, quantity, avg_price) VALUES (?, ?, ?, ?)'
      ).bind(userId, stockId, quantity, stock.current_price).run()
    }
    
    // 4. 거래량 집계
    await aggregateTradingVolume(c.env.DB, stockId, 'BUY', quantity)
    
    return c.json({ success: true, message: '매수가 완료되었습니다.' })
  } catch (error) {
    console.error('매수 오류:', error)
    return c.json({ error: '거래 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }, 500)
  }
})

// 주식 매도
app.post('/api/transactions/sell', async (c) => {
  try {
    const { userId, stockId, quantity } = await c.req.json()
    
    // 거래 시간 확인
    const tradingStatus = isTradingTime()
    if (!tradingStatus.allowed) {
      return c.json({ error: tradingStatus.message }, 400)
    }
    
    // 보유 주식 확인
    const userStock = await c.env.DB.prepare(
      'SELECT quantity, avg_price FROM user_stocks WHERE user_id = ? AND stock_id = ?'
    ).bind(userId, stockId).first()
    
    if (!userStock || userStock.quantity < quantity) {
      return c.json({ error: '보유 수량이 부족합니다.' }, 400)
    }
    
    // 주식 정보 조회
    const stock = await c.env.DB.prepare(
      'SELECT current_price FROM stocks WHERE id = ?'
    ).bind(stockId).first()
    
    if (!stock) {
      return c.json({ error: '주식을 찾을 수 없습니다.' }, 404)
    }
    
    const totalAmount = stock.current_price * quantity
    
    // 트랜잭션 시작
    // 1. 거래 내역 저장
    await c.env.DB.prepare(
      'INSERT INTO transactions (user_id, stock_id, type, quantity, price, total_amount) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(userId, stockId, 'SELL', quantity, stock.current_price, totalAmount).run()
    
    // 2. 사용자 잔액 증가
    await c.env.DB.prepare(
      'UPDATE users SET cash = cash + ? WHERE id = ?'
    ).bind(totalAmount, userId).run()
    
    // 3. 보유 주식 업데이트
    const newQuantity = userStock.quantity - quantity
    if (newQuantity === 0) {
      // 모두 매도한 경우 삭제
      await c.env.DB.prepare(
        'DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?'
      ).bind(userId, stockId).run()
    } else {
      await c.env.DB.prepare(
        'UPDATE user_stocks SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND stock_id = ?'
      ).bind(newQuantity, userId, stockId).run()
    }
    
    // 4. 거래량 집계
    await aggregateTradingVolume(c.env.DB, stockId, 'SELL', quantity)
    
    return c.json({ success: true, message: '매도가 완료되었습니다.' })
  } catch (error) {
    console.error('매도 오류:', error)
    return c.json({ error: '거래 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }, 500)
  }
})

// 거래 내역 조회
app.get('/api/transactions/:userId', async (c) => {
  const userId = c.req.param('userId')
  
  const transactions = await c.env.DB.prepare(`
    SELECT t.*, s.code, s.name
    FROM transactions t
    JOIN stocks s ON t.stock_id = s.id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
    LIMIT 50
  `).bind(userId).all()
  
  return c.json({ transactions: transactions.results })
})

// ==================== 거래량 기반 주가 업데이트 API ====================

// 주가 자동 업데이트 실행 (수동 트리거)
app.post('/api/update-prices-by-volume', async (c) => {
  try {
    const result = await updateStockPrices(c.env.DB)
    return c.json(result)
  } catch (error) {
    return c.json({ error: '주가 업데이트 중 오류가 발생했습니다.' }, 500)
  }
})

// 거래량 집계 현황 조회
app.get('/api/trading-volume/current', async (c) => {
  const timeWindow = getCurrentTimeWindow()
  
  const volumes = await c.env.DB.prepare(`
    SELECT tv.*, s.code, s.name, s.current_price
    FROM trading_volume tv
    JOIN stocks s ON tv.stock_id = s.id
    WHERE tv.time_window = ?
    ORDER BY s.code
  `).bind(timeWindow).all()
  
  return c.json({ 
    timeWindow,
    volumes: volumes.results 
  })
})

// 주가 영향 설정 조회
app.get('/api/price-impact-settings', async (c) => {
  const settings = await c.env.DB.prepare(`
    SELECT pis.*, s.code, s.name
    FROM price_impact_settings pis
    JOIN stocks s ON pis.stock_id = s.id
    ORDER BY s.code
  `).all()
  
  return c.json({ settings: settings.results })
})

// 주가 영향 설정 업데이트 (관리자)
app.post('/api/price-impact-settings/:stockId', async (c) => {
  const stockId = c.req.param('stockId')
  const { impactRate, maxChangeRate, minVolume } = await c.req.json()
  
  // 기존 설정 확인
  const existing = await c.env.DB.prepare(
    'SELECT * FROM price_impact_settings WHERE stock_id = ?'
  ).bind(stockId).first()
  
  if (existing) {
    // 업데이트
    await c.env.DB.prepare(`
      UPDATE price_impact_settings 
      SET impact_rate = ?, max_change_rate = ?, min_volume = ?, updated_at = CURRENT_TIMESTAMP
      WHERE stock_id = ?
    `).bind(impactRate, maxChangeRate, minVolume, stockId).run()
  } else {
    // 새로 생성
    await c.env.DB.prepare(`
      INSERT INTO price_impact_settings (stock_id, impact_rate, max_change_rate, min_volume)
      VALUES (?, ?, ?, ?)
    `).bind(stockId, impactRate, maxChangeRate, minVolume).run()
  }
  
  return c.json({ success: true, message: '주가 영향 설정이 저장되었습니다.' })
})

// 거래량 이력 조회 (특정 종목)
app.get('/api/trading-volume/history/:stockId', async (c) => {
  const stockId = c.req.param('stockId')
  
  const history = await c.env.DB.prepare(`
    SELECT tv.*, s.code, s.name
    FROM trading_volume tv
    JOIN stocks s ON tv.stock_id = s.id
    WHERE tv.stock_id = ?
    ORDER BY tv.time_window DESC
    LIMIT 50
  `).bind(stockId).all()
  
  return c.json({ history: history.results })
})

// ==================== 뉴스 API ====================

// 모든 뉴스 조회 (사용자별 구매 여부 포함)
app.get('/api/news', async (c) => {
  const userId = c.req.query('userId')
  
  const news = await c.env.DB.prepare(
    'SELECT * FROM news ORDER BY created_at DESC'
  ).all()
  
  // 유료 뉴스의 경우 구매 여부 확인
  const newsWithPurchaseInfo = await Promise.all(news.results.map(async (item) => {
    if (item.type === 'PREMIUM' && userId) {
      // 구매 여부 확인
      const viewed = await c.env.DB.prepare(
        'SELECT id FROM news_views WHERE user_id = ? AND news_id = ?'
      ).bind(userId, item.id).first()
      
      // 구매하지 않은 경우 제목과 내용 숨김
      if (!viewed) {
        return {
          ...item,
          title: '🔒 잠긴 유료 뉴스',
          content: '이 뉴스를 보려면 구매가 필요합니다.',
          purchased: false
        }
      }
      
      return { ...item, purchased: true }
    }
    
    return { ...item, purchased: true }
  }))
  
  return c.json({ news: newsWithPurchaseInfo })
})

// 뉴스 생성 (관리자 전용)
app.post('/api/news', async (c) => {
  const { title, content, type, price, adminUsername } = await c.req.json()
  
  // 관리자 인증 확인
  const admin = await c.env.DB.prepare(
    'SELECT id FROM admins WHERE username = ?'
  ).bind(adminUsername).first()
  
  if (!admin) {
    return c.json({ error: '권한이 없습니다.' }, 403)
  }
  
  const result = await c.env.DB.prepare(
    'INSERT INTO news (title, content, type, price, created_by) VALUES (?, ?, ?, ?, ?)'
  ).bind(title, content, type, price || 0, adminUsername).run()
  
  const news = await c.env.DB.prepare(
    'SELECT * FROM news WHERE id = ?'
  ).bind(result.meta.last_row_id).first()
  
  return c.json({ news })
})

// 뉴스 상세 조회 (유료 뉴스는 구매 확인)
app.get('/api/news/:newsId/:userId', async (c) => {
  const newsId = c.req.param('newsId')
  const userId = c.req.param('userId')
  
  const news = await c.env.DB.prepare(
    'SELECT * FROM news WHERE id = ?'
  ).bind(newsId).first()
  
  if (!news) {
    return c.json({ error: '뉴스를 찾을 수 없습니다.' }, 404)
  }
  
  // 무료 뉴스는 바로 반환
  if (news.type === 'FREE') {
    return c.json({ news, purchased: true })
  }
  
  // 유료 뉴스 구매 여부 확인
  const viewed = await c.env.DB.prepare(
    'SELECT id FROM news_views WHERE user_id = ? AND news_id = ?'
  ).bind(userId, newsId).first()
  
  if (viewed) {
    return c.json({ news, purchased: true })
  }
  
  return c.json({ 
    news: {
      ...news,
      content: '이 뉴스는 유료 뉴스입니다. 열람하려면 구매가 필요합니다.'
    }, 
    purchased: false 
  })
})

// 유료 뉴스 구매
app.post('/api/news/purchase', async (c) => {
  const { newsId, userId } = await c.req.json()
  
  // 뉴스 정보 조회
  const news = await c.env.DB.prepare(
    'SELECT * FROM news WHERE id = ?'
  ).bind(newsId).first()
  
  if (!news) {
    return c.json({ error: '뉴스를 찾을 수 없습니다.' }, 404)
  }
  
  if (news.type === 'FREE') {
    return c.json({ error: '무료 뉴스입니다.' }, 400)
  }
  
  // 이미 구매한 뉴스인지 확인
  const viewed = await c.env.DB.prepare(
    'SELECT id FROM news_views WHERE user_id = ? AND news_id = ?'
  ).bind(userId, newsId).first()
  
  if (viewed) {
    return c.json({ error: '이미 구매한 뉴스입니다.' }, 400)
  }
  
  // 사용자 잔액 확인
  const user = await c.env.DB.prepare(
    'SELECT cash FROM users WHERE id = ?'
  ).bind(userId).first()
  
  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404)
  }
  
  if (user.cash < news.price) {
    return c.json({ error: '잔액이 부족합니다.' }, 400)
  }
  
  // 트랜잭션
  // 1. 잔액 차감
  await c.env.DB.prepare(
    'UPDATE users SET cash = cash - ? WHERE id = ?'
  ).bind(news.price, userId).run()
  
  // 2. 열람 기록 저장
  await c.env.DB.prepare(
    'INSERT INTO news_views (user_id, news_id) VALUES (?, ?)'
  ).bind(userId, newsId).run()
  
  return c.json({ success: true, message: '뉴스를 구매했습니다.', news })
})

// 뉴스 삭제 (관리자 전용)
app.delete('/api/news/:newsId', async (c) => {
  const newsId = c.req.param('newsId')
  const { adminUsername } = await c.req.json()
  
  // 관리자 인증 확인
  const admin = await c.env.DB.prepare(
    'SELECT id FROM admins WHERE username = ?'
  ).bind(adminUsername).first()
  
  if (!admin) {
    return c.json({ error: '권한이 없습니다.' }, 403)
  }
  
  // 뉴스 구매 기록 먼저 삭제 (외래 키 제약 조건 대응)
  await c.env.DB.prepare(
    'DELETE FROM news_views WHERE news_id = ?'
  ).bind(newsId).run()
  
  // 뉴스 삭제
  await c.env.DB.prepare(
    'DELETE FROM news WHERE id = ?'
  ).bind(newsId).run()
  
  return c.json({ success: true, message: '뉴스가 삭제되었습니다.' })
})

// 모든 유저 초기화 (관리자 전용)
app.post('/api/admin/reset-all-users', async (c) => {
  const { adminUsername, confirmPassword } = await c.req.json()
  
  // 관리자 인증 확인
  const admin = await c.env.DB.prepare(
    'SELECT id FROM admins WHERE username = ? AND password = ?'
  ).bind(adminUsername, confirmPassword).first()
  
  if (!admin) {
    return c.json({ error: '관리자 인증에 실패했습니다.' }, 403)
  }
  
  try {
    // 1. 모든 거래 내역 삭제
    await c.env.DB.prepare('DELETE FROM transactions').run()
    
    // 2. 모든 보유 주식 삭제
    await c.env.DB.prepare('DELETE FROM user_stocks').run()
    
    // 3. 모든 사용자 현금을 100만원으로 초기화
    await c.env.DB.prepare(
      'UPDATE users SET cash = 1000000.0'
    ).run()
    
    // 4. 모든 뉴스 구매 기록 삭제
    await c.env.DB.prepare('DELETE FROM news_views').run()
    
    return c.json({ 
      success: true, 
      message: '모든 사용자가 초기 자본(100만원)으로 초기화되었습니다.\n- 거래 내역 삭제\n- 보유 주식 삭제\n- 현금 100만원 초기화\n- 뉴스 구매 기록 삭제' 
    })
  } catch (error) {
    console.error('Reset error:', error)
    return c.json({ error: '초기화 중 오류가 발생했습니다.' }, 500)
  }
})

// ==================== 사용자 정보 API ====================

// 사용자 정보 조회
app.get('/api/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  
  const user = await c.env.DB.prepare(
    'SELECT id, username, name, cash FROM users WHERE id = ?'
  ).bind(userId).first()
  
  if (!user) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404)
  }
  
  return c.json({ user })
})

// 모든 사용자 조회 (관리자 전용 - 순위표용)
app.get('/api/users', async (c) => {
  const users = await c.env.DB.prepare(`
    SELECT u.id, u.username, u.name, u.cash,
           COALESCE(SUM(us.quantity * s.current_price), 0) as stock_value,
           u.cash + COALESCE(SUM(us.quantity * s.current_price), 0) as total_assets
    FROM users u
    LEFT JOIN user_stocks us ON u.id = us.user_id
    LEFT JOIN stocks s ON us.stock_id = s.id
    GROUP BY u.id
    ORDER BY total_assets DESC
  `).all()
  
  return c.json({ users: users.results })
})

// ==================== 메인 페이지 ====================

app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>충암고 가상 주식 투자</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <div class="container mx-auto px-4 py-8">
            <div class="text-center mb-8">
                <h1 class="text-5xl font-bold text-indigo-900 mb-4">
                    <i class="fas fa-chart-line mr-3"></i>
                    충암고 가상 주식 투자
                </h1>
                <p class="text-xl text-gray-700">실전 같은 주식 투자 시뮬레이션</p>
            </div>
            

            <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
                <!-- 주가 현황판 메뉴 -->
                <div class="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition duration-300 transform hover:-translate-y-2">
                    <div class="text-center mb-4">
                        <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                            <i class="fas fa-tv text-3xl text-green-600"></i>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-800">주가 현황판</h2>
                    </div>
                    <p class="text-gray-600 text-center mb-4 text-sm">
                        실시간 주가와 뉴스 속보
                    </p>
                    <a href="/board" class="block w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg text-center transition duration-200">
                        보기
                    </a>
                </div>
                
                <!-- 주식 투자 하는 법 메뉴 -->
                <div class="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition duration-300 transform hover:-translate-y-2">
                    <div class="text-center mb-4">
                        <div class="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-3">
                            <i class="fas fa-book text-3xl text-orange-600"></i>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-800">투자 가이드</h2>
                    </div>
                    <p class="text-gray-600 text-center mb-4 text-sm">
                        거래 시간 및 이용 방법
                    </p>
                    <a href="/guide" class="block w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-2 px-4 rounded-lg text-center transition duration-200">
                        보기
                    </a>
                </div>
                
                <!-- 학생 메뉴 -->
                <div class="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition duration-300 transform hover:-translate-y-2">
                    <div class="text-center mb-4">
                        <div class="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
                            <i class="fas fa-user-graduate text-3xl text-blue-600"></i>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-800">학생</h2>
                    </div>
                    <p class="text-gray-600 text-center mb-4 text-sm">
                        주식을 거래하고 투자 실력을 키워보세요
                    </p>
                    <a href="/student" class="block w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg text-center transition duration-200">
                        입장하기
                    </a>
                </div>
                
                <!-- 관리자 메뉴 -->
                <div class="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition duration-300 transform hover:-translate-y-2">
                    <div class="text-center mb-4">
                        <div class="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-3">
                            <i class="fas fa-user-shield text-3xl text-purple-600"></i>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-800">관리자</h2>
                    </div>
                    <p class="text-gray-600 text-center mb-4 text-sm">
                        주가 조정 및 뉴스 관리
                    </p>
                    <a href="/admin" class="block w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg text-center transition duration-200">
                        입장하기
                    </a>
                </div>
            </div>
            
            <div class="mt-12 text-center text-gray-600">
                <p>
                    <i class="fas fa-info-circle mr-2"></i>
                    초기 자금: 100만원 | 8개 주식 종목
                </p>
            </div>
        </div>
    </body>
    </html>
  `)
})

// ==================== 학생 페이지 ====================

app.get('/student', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>학생 페이지 - 충암고 가상 주식 투자</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    </head>
    <body class="bg-gray-100">
        <!-- 로그인 화면 -->
        <div id="loginScreen" class="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
            <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
                <h2 class="text-3xl font-bold text-center text-indigo-900 mb-6">
                    <i class="fas fa-user-graduate mr-2"></i>학생/교사 로그인
                </h2>
                <p class="text-center text-gray-600 mb-6">
                    학번 또는 교사 아이디로 로그인하세요<br/>
                    1학년: 10101~10130 (1반), 10201~10230 (2반) ... 11201~11230 (12반)<br/>
                    2학년: 20101~20130 (1반), 20201~20230 (2반) ... 21301~21330 (13반)<br/>
                    교사: t001 ~ t090<br/>
                    초기 비밀번호: 1111 (최초 로그인 후 변경 필요)
                </p>
                <div class="space-y-4">
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">아이디</label>
                        <input type="text" id="loginUsername" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="예: 10101 또는 t001">
                    </div>
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">비밀번호</label>
                        <input type="password" id="loginPassword" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="1111">
                    </div>
                    <button onclick="login()" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition duration-200">
                        로그인
                    </button>
                    <a href="/" class="block text-center text-gray-600 hover:text-gray-800">
                        <i class="fas fa-arrow-left mr-1"></i>메인으로 돌아가기
                    </a>
                </div>
            </div>
        </div>

        <!-- 비밀번호 변경 화면 -->
        <div id="passwordChangeScreen" class="hidden min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
            <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
                <h2 class="text-3xl font-bold text-center text-indigo-900 mb-4">
                    <i class="fas fa-key mr-2"></i>비밀번호 변경
                </h2>
                <p class="text-center text-red-600 font-semibold mb-6">
                    최초 로그인입니다. 비밀번호를 변경해주세요.
                </p>
                <div class="space-y-4">
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">현재 비밀번호</label>
                        <input type="password" id="oldPassword" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="1111">
                    </div>
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">새 비밀번호</label>
                        <input type="password" id="newPassword" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="최소 4자 이상">
                    </div>
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">새 비밀번호 확인</label>
                        <input type="password" id="confirmPassword" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    </div>
                    <button onclick="changePassword()" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition duration-200">
                        비밀번호 변경
                    </button>
                </div>
            </div>
        </div>

        <!-- 메인 화면 -->
        <div id="mainScreen" class="hidden">
            <!-- 헤더 -->
            <div class="bg-indigo-900 text-white py-3 shadow-lg">
                <div class="container mx-auto px-4">
                    <!-- 모바일: 세로 레이아웃, 데스크톱: 가로 레이아웃 -->
                    <div class="flex flex-col md:flex-row md:justify-between md:items-center space-y-3 md:space-y-0">
                        <!-- 타이틀 -->
                        <h1 class="text-lg md:text-2xl font-bold">
                            <i class="fas fa-chart-line mr-2"></i>충암고 가상 주식 투자
                        </h1>
                        
                        <!-- 자산 정보 및 로그아웃 -->
                        <div class="flex flex-col md:flex-row md:items-center space-y-2 md:space-y-0 md:space-x-6">
                            <!-- 자산 정보 (모바일: 한 줄에 표시) -->
                            <div class="flex items-center space-x-4 text-sm md:text-base">
                                <div>
                                    <span class="text-gray-300">현금:</span>
                                    <span id="userCash" class="font-bold ml-1">0원</span>
                                </div>
                                <div>
                                    <span class="text-gray-300">총 자산:</span>
                                    <span id="totalAssets" class="font-bold ml-1">0원</span>
                                </div>
                            </div>
                            
                            <!-- 사용자 정보 및 로그아웃 -->
                            <div class="flex items-center justify-between md:justify-start space-x-3">
                                <span class="text-gray-300 text-sm md:text-base" id="userName"></span>
                                <button onclick="logout()" class="bg-red-500 hover:bg-red-600 px-3 py-1.5 md:px-4 md:py-2 rounded-lg text-sm">
                                    로그아웃
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 탭 메뉴 -->
            <div class="bg-white shadow-md overflow-x-auto">
                <div class="container mx-auto px-4">
                    <div class="flex space-x-1 min-w-max">
                        <button onclick="showTab('stocks')" class="tab-btn px-4 md:px-6 py-3 font-semibold border-b-2 border-blue-600 text-blue-600 text-sm md:text-base whitespace-nowrap">
                            주식 거래
                        </button>
                        <button onclick="showTab('portfolio')" class="tab-btn px-4 md:px-6 py-3 font-semibold text-gray-600 hover:text-blue-600 text-sm md:text-base whitespace-nowrap">
                            내 포트폴리오
                        </button>
                        <button onclick="showTab('news')" class="tab-btn px-4 md:px-6 py-3 font-semibold text-gray-600 hover:text-blue-600 text-sm md:text-base whitespace-nowrap">
                            뉴스
                        </button>
                        <button onclick="showTab('ranking')" class="tab-btn px-4 md:px-6 py-3 font-semibold text-gray-600 hover:text-blue-600 text-sm md:text-base whitespace-nowrap">
                            투자 랭킹
                        </button>
                    </div>
                </div>
            </div>

            <div class="container mx-auto px-4 py-6">
                <!-- 주식 거래 탭 -->
                <div id="stocksTab" class="tab-content">
                    <h2 class="text-2xl font-bold mb-6">주식 거래</h2>
                    <div id="stocksList" class="grid md:grid-cols-2 gap-6"></div>
                </div>

                <!-- 포트폴리오 탭 -->
                <div id="portfolioTab" class="tab-content hidden">
                    <h2 class="text-2xl font-bold mb-6">내 포트폴리오</h2>
                    <div id="portfolioList" class="space-y-4"></div>
                    
                    <h3 class="text-xl font-bold mt-8 mb-4">거래 내역</h3>
                    <div id="transactionsList" class="space-y-2"></div>
                </div>

                <!-- 뉴스 탭 -->
                <div id="newsTab" class="tab-content hidden">
                    <h2 class="text-2xl font-bold mb-6">뉴스</h2>
                    <div id="newsList" class="space-y-4"></div>
                </div>

                <!-- 투자 랭킹 탭 -->
                <div id="rankingTab" class="tab-content hidden">
                    <h2 class="text-2xl font-bold mb-6">투자 랭킹</h2>
                    <p class="text-gray-600 mb-4">평가 금액(총 자산) 기준 순위입니다</p>
                    <div id="rankingList" class="bg-white rounded-lg shadow-lg overflow-hidden"></div>
                </div>
            </div>
        </div>

        <script src="/static/student.js"></script>
    </body>
    </html>
  `)
})

// ==================== 관리자 페이지 ====================

app.get('/admin', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>관리자 페이지 - 충암고 가상 주식 투자</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
    </head>
    <body class="bg-gray-100">
        <!-- 로그인 화면 -->
        <div id="loginScreen" class="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100">
            <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
                <h2 class="text-3xl font-bold text-center text-purple-900 mb-6">
                    <i class="fas fa-user-shield mr-2"></i>관리자 로그인
                </h2>
                <div class="space-y-4">
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">아이디</label>
                        <input type="text" id="adminUsername" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500">
                    </div>
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">비밀번호</label>
                        <input type="password" id="adminPassword" class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500">
                    </div>
                    <button onclick="adminLogin()" class="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 rounded-lg transition duration-200">
                        로그인
                    </button>
                    <a href="/" class="block text-center text-gray-600 hover:text-gray-800">
                        <i class="fas fa-arrow-left mr-1"></i>메인으로 돌아가기
                    </a>
                </div>
            </div>
        </div>

        <!-- 메인 화면 -->
        <div id="mainScreen" class="hidden">
            <!-- 헤더 -->
            <div class="bg-purple-900 text-white py-4 shadow-lg">
                <div class="container mx-auto px-4 flex justify-between items-center">
                    <h1 class="text-2xl font-bold">
                        <i class="fas fa-user-shield mr-2"></i>관리자 페이지
                    </h1>
                    <div>
                        <span class="text-gray-300 mr-4" id="adminName"></span>
                        <button onclick="logout()" class="bg-red-500 hover:bg-red-600 px-4 py-2 rounded-lg text-sm">
                            로그아웃
                        </button>
                    </div>
                </div>
            </div>

            <!-- 탭 메뉴 -->
            <div class="bg-white shadow-md">
                <div class="container mx-auto px-4">
                    <div class="flex space-x-1">
                        <button onclick="showTab('stocks')" class="tab-btn px-6 py-3 font-semibold border-b-2 border-purple-600 text-purple-600">
                            주가 관리
                        </button>
                        <button onclick="showTab('news')" class="tab-btn px-6 py-3 font-semibold text-gray-600 hover:text-purple-600">
                            뉴스 관리
                        </button>
                        <button onclick="showTab('users')" class="tab-btn px-6 py-3 font-semibold text-gray-600 hover:text-purple-600">
                            사용자 관리
                        </button>
                    </div>
                </div>
            </div>

            <div class="container mx-auto px-4 py-6">
                <!-- 주가 관리 탭 -->
                <div id="stocksTab" class="tab-content">
                    <div class="mb-6">
                        <h2 class="text-2xl font-bold mb-3">주가 관리</h2>
                        <div class="bg-blue-50 border-l-4 border-blue-500 p-4 mb-4">
                            <div class="flex items-start">
                                <i class="fas fa-info-circle text-blue-500 text-xl mr-3 mt-1"></i>
                                <div>
                                    <p class="font-semibold text-blue-900 mb-1">관리자는 24시간 언제든지 주가를 변경할 수 있습니다</p>
                                    <ul class="text-sm text-blue-800 space-y-1">
                                        <li><i class="fas fa-check text-green-600 mr-1"></i><strong>거래 시간 중 (08:00-16:00)</strong>: 변경 즉시 모든 사용자에게 실시간 반영</li>
                                        <li><i class="fas fa-clock text-yellow-600 mr-1"></i><strong>거래 시간 외</strong>: 예약 저장 → 다음 거래 시간에 자동 반영</li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="stocksList" class="grid md:grid-cols-2 gap-6"></div>
                </div>

                <!-- 뉴스 관리 탭 -->
                <div id="newsTab" class="tab-content hidden">
                    <div class="flex justify-between items-center mb-6">
                        <h2 class="text-2xl font-bold">뉴스 관리</h2>
                        <button onclick="showNewsForm()" class="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-lg font-semibold">
                            <i class="fas fa-plus mr-2"></i>뉴스 작성
                        </button>
                    </div>
                    
                    <!-- 뉴스 작성 폼 -->
                    <div id="newsForm" class="hidden bg-white rounded-lg shadow-lg p-6 mb-6">
                        <h3 class="text-xl font-bold mb-4">새 뉴스 작성</h3>
                        <div class="space-y-4">
                            <div>
                                <label class="block text-gray-700 font-semibold mb-2">제목</label>
                                <input type="text" id="newsTitle" class="w-full px-4 py-2 border rounded-lg">
                            </div>
                            <div>
                                <label class="block text-gray-700 font-semibold mb-2">내용</label>
                                <textarea id="newsContent" rows="5" class="w-full px-4 py-2 border rounded-lg"></textarea>
                            </div>
                            <div class="grid md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-gray-700 font-semibold mb-2">뉴스 유형</label>
                                    <select id="newsType" class="w-full px-4 py-2 border rounded-lg" onchange="toggleNewsPrice()">
                                        <option value="FREE">일반 뉴스 (무료)</option>
                                        <option value="PREMIUM">고급 뉴스 (유료)</option>
                                    </select>
                                </div>
                                <div id="newsPriceDiv" class="hidden">
                                    <label class="block text-gray-700 font-semibold mb-2">가격 (원)</label>
                                    <input type="number" id="newsPrice" class="w-full px-4 py-2 border rounded-lg" value="50000">
                                </div>
                            </div>
                            <div class="flex space-x-4">
                                <button onclick="createNews()" class="flex-1 bg-purple-600 hover:bg-purple-700 text-white py-2 rounded-lg font-semibold">
                                    작성하기
                                </button>
                                <button onclick="hideNewsForm()" class="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 py-2 rounded-lg font-semibold">
                                    취소
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <div id="newsList" class="space-y-4"></div>
                </div>

                <!-- 사용자 관리 탭 -->
                <div id="usersTab" class="tab-content hidden">
                    <div class="flex justify-between items-center mb-6">
                        <h2 class="text-2xl font-bold">사용자 관리 (순위표)</h2>
                        <button onclick="resetAllUsers()" class="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-lg font-semibold">
                            <i class="fas fa-undo mr-2"></i>모든 유저 초기화
                        </button>
                    </div>
                    <div class="bg-yellow-50 border-l-4 border-yellow-500 p-4 mb-4">
                        <div class="flex items-start">
                            <i class="fas fa-exclamation-triangle text-yellow-600 text-xl mr-3 mt-1"></i>
                            <div>
                                <p class="font-semibold text-yellow-900 mb-1">모든 유저 초기화</p>
                                <p class="text-sm text-yellow-800">
                                    모든 사용자의 현금을 100만원으로 초기화하고, 보유 주식과 거래 내역을 삭제합니다.
                                    <strong class="text-red-600">이 작업은 되돌릴 수 없습니다!</strong>
                                </p>
                            </div>
                        </div>
                    </div>
                    <div id="usersList" class="bg-white rounded-lg shadow-lg overflow-hidden"></div>
                </div>
            </div>
        </div>

        <script src="/static/admin.js"></script>
    </body>
    </html>
  `)
})

// ==================== 주가 현황판 페이지 ====================

app.get('/board', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>주가 현황판 - 충암고 가상 주식 투자</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
        <style>
            @keyframes scroll-left {
                0% { transform: translateX(100%); }
                100% { transform: translateX(-100%); }
            }
            .news-ticker {
                animation: scroll-left 30s linear infinite;
            }
        </style>
    </head>
    <body class="bg-gray-900 text-white">
        <!-- 헤더 -->
        <div class="bg-indigo-900 py-3 shadow-lg">
            <div class="container mx-auto px-4 flex justify-between items-center">
                <h1 class="text-2xl font-bold">
                    <i class="fas fa-tv mr-2"></i>주가 현황판
                </h1>
                <a href="/" class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm">
                    <i class="fas fa-home mr-1"></i>메인으로
                </a>
            </div>
        </div>

        <!-- 주가 현황 -->
        <div class="container mx-auto px-4 py-6">
            <div class="bg-gray-800 rounded-lg p-6 mb-6">
                <div class="flex items-center justify-between mb-4">
                    <h2 class="text-xl font-bold text-green-400">
                        <i class="fas fa-chart-line mr-2"></i>실시간 주가
                    </h2>
                    <div class="flex items-center space-x-4">
                        <div class="text-sm text-yellow-400 bg-gray-700 px-4 py-2 rounded-lg">
                            <i class="fas fa-clock mr-2"></i>
                            <span id="priceUpdateCountdown">계산 중...</span>
                        </div>
                    </div>
                </div>
                <div id="stocksBoard" class="grid grid-cols-2 md:grid-cols-4 gap-4"></div>
            </div>
        </div>

        <!-- 뉴스 티커 (하단 고정) -->
        <div class="fixed bottom-0 left-0 right-0 bg-red-600 py-3 overflow-hidden">
            <div class="news-ticker whitespace-nowrap">
                <span id="newsTicker" class="text-lg font-semibold"></span>
            </div>
        </div>

        <script src="/static/board.js"></script>
    </body>
    </html>
  `)
})

// ==================== 투자 가이드 페이지 ====================

app.get('/guide', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>주식 투자 하는 법 - 충암고 가상 주식 투자</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gradient-to-br from-orange-50 to-yellow-100 min-h-screen">
        <div class="container mx-auto px-4 py-8">
            <!-- 헤더 -->
            <div class="text-center mb-8">
                <h1 class="text-4xl font-bold text-orange-900 mb-4">
                    <i class="fas fa-book mr-3"></i>주식 투자 하는 법
                </h1>
                <a href="/" class="inline-block bg-orange-600 hover:bg-orange-700 text-white px-6 py-2 rounded-lg">
                    <i class="fas fa-arrow-left mr-2"></i>메인으로 돌아가기
                </a>
            </div>

            <!-- 안내사항 -->
            <div class="max-w-4xl mx-auto space-y-6">
                <!-- 장 운영 시간 -->
                <div class="bg-white rounded-2xl shadow-xl p-8">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                        <i class="fas fa-clock text-blue-600 mr-3"></i>
                        장 운영 시간
                    </h2>
                    <div class="space-y-3 text-lg">
                        <p class="flex items-start">
                            <i class="fas fa-check-circle text-green-600 mr-3 mt-1"></i>
                            <span><strong>장 시작:</strong> 오전 08:00 정각</span>
                        </p>
                        <p class="flex items-start">
                            <i class="fas fa-check-circle text-red-600 mr-3 mt-1"></i>
                            <span><strong>장 마감:</strong> 오후 04:00 정각</span>
                        </p>
                        <p class="flex items-start text-red-600 font-semibold">
                            <i class="fas fa-exclamation-triangle mr-3 mt-1"></i>
                            <span>장 시작/마감 시간 외에는 주식 거래가 불가능합니다</span>
                        </p>
                    </div>
                </div>

                <!-- 거래 가능 시간 -->
                <div class="bg-white rounded-2xl shadow-xl p-8">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                        <i class="fas fa-calendar-check text-green-600 mr-3"></i>
                        거래 가능 시간
                    </h2>
                    <div class="bg-green-50 border-2 border-green-300 rounded-lg p-6 mb-4">
                        <p class="text-lg font-semibold text-green-800 mb-3">
                            주식 거래는 다음 시간에만 가능합니다:
                        </p>
                        <div class="grid md:grid-cols-2 gap-3 text-gray-700">
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오전 08:00 ~ 08:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오전 09:10 ~ 09:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오전 10:10 ~ 10:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오전 11:10 ~ 11:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오후 12:10 ~ 12:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오후 01:00 ~ 01:10
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오후 02:00 ~ 02:10
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-green-600 text-xs mr-2"></i>
                                오후 03:00 ~ 03:10
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 주가 업데이트 시간 -->
                <div class="bg-white rounded-2xl shadow-xl p-8">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                        <i class="fas fa-sync-alt text-blue-600 mr-3"></i>
                        주가 업데이트 시간
                    </h2>
                    <div class="bg-blue-50 border-2 border-blue-300 rounded-lg p-6">
                        <p class="text-lg font-semibold text-blue-800 mb-3">
                            관리자가 설정한 주가는 거래 가능 시간과 동일한 시간에 업데이트됩니다:
                        </p>
                        <div class="grid md:grid-cols-2 gap-3 text-gray-700">
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오전 08:00 ~ 08:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오전 09:10 ~ 09:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오전 10:10 ~ 10:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오전 11:10 ~ 11:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오후 12:10 ~ 12:20
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오후 01:00 ~ 01:10
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오후 02:00 ~ 02:10
                            </div>
                            <div class="flex items-center">
                                <i class="fas fa-circle text-blue-600 text-xs mr-2"></i>
                                오후 03:00 ~ 03:10
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 이용 안내 -->
                <div class="bg-white rounded-2xl shadow-xl p-8">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                        <i class="fas fa-info-circle text-purple-600 mr-3"></i>
                        이용 안내
                    </h2>
                    <div class="space-y-3 text-gray-700">
                        <p class="flex items-start">
                            <i class="fas fa-arrow-right text-purple-600 mr-3 mt-1"></i>
                            <span>초기 자금은 <strong>100만원</strong>입니다</span>
                        </p>
                        <p class="flex items-start">
                            <i class="fas fa-arrow-right text-purple-600 mr-3 mt-1"></i>
                            <span>총 <strong>8개의 주식 종목</strong>에 투자할 수 있습니다</span>
                        </p>
                        <p class="flex items-start">
                            <i class="fas fa-arrow-right text-purple-600 mr-3 mt-1"></i>
                            <span>유료 뉴스를 구매하여 투자 정보를 얻을 수 있습니다</span>
                        </p>
                        <p class="flex items-start">
                            <i class="fas fa-arrow-right text-purple-600 mr-3 mt-1"></i>
                            <span>투자 랭킹은 총 자산(현금 + 주식 평가액) 기준입니다</span>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    </body>
    </html>
  `)
})

export default app
