// 전역 변수
let stocks = [];
let previousStocks = {}; // 이전 주가 저장 (주가 변동 색상 표시용)
let news = [];
let tradingAllowed = false;

// 거래 시간 종료 시점 목록 (분 단위)
const TRADING_WINDOWS_END = [
    8 * 60 + 20,   // 08:20
    9 * 60 + 20,   // 09:20
    10 * 60 + 20,  // 10:20
    11 * 60 + 20,  // 11:20
    12 * 60 + 20,  // 12:20
    13 * 60 + 10,  // 13:10
    14 * 60 + 10,  // 14:10
    15 * 60 + 10   // 15:10
];

// 데이터 로드
async function loadData() {
    await checkTradingStatus();
    await checkAndApplyPendingPrices();
    await loadStocks();
    await loadNews();
    updateDisplay();
    updateCountdown();
}

// 거래 시간 확인
async function checkTradingStatus() {
    try {
        const response = await axios.get('/api/trading-status');
        tradingAllowed = response.data.allowed;
    } catch (error) {
        console.error('거래 시간 확인 실패:', error);
    }
}

// 거래 시간에 예약된 주가 자동 적용
async function checkAndApplyPendingPrices() {
    try {
        const response = await axios.get('/api/trading-status');
        if (response.data.allowed) {
            // 거래 시간이면 예약된 주가 적용
            await axios.post('/api/apply-pending-prices');
        }
    } catch (error) {
        // 에러 무시 (이미 적용되었거나 예약이 없을 수 있음)
    }
}

async function loadStocks() {
    try {
        const response = await axios.get('/api/stocks');
        
        // 이전 주가 저장 (첫 로드 시 현재 가격을 이전 가격으로 설정)
        response.data.stocks.forEach(stock => {
            if (!previousStocks[stock.id]) {
                previousStocks[stock.id] = stock.current_price;
            }
        });
        
        stocks = response.data.stocks;
    } catch (error) {
        console.error('주식 로드 실패:', error);
    }
}

async function loadNews() {
    try {
        const response = await axios.get('/api/news');
        // 무료 뉴스만 필터링하고 2일 이내 뉴스만
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        
        news = response.data.news.filter(item => {
            const newsDate = new Date(item.created_at);
            return item.type === 'FREE' && newsDate >= twoDaysAgo;
        });
    } catch (error) {
        console.error('뉴스 로드 실패:', error);
    }
}

// 화면 업데이트
function updateDisplay() {
    displayStocks();
    displayNewsTicker();
}

// 주식 목록 표시
function displayStocks() {
    const stocksBoard = document.getElementById('stocksBoard');
    
    if (stocks.length === 0) {
        stocksBoard.innerHTML = '<p class="text-gray-400 text-center col-span-full py-8">주식 정보를 불러오는 중...</p>';
        return;
    }
    
    stocksBoard.innerHTML = stocks.map(stock => {
        // API에서 제공하는 이전 가격 사용 (previous_price)
        const previousPrice = stock.previous_price || stock.current_price;
        const currentPrice = stock.current_price;
        
        // 가격 변동 계산
        let priceChangeClass = 'text-white'; // 변동 없음 (기본)
        let priceChangeIcon = '';
        let priceChangeText = '';
        
        if (currentPrice > previousPrice) {
            // 상승 - 빨간색
            priceChangeClass = 'text-red-500';
            priceChangeIcon = '<i class="fas fa-arrow-up mr-1"></i>';
            const changeAmount = currentPrice - previousPrice;
            const changePercent = ((changeAmount / previousPrice) * 100).toFixed(2);
            priceChangeText = `<p class="text-sm text-red-500 mt-1">${priceChangeIcon}+${formatMoney(changeAmount)} (+${changePercent}%)</p>`;
        } else if (currentPrice < previousPrice) {
            // 하락 - 파란색
            priceChangeClass = 'text-blue-500';
            priceChangeIcon = '<i class="fas fa-arrow-down mr-1"></i>';
            const changeAmount = previousPrice - currentPrice;
            const changePercent = ((changeAmount / previousPrice) * 100).toFixed(2);
            priceChangeText = `<p class="text-sm text-blue-500 mt-1">${priceChangeIcon}-${formatMoney(changeAmount)} (-${changePercent}%)</p>`;
        }
        
        return `
            <div class="bg-gray-700 rounded-lg p-4 hover:bg-gray-600 transition">
                <h3 class="text-lg font-bold text-white mb-2">${stock.name}</h3>
                <p class="text-sm text-gray-400 mb-2">${stock.code}</p>
                <p class="text-2xl font-bold ${priceChangeClass}">${formatMoney(currentPrice)}</p>
                ${priceChangeText}
            </div>
        `;
    }).join('');
}

