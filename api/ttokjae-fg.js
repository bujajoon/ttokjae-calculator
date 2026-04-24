// api/ttokjae-fg.js
// 똑재 공포탐욕지수 산출용 5개 지표 자동 수집
// Usage: /api/ttokjae-fg

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const result = {
    momentum: null,     // KOSPI 125일 이평 대비 (%)
    vkospi: null,       // VKOSPI 현재값
    rsi: null,          // KOSPI 14일 RSI
    foreign: null,      // 외국인 20일 누적 순매수 (조원)
    highlow: null,      // 52주 신고가 비율 (%)
    errors: [],
    timestamp: new Date().toISOString(),
  };
  
  // 1. 2. 3. KOSPI 차트로 모멘텀/RSI 계산, VKOSPI 별도
  try {
    const kospiData = await fetchKospiChart();
    if (kospiData) {
      result.momentum = kospiData.momentum;
      result.rsi = kospiData.rsi;
    }
  } catch (e) {
    result.errors.push({ source: 'KOSPI momentum/RSI', error: e.message });
  }
  
  // VKOSPI (investing.com 또는 Yahoo)
  try {
    result.vkospi = await fetchVKOSPI();
  } catch (e) {
    result.errors.push({ source: 'VKOSPI', error: e.message });
  }
  
  // 4. 외국인 20일 누적 순매수 (KRX 정보)
  try {
    result.foreign = await fetchForeignNetBuying();
  } catch (e) {
    result.errors.push({ source: 'Foreign net buying', error: e.message });
  }
  
  // 5. 52주 신고가/신저가 비율 
  try {
    result.highlow = await fetchHighLowRatio();
  } catch (e) {
    result.errors.push({ source: 'High/Low ratio', error: e.message });
  }
  
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
  return res.status(200).json(result);
}

// KOSPI 차트로 모멘텀(이평 대비 %) + RSI 계산
async function fetchKospiChart() {
  const today = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 500);
  
  const formatDate = d => d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  
  // 네이버 증권에서 KOSPI 지수 데이터
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=KOSPI&requestType=1&startTime=${formatDate(startDate)}&endTime=${formatDate(today)}&timeframe=day`;
  
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://finance.naver.com/',
    },
  });
  if (!r.ok) throw new Error(`Naver KOSPI ${r.status}`);
  
  let text = await r.text();
  text = text.trim().replace(/'/g, '"').replace(/,\s*]/g, ']').replace(/,\s*\}/g, '}');
  const rows = JSON.parse(text);
  
  if (!Array.isArray(rows) || rows.length < 130) {
    throw new Error('KOSPI 데이터 부족');
  }
  
  const dataRows = rows.slice(1);
  const closes = dataRows.map(r => Number(r[4])).filter(v => !isNaN(v) && v > 0);
  
  if (closes.length < 125) throw new Error('125일 이평 계산용 데이터 부족');
  
  // 현재가 & 125일 이평
  const currentPrice = closes[closes.length - 1];
  const last125 = closes.slice(-125);
  const ma125 = last125.reduce((s, v) => s + v, 0) / 125;
  const momentum = Number(((currentPrice - ma125) / ma125 * 100).toFixed(2));
  
  // 14일 RSI
  const rsi = calculateRSI(closes, 14);
  
  return {
    momentum,
    rsi: Number(rsi.toFixed(2)),
    currentPrice,
    ma125: Number(ma125.toFixed(2)),
  };
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// VKOSPI (investing.com 스크래핑)
async function fetchVKOSPI() {
  const url = 'https://kr.investing.com/indices/kospi-volatility';
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });
  if (!r.ok) throw new Error(`investing ${r.status}`);
  const html = await r.text();
  const patterns = [
    /data-test="instrument-price-last"[^>]*>([0-9.,]+)</,
    /"last":"([0-9.,]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(v) && v > 5 && v < 200) return Number(v.toFixed(2));
    }
  }
  throw new Error('VKOSPI 값 추출 실패');
}

// 외국인 20일 누적 순매수 (조원) - KRX 정보데이터시스템
async function fetchForeignNetBuying() {
  // 최근 20영업일의 KOSPI 외국인 순매수 합계
  // 참고 URL: https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd
  const today = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 35); // 20 영업일 확보 위해 여유있게
  
  const fmt = d => d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT02301',
    locale: 'ko_KR',
    mktId: 'STK',  // 유가증권 (KOSPI)
    invstTpCd: '9000',  // 외국인
    strtDd: fmt(startDate),
    endDd: fmt(today),
    money: '1',  // 원 단위 (1) / 백만원 (2) / 십억원 (3)
    csvxls_isNo: 'false',
  });
  
  const r = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.krx.co.kr/',
    },
    body: body.toString(),
  });
  
  if (!r.ok) throw new Error(`KRX ${r.status}`);
  const j = await r.json();
  
  // 응답 구조: { output: [ { TRD_DD, NETBID_TRDVAL, ... }, ... ] }
  const rows = j.output || [];
  if (rows.length === 0) throw new Error('KRX 외국인 매매 데이터 없음');
  
  // 최근 20영업일의 순매수금액 합산 (원 단위)
  const recent20 = rows.slice(0, 20);
  const sum = recent20.reduce((s, row) => {
    const val = Number(String(row.NETBID_TRDVAL || '0').replace(/,/g, ''));
    return s + (isNaN(val) ? 0 : val);
  }, 0);
  
  // 원 → 조원 변환
  const trillions = sum / 1_000_000_000_000;
  return Number(trillions.toFixed(2));
}

// 52주 신고가 비율 - KRX
async function fetchHighLowRatio() {
  // KRX에서 당일 52주 신고가/신저가 종목 수 조회
  // 참고: https://data.krx.co.kr > KOSPI 52주 신고가/신저가
  const today = new Date();
  const fmt = d => d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT01701',
    locale: 'ko_KR',
    mktId: 'STK',
    trdDd: fmt(today),
    hi52wStkCnd: '52W_HIGH',
    csvxls_isNo: 'false',
  });
  
  // High 종목 수 가져오기
  const highRes = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.krx.co.kr/',
    },
    body: body.toString(),
  });
  
  if (!highRes.ok) throw new Error(`KRX high ${highRes.status}`);
  const highJson = await highRes.json();
  const highCount = (highJson.output || []).length;
  
  // Low 종목 수
  const bodyLow = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT01701',
    locale: 'ko_KR',
    mktId: 'STK',
    trdDd: fmt(today),
    hi52wStkCnd: '52W_LOW',
    csvxls_isNo: 'false',
  });
  
  const lowRes = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.krx.co.kr/',
    },
    body: bodyLow.toString(),
  });
  
  if (!lowRes.ok) throw new Error(`KRX low ${lowRes.status}`);
  const lowJson = await lowRes.json();
  const lowCount = (lowJson.output || []).length;
  
  if (highCount + lowCount === 0) {
    // 당일 데이터 없으면 (주말/공휴일 등) 전날 시도
    throw new Error('52주 신고가/신저가 데이터 없음');
  }
  
  return Number((highCount / (highCount + lowCount) * 100).toFixed(2));
}
