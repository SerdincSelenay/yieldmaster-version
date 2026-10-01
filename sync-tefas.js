/**
 * Otomatik TEFAS Canlı Fiyat & Getiri Senkronizasyon Scripti
 * Her iş günü sabahı GitHub Actions tarafından çalıştırılır.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

function postTefas(endpoint, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request(`https://www.tefas.gov.tr/api/funds/${endpoint}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://www.tefas.gov.tr',
        'Referer': 'https://www.tefas.gov.tr/tr/fon-verileri',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 30000
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    });
    req.on('error', (err) => {
      console.warn(`[TEFAS ${endpoint}] İstek hatası:`, err.message);
      resolve({});
    });
    req.write(data);
    req.end();
  });
}

function formatDateYYYYMMDD(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

async function run() {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const past = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const basTarih = formatDateYYYYMMDD(past);
  const bitTarih = formatDateYYYYMMDD(now);

  console.log(`[Sync] TEFAS Verileri Çekiliyor: ${todayStr}...`);

  const makePricePayload = (fonTipi) => ({
    fonTipi,
    fonKodu: null,
    aramaMetni: null,
    fonTurKod: null,
    fonGrubu: null,
    sfonTurKod: null,
    fonTurAciklama: null,
    kurucuKod: null,
    basTarih,
    bitTarih,
    basSira: 1,
    bitSira: 100000,
    dil: 'TR',
    sFonTurKod: '',
    fonKod: '',
    fonGrup: '',
    fonUnvanTip: ''
  });

  const [resPricesYat, resPricesEmk] = await Promise.all([
    postTefas('fonGnlBlgSiraliGetir', makePricePayload('YAT')),
    postTefas('fonGnlBlgSiraliGetir', makePricePayload('EMK'))
  ]);

  const allPriceRows = [...(resPricesYat.resultList || []), ...(resPricesEmk.resultList || [])];
  console.log(`[Sync] Fiyat kayıt sayısı: ${allPriceRows.length}`);

  const makeReturnPayload = (fonTipi) => ({
    fonTipi,
    dil: 'TR',
    calismaTipi: 2,
    donemGetiri1a: '1',
    donemGetiri3a: '1',
    donemGetiri6a: '1',
    donemGetiriyb: '1',
    donemGetiri1y: '1',
    donemGetiri3y: '1',
    donemGetiri5y: '1'
  });

  const [resReturnsYat, resReturnsEmk] = await Promise.all([
    postTefas('fonGetiriBazliBilgiGetir', makeReturnPayload('YAT')),
    postTefas('fonGetiriBazliBilgiGetir', makeReturnPayload('EMK'))
  ]);

  const allReturns = [...(resReturnsYat.resultList || []), ...(resReturnsEmk.resultList || [])];
  console.log(`[Sync] Getiri kayıt sayısı: ${allReturns.length}`);

  if (allPriceRows.length < 500) {
    console.error('Yetersiz veri alındı, dosya bozulmasını önlemek için güncellenmedi.');
    process.exit(1);
  }

  const returnsMap = new Map();
  for (const ret of allReturns) {
    if (!ret.fonKodu) continue;
    returnsMap.set(ret.fonKodu.trim().toUpperCase(), ret);
  }

  const fundMap = new Map();
  for (const row of allPriceRows) {
    if (!row.fonKodu) continue;
    const code = row.fonKodu.trim().toUpperCase();
    if (!fundMap.has(code)) {
      fundMap.set(code, []);
    }
    fundMap.get(code).push(row);
  }

  const compactFunds = {};
  let count = 0;
  let latestDateInDataset = todayStr;

  for (const [code, items] of fundMap.entries()) {
    items.sort((a, b) => String(a.tarih).localeCompare(String(b.tarih)));
    const latest = items[items.length - 1];
    const prev = items.length > 1 ? items[items.length - 2] : latest;

    const latestPrice = Number(latest.fiyat) || 0;
    const prevPrice = Number(prev.fiyat) || latestPrice;
    let dailyReturn = prevPrice > 0 ? ((latestPrice - prevPrice) / prevPrice) * 100 : 0;
    if (isNaN(dailyReturn)) dailyReturn = 0;

    const weekAgoStr = formatDateYYYYMMDD(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const weekItem = items.find(x => String(x.tarih).replace(/[-/]/g, '') >= weekAgoStr) || prev;
    const weekPrice = Number(weekItem.fiyat) || prevPrice;
    let weeklyReturn = weekPrice > 0 ? ((latestPrice - weekPrice) / weekPrice) * 100 : dailyReturn;

    const ret = returnsMap.get(code);
    if (latest.tarih && latest.tarih > latestDateInDataset) {
      latestDateInDataset = latest.tarih;
    }

    compactFunds[code] = {
      p: Number(latestPrice.toFixed(6)),
      pr: Number(prevPrice.toFixed(6)),
      d: Number(dailyReturn.toFixed(4)),
      w: Number(weeklyReturn.toFixed(2)),
      m: ret?.getiri1a != null ? Number(Number(ret.getiri1a).toFixed(2)) : null,
      m3: ret?.getiri3a != null ? Number(Number(ret.getiri3a).toFixed(2)) : null,
      m6: ret?.getiri6a != null ? Number(Number(ret.getiri6a).toFixed(2)) : null,
      y: ret?.getiriyb != null ? Number(Number(ret.getiriyb).toFixed(2)) : null,
      a: ret?.getiri1y != null ? Number(Number(ret.getiri1y).toFixed(2)) : null,
      y3: ret?.getiri3y != null ? Number(Number(ret.getiri3y).toFixed(2)) : null,
      y5: ret?.getiri5y != null ? Number(Number(ret.getiri5y).toFixed(2)) : null,
      r: ret?.riskDegeri ? parseInt(ret.riskDegeri, 10) : null,
      aum: latest.portfoyBuyukluk || null,
      inv: latest.kisiSayisi || null,
      dt: latest.tarih || todayStr
    };
    count++;
  }

  const payload = {
    date: latestDateInDataset,
    updatedAt: now.toISOString(),
    count,
    funds: compactFunds
  };

  const outputPath = path.resolve(__dirname, 'dailyPrices.json');
  fs.writeFileSync(outputPath, JSON.stringify(payload), 'utf8');
  console.log(`✅ dailyPrices.json kaydedildi: ${count} fon (Veri Tarihi: ${latestDateInDataset})`);
}

run().catch(err => {
  console.error('[Sync Hatası]:', err);
  process.exit(1);
});