// 뉴스 티커 표시
function displayNewsTicker() {
    const newsTicker = document.getElementById('newsTicker');
    
    if (news.length === 0) {
        newsTicker.innerHTML = '📰 현재 표시할 뉴스가 없습니다.';
        return;
    }
    
    // 뉴스를 문자열로 연결
    const newsText = news.map(item => `📰 ${item.title}`).join('   ｜   ');
    newsTicker.innerHTML = newsText + '   ｜   ' + newsText; // 반복해서 표시
}

// 한국 시간(KST) 가져오기
function getKoreanTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kst = new Date(utc + (9 * 60 * 60 * 1000));
    return kst;
}

// 다음 주가 업데이트까지 카운트다운
function updateCountdown() {
    const now = getKoreanTime(); // 한국 시간 사용
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeInMinutes = hours * 60 + minutes;
    
    let countdownText = '';
    
    // 장 운영 시간 전 (08:00 이전)
    if (currentTimeInMinutes < 8 * 60) {
        const targetTime = 8 * 60 + 20; // 첫 거래 종료 시간 (08:20)
        const diffMinutes = targetTime - currentTimeInMinutes;
        const diffHours = Math.floor(diffMinutes / 60);
        const remainMinutes = diffMinutes % 60;
        
        if (diffHours > 0) {
            countdownText = `첫 업데이트까지 ${diffHours}시간 ${remainMinutes}분`;
        } else {
            countdownText = `첫 업데이트까지 ${remainMinutes}분`;
        }
    }
    // 장 운영 시간 중 (08:00 ~ 16:00)
    else if (currentTimeInMinutes < 16 * 60) {
        // 다음 거래 종료 시점 찾기
        let nextEndTime = null;
        for (const endTime of TRADING_WINDOWS_END) {
            if (currentTimeInMinutes < endTime) {
                nextEndTime = endTime;
                break;
            }
        }
        
        if (nextEndTime) {
            const diffMinutes = nextEndTime - currentTimeInMinutes;
            const diffSeconds = (60 - now.getSeconds()) % 60;
            
            if (diffMinutes > 0) {
                countdownText = `다음 업데이트까지 ${diffMinutes}분`;
            } else if (diffSeconds > 0) {
                countdownText = `다음 업데이트까지 ${diffSeconds}초`;
            } else {
                countdownText = '업데이트 중...';
            }
        } else {
            countdownText = '오늘 마지막 업데이트 완료';
        }
    }
    // 장 마감 후 (16:00 이후)
    else {
        // 다음날 첫 거래 종료 시간까지
        const minutesUntilMidnight = (24 * 60) - currentTimeInMinutes;
        const minutesUntilFirstUpdate = (8 * 60 + 20); // 08:20
        const totalMinutes = minutesUntilMidnight + minutesUntilFirstUpdate;
        const totalHours = Math.floor(totalMinutes / 60);
        const remainMinutes = totalMinutes % 60;
        
        countdownText = `다음 업데이트까지 ${totalHours}시간 ${remainMinutes}분`;
    }
    
    // 카운트다운 텍스트 업데이트
    const countdownElement = document.getElementById('priceUpdateCountdown');
    if (countdownElement) {
        countdownElement.textContent = countdownText;
    }
}

// 유틸리티 함수
function formatMoney(amount) {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount);
}

// 페이지 로드 시
window.addEventListener('DOMContentLoaded', () => {
    loadData();
    
    // 5초마다 데이터 새로고침
    setInterval(loadData, 5000);
    
    // 1초마다 카운트다운 업데이트
    setInterval(updateCountdown, 1000);
});
