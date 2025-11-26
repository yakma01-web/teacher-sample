// 전역 변수
let currentUser = null;
let stocks = [];
let userStocks = [];
let news = [];
let transactions = [];
let users = [];
let stockCharts = {}; // 각 주식의 차트 인스턴스를 저장
let tradingAllowed = false; // 거래 가능 여부

// 로그인
async function login() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    if (!username || !password) {
        alert('아이디와 비밀번호를 입력해주세요.');
        return;
    }

    try {
        const response = await axios.post('/api/auth/login', { username, password });
        currentUser = response.data.user;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        
        // 비밀번호 변경 여부 확인
        if (currentUser.password_changed === 0) {
            showPasswordChangeDialog();
        } else {
            showMainScreen();
        }
    } catch (error) {
        alert(error.response?.data?.error || '로그인에 실패했습니다.');
    }
}

// 비밀번호 변경 다이얼로그 표시
function showPasswordChangeDialog() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('passwordChangeScreen').classList.remove('hidden');
}

// 비밀번호 변경
async function changePassword() {
    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (!oldPassword || !newPassword || !confirmPassword) {
        alert('모든 필드를 입력해주세요.');
        return;
    }

    if (newPassword !== confirmPassword) {
        alert('새 비밀번호가 일치하지 않습니다.');
        return;
    }

    if (newPassword.length < 4) {
        alert('비밀번호는 최소 4자 이상이어야 합니다.');
        return;
    }

    try {
        await axios.post('/api/auth/change-password', {
            userId: currentUser.id,
            oldPassword: oldPassword,
            newPassword: newPassword
        });

        alert('비밀번호가 변경되었습니다.');
        currentUser.password_changed = 1;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        
        document.getElementById('passwordChangeScreen').classList.add('hidden');
        showMainScreen();
    } catch (error) {
        alert(error.response?.data?.error || '비밀번호 변경에 실패했습니다.');
    }
}

// 회원가입 기능 제거됨 - 학번으로 계정이 자동 생성되어 있습니다.

// 로그아웃
function logout() {
    localStorage.removeItem('currentUser');
    currentUser = null;
    document.getElementById('mainScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
}

// 화면 전환 함수 제거됨

function showMainScreen() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('passwordChangeScreen').classList.add('hidden');
    document.getElementById('mainScreen').classList.remove('hidden');
    
    document.getElementById('userName').textContent = currentUser.name;
    loadData();
}

// 데이터 로드
async function loadData() {
    await checkTradingStatus();
    await checkAndApplyPendingPrices();
    await loadStocks();
    await loadUserInfo();
    await loadUserStocks();
    await loadNews();
    await loadTransactions();
    await loadUsers();
    updateDisplay();
}

// 거래 시간에 예약된 주가 자동 적용
async function checkAndApplyPendingPrices() {
    try {
        if (tradingAllowed) {
            await axios.post('/api/apply-pending-prices');
        }
    } catch (error) {
        // 에러 무시 (이미 적용되었거나 예약이 없을 수 있음)
    }
}

async function loadStocks() {
    try {
        const response = await axios.get('/api/stocks');
        stocks = response.data.stocks;
    } catch (error) {
        console.error('주식 로드 실패:', error);
    }
}

async function loadUserInfo() {
    try {
        const response = await axios.get(`/api/users/${currentUser.id}`);
        currentUser = response.data.user;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
    } catch (error) {
        console.error('사용자 정보 로드 실패:', error);
    }
}

async function loadUserStocks() {
    try {
        const response = await axios.get(`/api/users/${currentUser.id}/stocks`);
        userStocks = response.data.userStocks;
    } catch (error) {
        console.error('보유 주식 로드 실패:', error);
    }
}

async function loadNews() {
    try {
        const response = await axios.get(`/api/news?userId=${currentUser.id}`);
        news = response.data.news;
    } catch (error) {
        console.error('뉴스 로드 실패:', error);
    }
}

async function loadTransactions() {
    try {
        const response = await axios.get(`/api/transactions/${currentUser.id}`);
        transactions = response.data.transactions;
    } catch (error) {
        console.error('거래 내역 로드 실패:', error);
    }
}

