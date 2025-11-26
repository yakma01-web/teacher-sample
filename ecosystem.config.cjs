module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=webapp-production --local --ip 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      // 자동 재시작 설정
      autorestart: true,
      max_restarts: 50,  // 무제한에 가깝게
      min_uptime: '5s',
      restart_delay: 2000,
      // 메모리 제한 (300MB 초과 시 재시작)
      max_memory_restart: '300M',
      // 에러 로그 관리
      error_file: '/home/user/.pm2/logs/webapp-error.log',
      out_file: '/home/user/.pm2/logs/webapp-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // 크래시 시 자동 재시작
      exp_backoff_restart_delay: 100,
      // 시간 초과 설정
      kill_timeout: 3000,
      listen_timeout: 8000
    },
    {
      name: 'watchdog',
      script: '/home/user/webapp/watchdog.sh',
      autorestart: true,
      watch: false
    }
  ]
}
