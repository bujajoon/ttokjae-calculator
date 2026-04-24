// api/macros.js
// 매크로 지수 프록시 — VIX, CNN 공포탐욕지수, VKOSPI 자동 조회
// Usage: /api/macros

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const results = {
    vix: null,
    cnnFearGreed: null,
    vkospi: null,
    errors: [],
    timestamp: new Date().toISOString(),
  };
  
  // 3개 소스를 동시에 호출
  const promises = [
    fetchVIX().then(v => results.vix = v).catch(e => results.errors.push({ source: 'VIX', error: e.message })),
    fetchCNNFearGreed().then(v => results.cnnFearGreed = v).catch(e => results.errors.push({ source: 'CNN', error: e.message })),
    fetchVKOSPI().then(v => results.vkospi = v).catch(e => results.errors.push({ source: 'VKOSPI', error: e.message })),
  ];
  
  await Promise.allSettled(promises);
  
  // 15분 캐싱
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=1800');
  return res.status(200).json(results);
}

// VIX from Yahoo Finance
async function fetchVIX() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d';
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error('Yahoo VIX fetch failed');
  const d = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  return {
    value: Number((meta?.regularMarketPrice || 0).toFixed(2)),
    previousClose: Number((meta?.chartPreviousClose || 0).toFixed(2)),
  };
}

// CNN Fear & Greed Index (비공식 API)
async function fetchCNNFearGreed() {
  const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.cnn.com/',
    },
  });
  if (!r.ok) throw new Error(`CNN F&G fetch failed: ${r.status}`);
  const d = await r.json();
  const score = d?.fear_and_greed?.score;
  const rating = d?.fear_and_greed?.rating;
  if (score == null) throw new Error('No F&G score');
  return {
    value: Math.round(score),
    rating: rating || '',
    previousClose: Math.round(d?.fear_and_greed?.previous_close || 0),
  };
}

// VKOSPI from Yahoo Finance (^VKOSPI)
async function fetchVKOSPI() {
  // Yahoo에서는 VKOSPI가 없음 — investing.com에서 가져오거나 KRX
  // 대안: Yahoo의 ^KS11 (KOSPI) 대비 최근 변동성으로 추정 or investing.com 스크래핑
  // 여기서는 investing.com HTML 스크래핑 시도
  try {
    const url = 'https://kr.investing.com/indices/kospi-volatility';
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!r.ok) throw new Error(`investing.com status ${r.status}`);
    const html = await r.text();
    
    // data-test="instrument-price-last" 또는 유사 패턴 매칭
    const patterns = [
      /data-test="instrument-price-last"[^>]*>([0-9.,]+)</,
      /"last":"([0-9.,]+)"/,
      /class="[^"]*text-\[#232526\][^"]*"[^>]*>([0-9.,]+)</,
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(value) && value > 5 && value < 200) {
          return { value: Number(value.toFixed(2)), source: 'investing.com' };
        }
      }
    }
    throw new Error('VKOSPI value not found in HTML');
  } catch (e) {
    throw new Error(`VKOSPI: ${e.message}`);
  }
}
