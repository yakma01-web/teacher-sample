# Cloudflare Pages 배포 가이드

## 📋 준비 사항
- Cloudflare 계정 (무료)
- Node.js 설치
- Wrangler CLI 설치: `npm install -g wrangler`

## 🚀 배포 단계

### 1. 저장소 클론
```bash
git clone https://github.com/yakma01-web/choongam.git
cd choongam
npm install
```

### 2. Wrangler 로그인
```bash
wrangler login
```
브라우저가 열리면 Cloudflare 계정으로 로그인

### 3. D1 데이터베이스 생성
```bash
wrangler d1 create choongam-production
```

출력 예시:
```
✅ Successfully created DB 'choongam-production'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 4. wrangler.jsonc 업데이트

`database_id`를 방금 생성된 ID로 변경:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "choongam",
  "compatibility_date": "2025-11-06",
  "pages_build_output_dir": "./dist",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "choongam-production",
      "database_id": "여기에-실제-database-id-입력"
    }
  ]
}
```

### 5. 데이터베이스 마이그레이션
```bash
wrangler d1 migrations apply choongam-production
```

### 6. 시드 데이터 입력 (선택사항)
```bash
wrangler d1 execute choongam-production --file=./seed.sql
```

### 7. Pages 프로젝트 생성
```bash
wrangler pages project create choongam --production-branch main
```

### 8. 빌드 및 배포
```bash
npm run build
wrangler pages deploy dist --project-name choongam
```

## ✅ 완료!

배포가 완료되면 다음과 같은 URL을 받게 됩니다:
- Production: `https://choongam.pages.dev`
- Preview: `https://main.choongam.pages.dev`

## 🔄 업데이트 방법

코드 수정 후:
```bash
git add .
git commit -m "Update message"
git push origin main

npm run build
wrangler pages deploy dist --project-name choongam
```

## 🗄️ 데이터베이스 관리

### 로컬에서 프로덕션 DB 조회
```bash
wrangler d1 execute choongam-production --command="SELECT * FROM users LIMIT 10"
```

### 학생 자본금 초기화
```bash
wrangler d1 execute choongam-production --command="UPDATE users SET cash = 1000000.0 WHERE user_type = 'student'"
```

### 거래 내역 삭제
```bash
wrangler d1 execute choongam-production --command="DELETE FROM transactions"
```

## 🔐 환경 변수 설정 (필요시)

```bash
wrangler pages secret put SECRET_NAME --project-name choongam
```

## 📞 문제 해결

### 빌드 오류
```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

### 데이터베이스 연결 오류
- wrangler.jsonc의 database_id 확인
- D1 바인딩이 올바른지 확인

### 배포 후 페이지가 안 보임
- dist 폴더가 제대로 빌드되었는지 확인
- `wrangler pages deployment list --project-name choongam`으로 상태 확인

## 🎯 주요 명령어 요약

```bash
# 로그인
wrangler login

# D1 데이터베이스 생성
wrangler d1 create choongam-production

# 마이그레이션
wrangler d1 migrations apply choongam-production

# 배포
npm run build && wrangler pages deploy dist --project-name choongam

# 프로덕션 DB 쿼리
wrangler d1 execute choongam-production --command="YOUR SQL"

# 배포 내역 확인
wrangler pages deployment list --project-name choongam
```