async function loadUsers() {
    try {
        const response = await axios.get('/api/users');
        users = response.data.users;
    } catch (error) {
        console.error('사용자 목록 로드 실패:', error);
    }
}

let lastTradingStatus = null; // 이전 거래 상태 추적
let isBetaPeriod = false; // 베타 테스트 기간 여부

async function checkTradingStatus() {
    try {
        const response = await axios.get('/api/trading-status');
        const currentStatus = response.data.allowed;
        isBetaPeriod = response.data.isBeta || false;
        
        // 베타 기간이 아닐 때만 거래 시간 종료 시 주가 업데이트
        if (!isBetaPeriod && lastTradingStatus === true && currentStatus === false) {
            console.log('거래 시간 종료 감지 - 주가 자동 업데이트 시작');
            await updateStockPricesByVolume();
        }
        
        tradingAllowed = currentStatus;
        lastTradingStatus = currentStatus;
        updateTradingStatusDisplay();
    } catch (error) {
        console.error('거래 시간 확인 실패:', error);
    }
}

// 거래량 기반 주가 자동 업데이트
async function updateStockPricesByVolume() {
    try {
        const response = await axios.post('/api/update-prices-by-volume');
        if (response.data.updated > 0) {
            console.log(`${response.data.updated}개 종목의 주가가 업데이트되었습니다.`);
            // 주가 업데이트 후 데이터 새로고침
            await loadStocks();
            updateDisplay();
        }
    } catch (error) {
        console.error('주가 업데이트 실패:', error);
    }
}

function updateTradingStatusDisplay() {
    // 헤더에 거래 가능 여부 표시
    const header = document.querySelector('.bg-indigo-900');
    let statusBadge = document.getElementById('tradingStatusBadge');
    
    if (!statusBadge) {
        statusBadge = document.createElement('div');
        statusBadge.id = 'tradingStatusBadge';
        statusBadge.className = 'ml-4 px-4 py-1 rounded-full text-sm font-semibold';
        const h1 = header.querySelector('h1');
        h1.appendChild(statusBadge);
    }
    
    // 거래 상태만 표시 (베타 테스트 안내 제거)
    if (tradingAllowed) {
        statusBadge.className = 'ml-4 px-4 py-1 rounded-full text-sm font-semibold bg-green-500 text-white';
        statusBadge.innerHTML = '<i class="fas fa-check-circle mr-1"></i>거래 가능';
    } else {
        statusBadge.className = 'ml-4 px-4 py-1 rounded-full text-sm font-semibold bg-red-500 text-white';
        statusBadge.innerHTML = '<i class="fas fa-times-circle mr-1"></i>거래 불가';
    }
}

// 화면 업데이트
function updateDisplay() {
    const totalStockValue = userStocks.reduce((sum, stock) => sum + (stock.current_price * stock.quantity), 0);
    const totalAssets = currentUser.cash + totalStockValue;

    document.getElementById('userCash').textContent = formatMoney(currentUser.cash);
    document.getElementById('totalAssets').textContent = formatMoney(totalAssets);

    displayStocks();
    displayPortfolio();
    displayNews();
    displayRanking();
}

