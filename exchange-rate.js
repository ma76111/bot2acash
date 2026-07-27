/**
 * Auto Exchange Rate Updater
 * يجيب سعر شراء USDT من Binance P2P كل 10 دقائق ويحدث قاعدة البيانات
 */

const https = require('https');

const UPDATE_INTERVAL = 10 * 60 * 1000; // 10 دقائق

// Binance P2P API - سعر شراء USDT بالجنيه المصري
function fetchBinanceP2PRate() {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            fiat: 'EGP',
            page: 1,
            rows: 5,
            tradeType: 'BUY',      // سعر الشراء
            asset: 'USDT',
            countries: [],
            proMerchantAds: false,
            shieldMerchantAds: false,
            filterType: 'all',
            periods: [],
            additionalKycVerifyFilter: 0,
            publisherType: null,
            payTypes: [],
            classifies: ['mass', 'profession']
        });

        const options = {
            hostname: 'p2p.binance.com',
            path: '/bapi/c2c/v2/friendly/c2c/adv/search',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'Mozilla/5.0'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const ads = parsed?.data;
                    if (!ads || ads.length === 0) return reject(new Error('No ads found'));

                    // خذ متوسط أول 3 إعلانات
                    const prices = ads.slice(0, 3).map(ad => parseFloat(ad.adv.price));
                    const avgRate = prices.reduce((a, b) => a + b, 0) / prices.length;
                    resolve(Math.round(avgRate * 100) / 100);
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(payload);
        req.end();
    });
}

async function updateExchangeRate(db) {
    try {
        const rate = await fetchBinanceP2PRate();
        await db.setSetting('usd_to_egp_rate', rate.toString());
        console.log(`[ExchangeRate] ✅ تم تحديث سعر الصرف: 1 USDT = ${rate} EGP`);
        return rate;
    } catch (err) {
        console.error(`[ExchangeRate] ❌ فشل تحديث سعر الصرف: ${err.message}`);
        return null;
    }
}

function startAutoRateUpdate(db) {
    console.log('[ExchangeRate] 🚀 بدء تحديث سعر الصرف التلقائي من Binance P2P كل 10 دقائق');

    // تحديث فوري عند البدء
    updateExchangeRate(db);

    // ثم كل 10 دقائق
    setInterval(() => updateExchangeRate(db), UPDATE_INTERVAL);
}

module.exports = { startAutoRateUpdate, updateExchangeRate, fetchBinanceP2PRate };
