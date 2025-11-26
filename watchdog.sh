#!/bin/bash
# Watchdog script - 서비스가 다운되면 자동 재시작

LOG_FILE="/home/user/.pm2/logs/watchdog.log"

log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

while true; do
    # 서비스 체크
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 5)
    
    if [ "$HTTP_CODE" != "200" ]; then
        log_message "⚠️  Service down (HTTP $HTTP_CODE) - Restarting..."
        
        # PM2 재시작
        cd /home/user/webapp
        pm2 delete all 2>/dev/null
        pkill -9 wrangler 2>/dev/null
        pkill -9 workerd 2>/dev/null
        sleep 2
        pm2 start ecosystem.config.cjs
        
        log_message "✅ Service restarted"
        sleep 15  # 재시작 후 대기
    else
        log_message "✓ Service healthy (HTTP $HTTP_CODE)"
    fi
    
    # 30초마다 체크
    sleep 30
done