// 주식 목록 표시
function displayStocks() {
    const stocksList = document.getElementById('stocksList');
    stocksList.innerHTML = stocks.map(stock => {
        const userStock = userStocks.find(us => us.stock_id === stock.id);
        const holding = userStock ? userStock.quantity : 0;

        return `
            <div class="bg-white rounded-lg shadow-lg p-6">
                <h3 class="text-xl font-bold mb-2">${stock.name}</h3>
                <p class="text-gray-600 mb-2">종목코드: ${stock.code}</p>
                <p class="text-3xl font-bold text-blue-600 mb-4">${formatMoney(stock.current_price)}</p>
                <p class="text-sm text-gray-600 mb-4">보유 수량: ${holding}주</p>
                
                <!-- 가격 변동 차트 -->
                <div class="mb-4">
                    <canvas id="chart-${stock.id}" height="120"></canvas>
                </div>
                
                <div class="space-y-2">
                    <div class="flex space-x-2">
                        <input type="number" id="qty-${stock.id}" class="flex-1 px-3 py-2 border rounded" placeholder="수량" min="1" value="1">
                        <button onclick="buyStock(${stock.id})" class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded font-semibold">
                            매수
                        </button>
                        <button onclick="sellStock(${stock.id})" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded font-semibold" ${holding === 0 ? 'disabled' : ''}>
                            매도
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    // 차트 렌더링 (DOM이 준비된 후)
    setTimeout(() => {
        stocks.forEach(stock => renderStockChart(stock.id));
    }, 100);
}

// 포트폴리오 표시
function displayPortfolio() {
    const portfolioList = document.getElementById('portfolioList');
    
    if (userStocks.length === 0) {
        portfolioList.innerHTML = '<p class="text-gray-500 text-center py-8">보유한 주식이 없습니다.</p>';
    } else {
        portfolioList.innerHTML = userStocks.map(stock => {
            const profitColor = stock.profit >= 0 ? 'text-red-600' : 'text-blue-600';
            const profitSign = stock.profit >= 0 ? '+' : '';
            
            return `
                <div class="bg-white rounded-lg shadow p-6">
                    <div class="flex justify-between items-center">
                        <div>
                            <h3 class="text-xl font-bold">${stock.name}</h3>
                            <p class="text-gray-600">수량: ${stock.quantity}주 | 평균 매입가: ${formatMoney(stock.avg_price)}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-2xl font-bold">${formatMoney(stock.current_price)}</p>
                            <p class="${profitColor} font-semibold">
                                ${profitSign}${formatMoney(stock.profit)} (${profitSign}${stock.profit_rate.toFixed(2)}%)
                            </p>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // 거래 내역
    const transactionsList = document.getElementById('transactionsList');
    if (transactions.length === 0) {
        transactionsList.innerHTML = '<p class="text-gray-500 text-center py-8">거래 내역이 없습니다.</p>';
    } else {
        transactionsList.innerHTML = transactions.map(tx => {
            const typeClass = tx.type === 'BUY' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800';
            const typeText = tx.type === 'BUY' ? '매수' : '매도';
            
            return `
                <div class="bg-white rounded shadow p-4 flex justify-between items-center">
                    <div>
                        <span class="${typeClass} px-3 py-1 rounded font-semibold text-sm">${typeText}</span>
                        <span class="ml-3 font-semibold">${tx.name}</span>
                        <span class="ml-3 text-gray-600">${tx.quantity}주 @ ${formatMoney(tx.price)}</span>
                    </div>
                    <div class="text-right">
                        <p class="font-bold">${formatMoney(tx.total_amount)}</p>
                        <p class="text-sm text-gray-500">${new Date(tx.created_at).toLocaleString('ko-KR')}</p>
                    </div>
                </div>
            `;
        }).join('');
    }
}

// 뉴스 표시
function displayNews() {
    const newsList = document.getElementById('newsList');
    
    if (news.length === 0) {
        newsList.innerHTML = '<p class="text-gray-500 text-center py-8">등록된 뉴스가 없습니다.</p>';
    } else {
        newsList.innerHTML = news.map(item => {
            const isPurchased = item.purchased !== false;
            const isLocked = !isPurchased && item.type === 'PREMIUM';
            
            const typeClass = item.type === 'FREE' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800';
            const typeText = item.type === 'FREE' ? '무료' : `유료 (${formatMoney(item.price)})`;
            
            // 잠긴 뉴스는 미리보기 표시 안함
            const contentPreview = isLocked ? '' : `<p class="text-gray-600 mb-3">${item.content.substring(0, 100)}${item.content.length > 100 ? '...' : ''}</p>`;
            const buttonText = isLocked ? '🔒 구매하기' : '자세히 보기';
            const buttonClass = isLocked ? 'bg-yellow-500 hover:bg-yellow-600' : 'bg-blue-500 hover:bg-blue-600';
            
            return `
                <div class="bg-white rounded-lg shadow p-6 ${isLocked ? 'opacity-75' : ''}">
                    <div class="flex justify-between items-start mb-3">
                        <h3 class="text-xl font-bold flex-1">${item.title}</h3>
                        <span class="${typeClass} px-3 py-1 rounded font-semibold text-sm">${typeText}</span>
                    </div>
                    ${contentPreview}
                    <div class="flex justify-between items-center">
                        <p class="text-sm text-gray-500">${new Date(item.created_at).toLocaleString('ko-KR')}</p>
                        <button onclick="viewNews(${item.id})" class="${buttonClass} text-white px-4 py-2 rounded">
                            ${buttonText}
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }
}

// 순위표 표시
function displayRanking() {
    const rankingList = document.getElementById('rankingList');
    
    if (users.length === 0) {
        rankingList.innerHTML = '<p class="text-gray-500 text-center py-8">사용자가 없습니다.</p>';
    } else {
        // 모바일: 카드 형식, 데스크톱: 테이블 형식
        rankingList.innerHTML = `
            <!-- 모바일 버전 (카드 형식) -->
            <div class="block md:hidden space-y-3">
                ${users.map((user, index) => {
                    const isMe = user.id === currentUser.id;
                    const borderClass = isMe ? 'border-2 border-blue-500' : 'border border-gray-200';
                    const bgClass = isMe ? 'bg-blue-50' : 'bg-white';
                    
                    return `
                        <div class="${bgClass} ${borderClass} rounded-lg p-4 shadow">
                            <div class="flex items-center justify-between mb-3">
                                <div class="flex items-center space-x-3">
                                    <div class="text-2xl font-bold text-indigo-600">${index + 1}</div>
                                    <div>
                                        <div class="font-bold text-lg">${user.name}</div>
                                        ${isMe ? '<span class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded">나</span>' : ''}
                                    </div>
                                </div>
                                <div class="text-right">
                                    <div class="text-xs text-gray-500">총 자산</div>
                                    <div class="text-lg font-bold text-green-600">${formatMoney(user.total_assets)}</div>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-2 pt-3 border-t">
                                <div>
                                    <div class="text-xs text-gray-500">현금</div>
                                    <div class="font-semibold text-sm">${formatMoney(user.cash)}</div>
                                </div>
                                <div>
                                    <div class="text-xs text-gray-500">주식 가치</div>
                                    <div class="font-semibold text-sm">${formatMoney(user.stock_value)}</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            
            <!-- 데스크톱 버전 (테이블 형식) -->
            <div class="hidden md:block overflow-x-auto">
                <table class="w-full">
                    <thead class="bg-gray-200">
                        <tr>
                            <th class="px-6 py-3 text-left font-bold">순위</th>
                            <th class="px-6 py-3 text-left font-bold">이름</th>
                            <th class="px-6 py-3 text-right font-bold">현금</th>
                            <th class="px-6 py-3 text-right font-bold">주식 가치</th>
                            <th class="px-6 py-3 text-right font-bold">총 자산</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${users.map((user, index) => {
                            const isMe = user.id === currentUser.id;
                            const bgClass = isMe ? 'bg-blue-50 font-bold' : '';
                            
                            return `
                                <tr class="${bgClass} border-b hover:bg-gray-50">
                                    <td class="px-6 py-4">${index + 1}</td>
                                    <td class="px-6 py-4">${user.name} ${isMe ? '(나)' : ''}</td>
                                    <td class="px-6 py-4 text-right">${formatMoney(user.cash)}</td>
                                    <td class="px-6 py-4 text-right">${formatMoney(user.stock_value)}</td>
                                    <td class="px-6 py-4 text-right">${formatMoney(user.total_assets)}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }
}

// 매수
async function buyStock(stockId) {
    const quantity = parseInt(document.getElementById(`qty-${stockId}`).value);
    
    if (!quantity || quantity <= 0) {
        alert('수량을 입력해주세요.');
        return;
    }

    const stock = stocks.find(s => s.id === stockId);
    const totalAmount = stock.current_price * quantity;

    if (currentUser.cash < totalAmount) {
        alert('잔액이 부족합니다.');
        return;
    }

    if (!confirm(`${stock.name} ${quantity}주를 ${formatMoney(totalAmount)}에 매수하시겠습니까?`)) {
        return;
    }

    try {
        await axios.post('/api/transactions/buy', {
            userId: currentUser.id,
            stockId: stockId,
            quantity: quantity
        });
        
        alert('매수가 완료되었습니다.');
        await loadData();
    } catch (error) {
        alert(error.response?.data?.error || '매수에 실패했습니다.');
    }
}

// 매도
async function sellStock(stockId) {
    const quantity = parseInt(document.getElementById(`qty-${stockId}`).value);
    
    if (!quantity || quantity <= 0) {
        alert('수량을 입력해주세요.');
        return;
    }

    const userStock = userStocks.find(us => us.stock_id === stockId);
    if (!userStock || userStock.quantity < quantity) {
        alert('보유 수량이 부족합니다.');
        return;
    }

    const stock = stocks.find(s => s.id === stockId);
    const totalAmount = stock.current_price * quantity;

    if (!confirm(`${stock.name} ${quantity}주를 ${formatMoney(totalAmount)}에 매도하시겠습니까?`)) {
        return;
    }

    try {
        await axios.post('/api/transactions/sell', {
            userId: currentUser.id,
            stockId: stockId,
            quantity: quantity
        });
        
        alert('매도가 완료되었습니다.');
        await loadData();
    } catch (error) {
        alert(error.response?.data?.error || '매도에 실패했습니다.');
    }
}

// 뉴스 보기
async function viewNews(newsId) {
    try {
        const response = await axios.get(`/api/news/${newsId}/${currentUser.id}`);
        const { news, purchased } = response.data;

        if (!purchased) {
            if (confirm(`이 뉴스는 ${formatMoney(news.price)}입니다. 구매하시겠습니까?`)) {
                try {
                    const purchaseResponse = await axios.post('/api/news/purchase', {
                        newsId: newsId,
                        userId: currentUser.id
                    });
                    
                    alert('뉴스를 구매했습니다.');
                    await loadData();
                    viewNews(newsId);
                } catch (error) {
                    alert(error.response?.data?.error || '뉴스 구매에 실패했습니다.');
                }
            }
        } else {
            alert(`[${news.title}]\n\n${news.content}`);
        }
    } catch (error) {
        alert('뉴스를 불러오는데 실패했습니다.');
    }
}

// 탭 전환
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.add('hidden'));
    document.getElementById(`${tabName}Tab`).classList.remove('hidden');
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-blue-600', 'text-blue-600');
        btn.classList.add('text-gray-600');
    });
    
    event.target.classList.add('border-blue-600', 'text-blue-600');
    event.target.classList.remove('text-gray-600');
}

// 주식 차트 렌더링
async function renderStockChart(stockId) {
    try {
        // 주가 이력 조회
        const response = await axios.get(`/api/stocks/${stockId}`);
        const history = response.data.history;
        
        // 차트가 이미 존재하면 파괴
        if (stockCharts[stockId]) {
            stockCharts[stockId].destroy();
        }
        
        const canvas = document.getElementById(`chart-${stockId}`);
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // 데이터가 없으면 기본 메시지
        if (!history || history.length === 0) {
            ctx.font = '14px Arial';
            ctx.fillStyle = '#999';
            ctx.textAlign = 'center';
            ctx.fillText('가격 변동 기록이 없습니다', canvas.width / 2, canvas.height / 2);
            return;
        }
        
        // 최신순으로 정렬된 데이터를 오래된순으로 변경
        const sortedHistory = [...history].reverse();
        
        // 차트 데이터 준비
        const labels = sortedHistory.map(h => {
            const date = new Date(h.created_at);
            return date.toLocaleString('ko-KR', { 
                month: 'short', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
            });
        });
        
        const prices = sortedHistory.map(h => h.price);
        
        // 차트 생성
        stockCharts[stockId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: '주가',
                    data: prices,
                    borderColor: 'rgb(59, 130, 246)',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 3,
                    pointHoverRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return '주가: ' + formatMoney(context.parsed.y);
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        ticks: {
                            callback: function(value) {
                                return (value / 1000).toFixed(0) + 'K';
                            }
                        }
                    },
                    x: {
                        ticks: {
                            maxRotation: 45,
                            minRotation: 45,
                            font: {
                                size: 10
                            }
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error(`차트 렌더링 실패 (주식 ID: ${stockId}):`, error);
    }
}

// 유틸리티 함수
function formatMoney(amount) {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount);
}

// 페이지 로드 시
window.addEventListener('DOMContentLoaded', () => {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        showMainScreen();
        
        // 30초마다 거래 시간 상태 확인
        setInterval(checkTradingStatus, 30000);
    }
});
