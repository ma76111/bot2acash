require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Database = require('./database');
const config = require('./config');
const keyboards = require('./keyboards');
const { startAutoBackup } = require('./github-backup');
const { startAutoRateUpdate } = require('./exchange-rate');

// Create bot with improved connection settings
const bot = new TelegramBot(config.BOT_TOKEN, {
    polling: {
        interval: 1000, // More conservative polling interval
        autoStart: false, // Don't auto-start, we'll start manually
        params: {
            timeout: 60, // Longer timeout for better stability
            limit: 10, // Fewer updates per request for stability
            allowed_updates: ['message', 'callback_query', 'contact']
        }
    },
    request: {
        agentOptions: {
            keepAlive: true,
            keepAliveMsecs: 60000, // Longer keep-alive
            maxSockets: 10, // Fewer concurrent connections
            maxFreeSockets: 5,
            timeout: 60000 // 60 second timeout
        },
        timeout: 60000, // 60 second timeout for requests
        forever: true // Keep connection alive
    }
});
const db = new Database();

// Advanced error handling and logging
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
}

function logError(error, context = '') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ERROR ${context}: ${error.message}\n${error.stack}\n\n`;

    // Log to file (async to not block)
    fs.appendFile('logs/errors.log', logMessage, (err) => {
        if (err) console.error('Failed to write to error log:', err);
    });

    console.error(`[${timestamp}] ERROR ${context}:`, error);
}

function logActivity(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;

    // Log to file (async)
    fs.appendFile('logs/activity.log', logMessage, (err) => {
        if (err) console.error('Failed to write to activity log:', err);
    });
}

// Bot error handlers
bot.on('error', (error) => {
    logError(error, 'BOT_ERROR');
});

bot.on('polling_error', (error) => {
    logError(error, 'POLLING_ERROR');

    // Handle specific error types
    if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
        console.log('⚠️ Bot conflict detected (409). Another instance might be running.');
        console.log('🔧 Attempting to resolve conflict...');

        // Stop current polling
        bot.stopPolling();

        // Wait and try to restart
        setTimeout(async () => {
            try {
                console.log('🔄 Clearing webhook and restarting...');
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 3000));
                bot.startPolling();
                console.log('✅ Bot restarted successfully');
            } catch (restartError) {
                console.error('❌ Failed to restart bot:', restartError.message);
                console.log('💡 Please manually restart the bot');
            }
        }, 5000);
    } else if (error.code === 'EFATAL' || error.code === 'ESOCKETTIMEOUT' || error.code === 'ECONNRESET') {
        console.log(`⚠️ Connection error (${error.code}), attempting to reconnect...`);

        // Stop current polling
        bot.stopPolling();

        // Wait longer for timeout errors
        const delay = error.code === 'ESOCKETTIMEOUT' ? 15000 : 5000;

        setTimeout(async () => {
            try {
                console.log('🔄 Restarting bot polling...');
                await bot.startPolling();
                console.log('✅ Bot polling restarted successfully');
            } catch (restartError) {
                console.error('❌ Failed to restart polling:', restartError.message);
                // Try again after longer delay
                setTimeout(() => {
                    console.log('🔄 Attempting final restart...');
                    bot.startPolling();
                }, 30000);
            }
        }, delay);
    }
});

// Process error handlers
process.on('uncaughtException', (error) => {
    logError(error, 'UNCAUGHT_EXCEPTION');
    // Don't exit, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
    // Check if it's a Telegram "user blocked bot" error
    if (reason && reason.toString().includes('403 Forbidden: bot was blocked by the user')) {
        console.log('User blocked bot - this is normal behavior');
        return;
    }
    
    // Check if it's other common Telegram errors that are not critical
    if (reason && reason.toString().includes('ETELEGRAM')) {
        console.log('Telegram API error (non-critical):', reason.toString());
        return;
    }
    
    // Log other unhandled rejections
    logError(new Error(reason), 'UNHANDLED_REJECTION');
});

// High-performance state management for millions of users
const userStates = new Map();
const activeTasks = new Map();

// Memory optimization - Clean up old states every 5 minutes
setInterval(() => {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);

    // Clean up old user states
    for (const [userId, state] of userStates.entries()) {
        if (state.timestamp && state.timestamp < fiveMinutesAgo) {
            userStates.delete(userId);
        }
    }

    // Clean up old task states
    for (const [userId, task] of activeTasks.entries()) {
        if (task.timestamp && task.timestamp < fiveMinutesAgo) {
            activeTasks.delete(userId);
        }
    }

    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
}, 5 * 60 * 1000);

// Rate limiting for users
const userRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 30;

// Task cancellation tracking to prevent abuse
const taskCancellations = new Map();
const CANCEL_LIMIT_WINDOW = 3600000; // 1 hour
const MAX_CANCELLATIONS_PER_HOUR = 5;

function checkRateLimit(userId) {
    const now = Date.now();
    const userRequests = userRateLimit.get(userId) || [];

    // Remove old requests outside the window
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);

    if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
        return false; // Rate limited
    }

    recentRequests.push(now);
    userRateLimit.set(userId, recentRequests);
    return true;
}

// Helper functions
async function isAdmin(userId) {
    // Check if user is main admin from config
    if (userId.toString() === config.ADMIN_ID) {
        return true;
    }
    // Check if user is in admins table
    return await db.isAdmin(userId.toString());
}

async function isMainAdmin(userId) {
    return userId.toString() === config.ADMIN_ID;
}

// Safe message sending with error handling
async function safeSendMessage(userId, message, options = {}) {
    try {
        return await bot.sendMessage(userId, message, options);
    } catch (error) {
        // Handle specific Telegram errors
        if (error.code === 'ETELEGRAM') {
            const errorCode = error.response?.body?.error_code;
            const description = error.response?.body?.description || error.message;
            
            if (errorCode === 403) {
                // User blocked the bot or deleted account
                console.log(`User ${userId} blocked the bot or deleted account`);
                return null;
            } else if (errorCode === 400 && description.includes('chat not found')) {
                // Chat not found
                console.log(`Chat ${userId} not found`);
                return null;
            } else {
                // Other Telegram errors
                console.error(`Telegram error ${errorCode} for user ${userId}:`, description);
                return null;
            }
        } else {
            // Other errors
            console.error(`Error sending message to user ${userId}:`, error.message);
            return null;
        }
    }
}

// Extract wallet number from details (handles both old "Cash Wallet: 0123" and new "0123" formats)
function extractWalletNumber(details) {
    if (!details) return details;
    return details.replace(/^Cash Wallet:\s*/i, '').trim();
}

// ========================
// قائمة دول العالم مرقمة
// ========================
const COUNTRIES_LIST = [
    { code: 'AF', name: 'Afghanistan / أفغانستان' },
    { code: 'AL', name: 'Albania / ألبانيا' },
    { code: 'DZ', name: 'Algeria / الجزائر' },
    { code: 'AD', name: 'Andorra / أندورا' },
    { code: 'AO', name: 'Angola / أنغولا' },
    { code: 'AG', name: 'Antigua and Barbuda / أنتيغوا وبربودا' },
    { code: 'AR', name: 'Argentina / الأرجنتين' },
    { code: 'AM', name: 'Armenia / أرمينيا' },
    { code: 'AU', name: 'Australia / أستراليا' },
    { code: 'AT', name: 'Austria / النمسا' },
    { code: 'AZ', name: 'Azerbaijan / أذربيجان' },
    { code: 'BS', name: 'Bahamas / جزر البهاما' },
    { code: 'BH', name: 'Bahrain / البحرين' },
    { code: 'BD', name: 'Bangladesh / بنغلاديش' },
    { code: 'BB', name: 'Barbados / بربادوس' },
    { code: 'BY', name: 'Belarus / بيلاروسيا' },
    { code: 'BE', name: 'Belgium / بلجيكا' },
    { code: 'BZ', name: 'Belize / بليز' },
    { code: 'BJ', name: 'Benin / بنين' },
    { code: 'BT', name: 'Bhutan / بوتان' },
    { code: 'BO', name: 'Bolivia / بوليفيا' },
    { code: 'BA', name: 'Bosnia and Herzegovina / البوسنة والهرسك' },
    { code: 'BW', name: 'Botswana / بوتسوانا' },
    { code: 'BR', name: 'Brazil / البرازيل' },
    { code: 'BN', name: 'Brunei / بروناي' },
    { code: 'BG', name: 'Bulgaria / بلغاريا' },
    { code: 'BF', name: 'Burkina Faso / بوركينا فاسو' },
    { code: 'BI', name: 'Burundi / بوروندي' },
    { code: 'CV', name: 'Cabo Verde / الرأس الأخضر' },
    { code: 'KH', name: 'Cambodia / كمبوديا' },
    { code: 'CM', name: 'Cameroon / الكاميرون' },
    { code: 'CA', name: 'Canada / كندا' },
    { code: 'CF', name: 'Central African Republic / جمهورية أفريقيا الوسطى' },
    { code: 'TD', name: 'Chad / تشاد' },
    { code: 'CL', name: 'Chile / تشيلي' },
    { code: 'CN', name: 'China / الصين' },
    { code: 'CO', name: 'Colombia / كولومبيا' },
    { code: 'KM', name: 'Comoros / جزر القمر' },
    { code: 'CG', name: 'Congo / الكونغو' },
    { code: 'CR', name: 'Costa Rica / كوستاريكا' },
    { code: 'HR', name: 'Croatia / كرواتيا' },
    { code: 'CU', name: 'Cuba / كوبا' },
    { code: 'CY', name: 'Cyprus / قبرص' },
    { code: 'CZ', name: 'Czech Republic / التشيك' },
    { code: 'DK', name: 'Denmark / الدنمارك' },
    { code: 'DJ', name: 'Djibouti / جيبوتي' },
    { code: 'DM', name: 'Dominica / دومينيكا' },
    { code: 'DO', name: 'Dominican Republic / جمهورية الدومينيكان' },
    { code: 'EC', name: 'Ecuador / الإكوادور' },
    { code: 'EG', name: 'Egypt / مصر' },
    { code: 'SV', name: 'El Salvador / السلفادور' },
    { code: 'GQ', name: 'Equatorial Guinea / غينيا الاستوائية' },
    { code: 'ER', name: 'Eritrea / إريتريا' },
    { code: 'EE', name: 'Estonia / إستونيا' },
    { code: 'SZ', name: 'Eswatini / إسواتيني' },
    { code: 'ET', name: 'Ethiopia / إثيوبيا' },
    { code: 'FJ', name: 'Fiji / فيجي' },
    { code: 'FI', name: 'Finland / فنلندا' },
    { code: 'FR', name: 'France / فرنسا' },
    { code: 'GA', name: 'Gabon / الغابون' },
    { code: 'GM', name: 'Gambia / غامبيا' },
    { code: 'GE', name: 'Georgia / جورجيا' },
    { code: 'DE', name: 'Germany / ألمانيا' },
    { code: 'GH', name: 'Ghana / غانا' },
    { code: 'GR', name: 'Greece / اليونان' },
    { code: 'GD', name: 'Grenada / غرينادا' },
    { code: 'GT', name: 'Guatemala / غواتيمالا' },
    { code: 'GN', name: 'Guinea / غينيا' },
    { code: 'GW', name: 'Guinea-Bissau / غينيا بيساو' },
    { code: 'GY', name: 'Guyana / غيانا' },
    { code: 'HT', name: 'Haiti / هايتي' },
    { code: 'HN', name: 'Honduras / هندوراس' },
    { code: 'HU', name: 'Hungary / المجر' },
    { code: 'IS', name: 'Iceland / آيسلندا' },
    { code: 'IN', name: 'India / الهند' },
    { code: 'ID', name: 'Indonesia / إندونيسيا' },
    { code: 'IR', name: 'Iran / إيران' },
    { code: 'IQ', name: 'Iraq / العراق' },
    { code: 'IE', name: 'Ireland / أيرلندا' },
    { code: 'IL', name: 'Israel / إسرائيل' },
    { code: 'IT', name: 'Italy / إيطاليا' },
    { code: 'JM', name: 'Jamaica / جامايكا' },
    { code: 'JP', name: 'Japan / اليابان' },
    { code: 'JO', name: 'Jordan / الأردن' },
    { code: 'KZ', name: 'Kazakhstan / كازاخستان' },
    { code: 'KE', name: 'Kenya / كينيا' },
    { code: 'KI', name: 'Kiribati / كيريباتي' },
    { code: 'KW', name: 'Kuwait / الكويت' },
    { code: 'KG', name: 'Kyrgyzstan / قيرغيزستان' },
    { code: 'LA', name: 'Laos / لاوس' },
    { code: 'LV', name: 'Latvia / لاتفيا' },
    { code: 'LB', name: 'Lebanon / لبنان' },
    { code: 'LS', name: 'Lesotho / ليسوتو' },
    { code: 'LR', name: 'Liberia / ليبيريا' },
    { code: 'LY', name: 'Libya / ليبيا' },
    { code: 'LI', name: 'Liechtenstein / ليختنشتاين' },
    { code: 'LT', name: 'Lithuania / ليتوانيا' },
    { code: 'LU', name: 'Luxembourg / لوكسمبورغ' },
    { code: 'MG', name: 'Madagascar / مدغشقر' },
    { code: 'MW', name: 'Malawi / مالاوي' },
    { code: 'MY', name: 'Malaysia / ماليزيا' },
    { code: 'MV', name: 'Maldives / المالديف' },
    { code: 'ML', name: 'Mali / مالي' },
    { code: 'MT', name: 'Malta / مالطا' },
    { code: 'MH', name: 'Marshall Islands / جزر مارشال' },
    { code: 'MR', name: 'Mauritania / موريتانيا' },
    { code: 'MU', name: 'Mauritius / موريشيوس' },
    { code: 'MX', name: 'Mexico / المكسيك' },
    { code: 'FM', name: 'Micronesia / ميكرونيزيا' },
    { code: 'MD', name: 'Moldova / مولدوفا' },
    { code: 'MC', name: 'Monaco / موناكو' },
    { code: 'MN', name: 'Mongolia / منغوليا' },
    { code: 'ME', name: 'Montenegro / الجبل الأسود' },
    { code: 'MA', name: 'Morocco / المغرب' },
    { code: 'MZ', name: 'Mozambique / موزمبيق' },
    { code: 'MM', name: 'Myanmar / ميانمار' },
    { code: 'NA', name: 'Namibia / ناميبيا' },
    { code: 'NR', name: 'Nauru / ناورو' },
    { code: 'NP', name: 'Nepal / نيبال' },
    { code: 'NL', name: 'Netherlands / هولندا' },
    { code: 'NZ', name: 'New Zealand / نيوزيلندا' },
    { code: 'NI', name: 'Nicaragua / نيكاراغوا' },
    { code: 'NE', name: 'Niger / النيجر' },
    { code: 'NG', name: 'Nigeria / نيجيريا' },
    { code: 'NO', name: 'Norway / النرويج' },
    { code: 'OM', name: 'Oman / عُمان' },
    { code: 'PK', name: 'Pakistan / باكستان' },
    { code: 'PW', name: 'Palau / بالاو' },
    { code: 'PA', name: 'Panama / بنما' },
    { code: 'PG', name: 'Papua New Guinea / بابوا غينيا الجديدة' },
    { code: 'PY', name: 'Paraguay / باراغواي' },
    { code: 'PE', name: 'Peru / بيرو' },
    { code: 'PH', name: 'Philippines / الفلبين' },
    { code: 'PL', name: 'Poland / بولندا' },
    { code: 'PT', name: 'Portugal / البرتغال' },
    { code: 'QA', name: 'Qatar / قطر' },
    { code: 'RO', name: 'Romania / رومانيا' },
    { code: 'RU', name: 'Russia / روسيا' },
    { code: 'RW', name: 'Rwanda / رواندا' },
    { code: 'KN', name: 'Saint Kitts and Nevis / سانت كيتس ونيفيس' },
    { code: 'LC', name: 'Saint Lucia / سانت لوسيا' },
    { code: 'VC', name: 'Saint Vincent and the Grenadines / سانت فنسنت' },
    { code: 'WS', name: 'Samoa / ساموا' },
    { code: 'SM', name: 'San Marino / سان مارينو' },
    { code: 'ST', name: 'Sao Tome and Principe / ساو تومي وبرينسيبي' },
    { code: 'SA', name: 'Saudi Arabia / المملكة العربية السعودية' },
    { code: 'SN', name: 'Senegal / السنغال' },
    { code: 'RS', name: 'Serbia / صربيا' },
    { code: 'SC', name: 'Seychelles / سيشل' },
    { code: 'SL', name: 'Sierra Leone / سيراليون' },
    { code: 'SG', name: 'Singapore / سنغافورة' },
    { code: 'SK', name: 'Slovakia / سلوفاكيا' },
    { code: 'SI', name: 'Slovenia / سلوفينيا' },
    { code: 'SB', name: 'Solomon Islands / جزر سليمان' },
    { code: 'SO', name: 'Somalia / الصومال' },
    { code: 'ZA', name: 'South Africa / جنوب أفريقيا' },
    { code: 'SS', name: 'South Sudan / جنوب السودان' },
    { code: 'ES', name: 'Spain / إسبانيا' },
    { code: 'LK', name: 'Sri Lanka / سريلانكا' },
    { code: 'SD', name: 'Sudan / السودان' },
    { code: 'SR', name: 'Suriname / سورينام' },
    { code: 'SE', name: 'Sweden / السويد' },
    { code: 'CH', name: 'Switzerland / سويسرا' },
    { code: 'SY', name: 'Syria / سوريا' },
    { code: 'TW', name: 'Taiwan / تايوان' },
    { code: 'TJ', name: 'Tajikistan / طاجيكستان' },
    { code: 'TZ', name: 'Tanzania / تنزانيا' },
    { code: 'TH', name: 'Thailand / تايلاند' },
    { code: 'TL', name: 'Timor-Leste / تيمور الشرقية' },
    { code: 'TG', name: 'Togo / توغو' },
    { code: 'TO', name: 'Tonga / تونغا' },
    { code: 'TT', name: 'Trinidad and Tobago / ترينيداد وتوباغو' },
    { code: 'TN', name: 'Tunisia / تونس' },
    { code: 'TR', name: 'Turkey / تركيا' },
    { code: 'TM', name: 'Turkmenistan / تركمانستان' },
    { code: 'TV', name: 'Tuvalu / توفالو' },
    { code: 'UG', name: 'Uganda / أوغندا' },
    { code: 'UA', name: 'Ukraine / أوكرانيا' },
    { code: 'AE', name: 'United Arab Emirates / الإمارات العربية المتحدة' },
    { code: 'GB', name: 'United Kingdom / المملكة المتحدة' },
    { code: 'US', name: 'United States / الولايات المتحدة' },
    { code: 'UY', name: 'Uruguay / أوروغواي' },
    { code: 'UZ', name: 'Uzbekistan / أوزبكستان' },
    { code: 'VU', name: 'Vanuatu / فانواتو' },
    { code: 'VE', name: 'Venezuela / فنزويلا' },
    { code: 'VN', name: 'Vietnam / فيتنام' },
    { code: 'YE', name: 'Yemen / اليمن' },
    { code: 'ZM', name: 'Zambia / زامبيا' },
    { code: 'ZW', name: 'Zimbabwe / زيمبابوي' }
];

// ========================
// phone prefix → country code
// ========================
const PHONE_PREFIXES = [
    { prefix: '+20',   code: 'EG' },  // مصر
    { prefix: '+966',  code: 'SA' },  // السعودية
    { prefix: '+971',  code: 'AE' },  // الإمارات
    { prefix: '+965',  code: 'KW' },  // الكويت
    { prefix: '+974',  code: 'QA' },  // قطر
    { prefix: '+973',  code: 'BH' },  // البحرين
    { prefix: '+968',  code: 'OM' },  // عُمان
    { prefix: '+967',  code: 'YE' },  // اليمن
    { prefix: '+962',  code: 'JO' },  // الأردن
    { prefix: '+961',  code: 'LB' },  // لبنان
    { prefix: '+963',  code: 'SY' },  // سوريا
    { prefix: '+964',  code: 'IQ' },  // العراق
    { prefix: '+970',  code: 'PS' },  // فلسطين
    { prefix: '+216',  code: 'TN' },  // تونس
    { prefix: '+213',  code: 'DZ' },  // الجزائر
    { prefix: '+212',  code: 'MA' },  // المغرب
    { prefix: '+218',  code: 'LY' },  // ليبيا
    { prefix: '+249',  code: 'SD' },  // السودان
    { prefix: '+252',  code: 'SO' },  // الصومال
    { prefix: '+253',  code: 'DJ' },  // جيبوتي
    { prefix: '+269',  code: 'KM' },  // جزر القمر
    { prefix: '+222',  code: 'MR' },  // موريتانيا
    { prefix: '+1',    code: 'US' },  // الولايات المتحدة
    { prefix: '+44',   code: 'GB' },  // المملكة المتحدة
    { prefix: '+49',   code: 'DE' },  // ألمانيا
    { prefix: '+33',   code: 'FR' },  // فرنسا
    { prefix: '+39',   code: 'IT' },  // إيطاليا
    { prefix: '+34',   code: 'ES' },  // إسبانيا
    { prefix: '+31',   code: 'NL' },  // هولندا
    { prefix: '+32',   code: 'BE' },  // بلجيكا
    { prefix: '+41',   code: 'CH' },  // سويسرا
    { prefix: '+43',   code: 'AT' },  // النمسا
    { prefix: '+46',   code: 'SE' },  // السويد
    { prefix: '+47',   code: 'NO' },  // النرويج
    { prefix: '+45',   code: 'DK' },  // الدنمارك
    { prefix: '+358',  code: 'FI' },  // فنلندا
    { prefix: '+48',   code: 'PL' },  // بولندا
    { prefix: '+7',    code: 'RU' },  // روسيا
    { prefix: '+380',  code: 'UA' },  // أوكرانيا
    { prefix: '+90',   code: 'TR' },  // تركيا
    { prefix: '+30',   code: 'GR' },  // اليونان
    { prefix: '+40',   code: 'RO' },  // رومانيا
    { prefix: '+36',   code: 'HU' },  // المجر
    { prefix: '+420',  code: 'CZ' },  // التشيك
    { prefix: '+91',   code: 'IN' },  // الهند
    { prefix: '+92',   code: 'PK' },  // باكستان
    { prefix: '+880',  code: 'BD' },  // بنغلاديش
    { prefix: '+94',   code: 'LK' },  // سريلانكا
    { prefix: '+977',  code: 'NP' },  // نيبال
    { prefix: '+98',   code: 'IR' },  // إيران
    { prefix: '+93',   code: 'AF' },  // أفغانستان
    { prefix: '+86',   code: 'CN' },  // الصين
    { prefix: '+81',   code: 'JP' },  // اليابان
    { prefix: '+82',   code: 'KR' },  // كوريا الجنوبية
    { prefix: '+84',   code: 'VN' },  // فيتنام
    { prefix: '+66',   code: 'TH' },  // تايلاند
    { prefix: '+60',   code: 'MY' },  // ماليزيا
    { prefix: '+65',   code: 'SG' },  // سنغافورة
    { prefix: '+62',   code: 'ID' },  // إندونيسيا
    { prefix: '+63',   code: 'PH' },  // الفلبين
    { prefix: '+61',   code: 'AU' },  // أستراليا
    { prefix: '+64',   code: 'NZ' },  // نيوزيلندا
    { prefix: '+55',   code: 'BR' },  // البرازيل
    { prefix: '+54',   code: 'AR' },  // الأرجنتين
    { prefix: '+52',   code: 'MX' },  // المكسيك
    { prefix: '+57',   code: 'CO' },  // كولومبيا
    { prefix: '+56',   code: 'CL' },  // تشيلي
    { prefix: '+51',   code: 'PE' },  // بيرو
    { prefix: '+58',   code: 'VE' },  // فنزويلا
    { prefix: '+234',  code: 'NG' },  // نيجيريا
    { prefix: '+254',  code: 'KE' },  // كينيا
    { prefix: '+255',  code: 'TZ' },  // تنزانيا
    { prefix: '+256',  code: 'UG' },  // أوغندا
    { prefix: '+251',  code: 'ET' },  // إثيوبيا
    { prefix: '+27',   code: 'ZA' },  // جنوب أفريقيا
    { prefix: '+233',  code: 'GH' },  // غانا
    { prefix: '+237',  code: 'CM' },  // الكاميرون
];

// تحديد الدولة من رقم الهاتف (يدعم + و 00)
function getCountryFromPhone(phoneInput) {
    if (!phoneInput) return null;

    // نظّف الرقم
    let phone = phoneInput.trim().replace(/[\s\-\(\)]/g, '');

    // حوّل 00 لـ +
    if (phone.startsWith('00')) phone = '+' + phone.slice(2);

    // لازم يبدأ بـ +
    if (!phone.startsWith('+')) return null;

    // نرتب الـ prefixes من الأطول للأقصر عشان نمنع التعارض (+1 vs +1xxx)
    const sorted = [...PHONE_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);

    for (const entry of sorted) {
        if (phone.startsWith(entry.prefix)) {
            return entry.code;
        }
    }
    return null;
}

// تحويل coordinates لكود دولة عبر Nominatim (مجاني، بدون API key)
async function getCountryFromCoords(latitude, longitude) {
    return new Promise((resolve) => {
        const https = require('https');
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=3`;
        const options = {
            hostname: 'nominatim.openstreetmap.org',
            path: `/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=3`,
            method: 'GET',
            headers: {
                'User-Agent': 'EarnMoneyBot/1.0',
                'Accept-Language': 'en'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const code = json.address?.country_code?.toUpperCase() || null;
                    resolve(code);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

function formatBalance(amount, currency = 'EGP') {
    const numAmount = parseFloat(amount) || 0;
    if (currency === 'USD') {
        return `$${numAmount.toFixed(2)}`;
    } else {
        return `${numAmount.toFixed(2)} جنيه`;
    }
}

// Cache for user languages to reduce database calls
const userLanguageCache = new Map();
const CACHE_EXPIRY = 10 * 60 * 1000; // 10 minutes

async function getUserLanguage(userId) {
    try {
        // Check cache first
        const cached = userLanguageCache.get(userId);
        if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
            return cached.language;
        }

        const user = await db.getUser(userId);
        const language = user?.preferred_language || config.DEFAULT_LANGUAGE;

        // Cache the result
        userLanguageCache.set(userId, {
            language,
            timestamp: Date.now()
        });

        return language;
    } catch (error) {
        console.error('Error getting user language:', error);
        return config.DEFAULT_LANGUAGE;
    }
}

function getMessage(key, language = 'ar') {
    return config.MESSAGES[language]?.[key] || config.MESSAGES.ar[key] || key;
}

async function convertEGPToUSD(egpAmount) {
    const rate = await db.getSetting('usd_to_egp_rate') || config.USD_TO_EGP_RATE;
    return egpAmount / parseFloat(rate);
}

async function convertUSDToEGP(usdAmount) {
    const rate = await db.getSetting('usd_to_egp_rate') || config.USD_TO_EGP_RATE;
    return usdAmount * parseFloat(rate);
}

// Referral system functions
async function handleReferralCode(userId, referralCode) {
    try {
        // Find the referrer by referral code
        const referrer = await db.getUserByReferralCode(referralCode);
        
        if (referrer && referrer.id !== userId) {
            // Set the referral relationship
            await db.setUserReferredBy(userId, referrer.id);
            await db.addReferral(referrer.id, userId, referralCode);
            
            console.log(`User ${userId} referred by ${referrer.id} with code ${referralCode}`);
        }
    } catch (error) {
        console.error('Error handling referral code:', error);
    }
}

async function processReferralReward(userId) {
    try {
        // Check if this user was referred by someone
        const referral = await db.getReferralByReferredId(userId);
        
        if (referral && referral.status === 'pending') {
            const referrer = await db.getUser(referral.referrer_id);
            
            if (referrer) {
                // Get base reward in EGP
                const baseRewardEGP = parseFloat(await db.getSetting('referral_reward_egp') || config.REFERRAL_REWARD_EGP);
                
                // Determine reward amount based on referrer's currency
                let rewardAmount;
                let currency = referrer.preferred_currency || 'EGP';
                
                if (currency === 'USD') {
                    // Calculate USD reward based on current exchange rate
                    rewardAmount = await convertEGPToUSD(baseRewardEGP);
                    // Update referrer's USD balance
                    const newBalance = (parseFloat(referrer.balance_usd) || 0) + rewardAmount;
                    await db.setUserUSDBalance(referrer.id, newBalance);
                } else {
                    // Use EGP reward directly
                    rewardAmount = baseRewardEGP;
                    // Update referrer's EGP balance
                    const newBalance = (parseFloat(referrer.balance) || 0) + rewardAmount;
                    await db.setUserBalance(referrer.id, newBalance);
                }
                
                // Update referral record
                await db.updateReferralReward(referral.id, rewardAmount, currency);
                
                // Send notification to referrer
                const language = await getUserLanguage(referrer.id);
                const formattedAmount = formatBalance(rewardAmount, currency);
                const message = getMessage('REFERRAL_REWARD_EARNED', language)
                    .replace('{amount}', formattedAmount);
                
                await safeSendMessage(referrer.id, message);
                
                console.log(`Referral reward of ${rewardAmount} ${currency} sent to user ${referrer.id}`);
            }
        }
    } catch (error) {
        console.error('Error processing referral reward:', error);
    }
}

// Process per-email referral reward (called every time a referred user completes an email task)
async function processPerEmailReferralReward(userId) {
    try {
        // Check if this user was referred by someone
        const referral = await db.getReferralByReferredId(userId);
        
        if (referral) {
            const referrer = await db.getUser(referral.referrer_id);
            
            if (referrer) {
                // Get base reward in EGP
                const baseRewardEGP = parseFloat(await db.getSetting('referral_per_email_reward_egp') || config.REFERRAL_PER_EMAIL_REWARD_EGP);
                
                // Determine reward amount based on referrer's currency
                let rewardAmount;
                let currency = referrer.preferred_currency || 'EGP';
                
                if (currency === 'USD') {
                    // Calculate USD reward based on current exchange rate
                    rewardAmount = await convertEGPToUSD(baseRewardEGP);
                    // Update referrer's USD balance
                    const newBalance = (parseFloat(referrer.balance_usd) || 0) + rewardAmount;
                    await db.setUserUSDBalance(referrer.id, newBalance);
                } else {
                    // Use EGP reward directly
                    rewardAmount = baseRewardEGP;
                    // Update referrer's EGP balance
                    const newBalance = (parseFloat(referrer.balance) || 0) + rewardAmount;
                    await db.setUserBalance(referrer.id, newBalance);
                }
                
                // Send notification to referrer
                const language = await getUserLanguage(referrer.id);
                const formattedAmount = formatBalance(rewardAmount, currency);
                const message = language === 'en' ?
                    `💰 You earned ${formattedAmount} because your friend completed an email task!` :
                    `💰 حصلت على ${formattedAmount} لأن صديقك أكمل مهمة إيميل!`;
                
                await safeSendMessage(referrer.id, message);
                
                console.log(`Per-email referral reward of ${rewardAmount} ${currency} sent to user ${referrer.id}`);
            }
        }
    } catch (error) {
        console.error('Error processing per-email referral reward:', error);
    }
}

async function showReferralMenu(chatId, userId, language) {
    try {
        const keyboard = keyboards.getKeyboard('referralMenu', language);
        const message = language === 'en' ?
            '🔗 Referral System\n\nInvite friends and earn rewards!' :
            '🔗 نظام الإحالة\n\nادع أصدقائك واحصل على مكافآت!';
        
        bot.sendMessage(chatId, message, keyboard);
    } catch (error) {
        console.error('Error showing referral menu:', error);
    }
}

async function showReferralCode(chatId, userId, language) {
    try {
        const user = await db.getUser(userId);
        
        // Check if user exists
        if (!user) {
            const errorMessage = language === 'en' ? 
                '❌ User not found. Please use /start first' : 
                '❌ المستخدم غير موجود. استخدم /start أولاً';
            return bot.sendMessage(chatId, errorMessage);
        }
        
        let referralCode = user.referral_code;
        
        // Generate code if doesn't exist
        if (!referralCode) {
            referralCode = await db.generateReferralCode(userId);
        }
        
        // Use bot username from config for creating the link
        const botUsername = config.BOT_USERNAME;
        
        // Create clickable Telegram link
        const telegramLink = `https://t.me/${botUsername}?start=${referralCode}`;
        
        // Determine reward amount based on user's currency
        const currency = user.preferred_currency || 'EGP';
        
        // Get base rewards in EGP
        const baseRewardEGP = parseFloat(await db.getSetting('referral_reward_egp') || config.REFERRAL_REWARD_EGP);
        const perEmailRewardEGP = parseFloat(await db.getSetting('referral_per_email_reward_egp') || config.REFERRAL_PER_EMAIL_REWARD_EGP);
        
        // Calculate rewards based on user's currency
        let rewardAmount, perEmailReward;
        if (currency === 'USD') {
            // Convert to USD using current exchange rate
            const rewardUSD = await convertEGPToUSD(baseRewardEGP);
            const perEmailUSD = await convertEGPToUSD(perEmailRewardEGP);
            rewardAmount = formatBalance(rewardUSD, 'USD');
            perEmailReward = formatBalance(perEmailUSD, 'USD');
        } else {
            // Use EGP directly
            rewardAmount = formatBalance(baseRewardEGP, 'EGP');
            perEmailReward = formatBalance(perEmailRewardEGP, 'EGP');
        }
        
        // Create message with clickable link
        const message = language === 'en' ? 
            `🔗 *Your Referral Link:*\n\n\`${telegramLink}\`\n\n📋 Copy this link and share it with your friends\n💰 You will earn ${rewardAmount} when your friend completes one task and gets admin approval\n💎 Plus ${perEmailReward} for every email they create!\n\n🎯 *Your Referral Code:* ${referralCode}\n\n👆 Click the link above to test it!` :
            `🔗 *رابط الإحالة الخاص بك:*\n\n\`${telegramLink}\`\n\n📋 انسخ هذا الرابط وشاركه مع أصدقائك\n💰 ستحصل على ${rewardAmount} عندما يكمل صديقك مهمة واحدة ويحصل على موافقة الأدمن\n💎 بالإضافة إلى ${perEmailReward} على كل إيميل ينشئه!\n\n🎯 *كود الإحالة:* ${referralCode}\n\n👆 اضغط على الرابط أعلاه لتجربته!`;
        
        // Create inline keyboard with share button
        const shareText = language === 'en' ? 
            `🎉 Join me on this amazing earning bot! Use my referral link to start earning money: ${telegramLink}` :
            `🎉 انضم إلي في هذا البوت الرائع للربح! استخدم رابط الإحالة الخاص بي لتبدأ ربح المال: ${telegramLink}`;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '📤 Share Link' : '📤 مشاركة الرابط',
                            url: `https://t.me/share/url?url=${encodeURIComponent(telegramLink)}&text=${encodeURIComponent(shareText)}`
                        }
                    ]
                ]
            }
        };

        bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
            ...keyboard
        });
    } catch (error) {
        console.error('Error showing referral code:', error);
        const errorMessage = language === 'en' ? 
            '❌ Error generating referral code' : 
            '❌ خطأ في إنشاء كود الإحالة';
        bot.sendMessage(chatId, errorMessage);
    }
}

async function showReferralStats(chatId, userId, language) {
    try {
        const user = await db.getUser(userId);
        const stats = await db.getReferralStats(userId);
        const referralCode = user.referral_code || 'غير متوفر';
        
        const currency = user.preferred_currency || 'EGP';
        const totalEarned = formatBalance(stats.total_earned || 0, currency);
        
        const message = getMessage('REFERRAL_STATS', language)
            .replace('{total}', stats.total_referrals || 0)
            .replace('{completed}', stats.completed_referrals || 0)
            .replace('{earned}', totalEarned)
            .replace('{code}', referralCode);
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error showing referral stats:', error);
        const errorMessage = language === 'en' ? 
            '❌ Error loading referral statistics' : 
            '❌ خطأ في تحميل إحصائيات الإحالة';
        bot.sendMessage(chatId, errorMessage);
    }
}

async function showReferralList(chatId, userId, language) {
    try {
        const referrals = await db.getUserReferrals(userId);
        
        if (referrals.length === 0) {
            const message = language === 'en' ? 
                '👥 No referrals yet\n\nShare your referral code to start earning!' : 
                '👥 لا توجد إحالات بعد\n\nشارك كود الإحالة الخاص بك لتبدأ الربح!';
            bot.sendMessage(chatId, message);
            return;
        }
        
        let message = language === 'en' ? '👥 Your Referrals:\n\n' : '👥 إحالاتك:\n\n';
        
        referrals.forEach((referral, index) => {
            const status = referral.status === 'completed' ? '✅' : '⏳';
            const username = referral.referred_username || 'مستخدم';
            const reward = referral.status === 'completed' ? 
                formatBalance(referral.reward_earned, referral.reward_currency) : 
                (language === 'en' ? 'Pending' : 'في الانتظار');
            
            message += `${index + 1}. ${status} ${username} - ${reward}\n`;
        });
        
        bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error showing referral list:', error);
        const errorMessage = language === 'en' ? 
            '❌ Error loading referral list' : 
            '❌ خطأ في تحميل قائمة الإحالات';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Auto-register user if not exists (called before any message/callback processing)
async function ensureUser(userId, from) {
    try {
        const user = await db.getUser(userId);
        if (!user) {
            const username = from?.username || from?.first_name || 'Unknown';
            await db.addUser(userId, username);
        }
    } catch (err) {
        console.error('ensureUser error:', err.message);
    }
}

// طلب التحقق من الدولة - يدعم طريقتين حسب إعداد الأدمن
async function askForCountryVerification(chatId, language) {
    const method = await db.getSetting('country_verification_method') || 'location';

    if (method === 'phone') {
        const message = language === 'en'
            ? '📱 Welcome! To get started, please share your phone number so we can record your country.\n\n💡 Press the button below to share your contact.\n\n⚠️ Required once only.'
            : '📱 أهلاً! للبدء، يرجى مشاركة رقم هاتفك حتى نتمكن من تسجيل دولتك.\n\n💡 اضغط الزر أدناه لمشاركة جهة اتصالك.\n\n⚠️ مطلوب مرة واحدة فقط.';

        const keyboard = {
            reply_markup: {
                keyboard: [
                    [{ text: language === 'en' ? '📱 Share Phone Number' : '📱 مشاركة رقم الهاتف', request_contact: true }],
                    [{ text: language === 'en' ? '❌ Cancel' : '❌ إلغاء' }]
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        };
        await bot.sendMessage(chatId, message, keyboard);
    } else {
        // location (default)
        const message = language === 'en'
            ? '📍 Welcome! To get started, please share your location so we can record your country.\n\n💡 Press the button below to share your location.\n\n📱 *If the button doesn\'t work:* Open this bot on your *phone* and press the location button there.\n\n✅ *Make sure Location Services are enabled on your phone.*\n\n⚠️ This is required once only.'
            : '📍 أهلاً! للبدء، يرجى مشاركة موقعك حتى نتمكن من تسجيل دولتك.\n\n💡 اضغط على الزر أدناه لمشاركة موقعك.\n\n📱 *لو الزرار مش شغال:* افتح البوت من *الهاتف* واضغط الزرار من هناك.\n\n✅ *تأكد أن خدمة الموقع (Location) مفعّلة على هاتفك.*\n\n⚠️ هذا مطلوب مرة واحدة فقط.';

        const keyboard = {
            reply_markup: {
                keyboard: [
                    [{ text: language === 'en' ? '📍 Share Location' : '📍 مشاركة الموقع', request_location: true }]
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        };
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
    }
}

// Check if user is subscribed to the required channel
const REQUIRED_CHANNEL = '@easycashdisscusion';

async function isSubscribedToChannel(userId) {
    try {
        const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch {
        return false;
    }
}

function sendJoinChannelMessage(chatId, language) {
    const message = language === 'en'
        ? '📢 To use the bot, you must join our official channel first:\n\n🔔 Join the channel then press the button below to continue.'
        : '📢 لاستخدام البوت يجب الاشتراك في قناتنا الرسمية أولاً:\n\n🔔 اشترك في القناة ثم اضغط الزر أدناه للمتابعة.';

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: language === 'en' ? '📢 Join Channel' : '📢 اشترك في القناة', url: 'https://t.me/easycashdisscusion' }],
                [{ text: language === 'en' ? '✅ I Joined' : '✅ اشتركت', callback_data: 'check_subscription' }]
            ]
        }
    };
    bot.sendMessage(chatId, message, keyboard);
}

// Start command with referral support
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const username = msg.from.username || msg.from.first_name;
    const referralCode = match[1] ? match[1].trim() : null;

    try {
        // Check if user already exists
        const existingUser = await db.getUser(userId);
        
        if (!existingUser) {
            // New user - add to database
            await db.addUser(userId, username);
            
            // Handle referral if code provided
            if (referralCode) {
                await handleReferralCode(userId, referralCode);
            }
            
            // Generate referral code for new user
            await db.generateReferralCode(userId);
        } else {
            // Existing user - check if they have a referral code
            if (!existingUser.referral_code) {
                await db.generateReferralCode(userId);
            }
        }

        if (await isAdmin(userId)) {
            const language = await getUserLanguage(userId);
            const isMain = await isMainAdmin(userId);
            const keyboardType = isMain ? 'mainAdminKeyboard' : 'adminKeyboard';
            const keyboard = keyboards.getKeyboard(keyboardType, language);
            
            // Initialize main admin in database
            if (isMain) {
                await db.initMainAdmin(userId);
            }
            
            bot.sendMessage(chatId, getMessage('ADMIN_WELCOME', language), keyboard);
        } else {
            // Check if user has selected a language
            const user = await db.getUser(userId);
            if (!user || !user.preferred_language) {
                // User hasn't selected language yet - ask for it
                bot.sendMessage(chatId, getMessage('LANGUAGE_SELECTION'), keyboards.languageSelection);
            } else {
                // User has language - show main menu
                const language = await getUserLanguage(userId);
                const keyboard = keyboards.getKeyboard('userKeyboard', language);
                bot.sendMessage(chatId, getMessage('WELCOME', language), keyboard);
                bot.sendMessage(chatId, getMessage('CHOOSE_TASKS', language));
            }
        }
    } catch (error) {
        console.error('Error in start command:', error);
        bot.sendMessage(chatId, '❌ حدث خطأ، حاول مرة أخرى / Error occurred, try again');
    }
});

// High-performance message handler for millions of users
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    // Auto-register user if not exists
    await ensureUser(userId, msg.from);

    // Handle contact messages (phone number sharing)
    if (msg.contact) {
        const language = await getUserLanguage(userId);
        const currentState = userStates.get(userId);
        if (currentState === 'waiting_country_phone') {
            const phoneNumber = msg.contact.phone_number;
            // Telegram بيبعت الرقم بدون + أحياناً
            const normalizedPhone = phoneNumber.startsWith('+') ? phoneNumber : '+' + phoneNumber;
            await handlePhoneCountryVerification(chatId, userId, normalizedPhone, language);
        }
        return;
    }

    // Handle location messages
    if (msg.location) {
        const language = await getUserLanguage(userId);
        // لو الطريقة phone، تجاهل الموقع (المستخدم ممكن يبعت موقع بالغلط)
        const method = await db.getSetting('country_verification_method') || 'location';
        const currentState = userStates.get(userId);
        if (method === 'location' || currentState === 'waiting_country_location' || currentState === 'gmail_waiting_location') {
            await handleLocationMessage(chatId, userId, msg.location, language);
        }
        return;
    }

    // Early returns for performance
    if (!text || text.startsWith('/')) return;

    // Rate limiting check
    if (!checkRateLimit(userId)) {
        return; // Silently ignore rate-limited requests
    }

    // Process message asynchronously to not block other messages
    setImmediate(async () => {
        try {
            // Handle language selection FIRST before getting current language
            if (text === '🇸🇦 العربية' || text === '🇺🇸 English') {
                const selectedLanguage = text === '🇺🇸 English' ? 'en' : 'ar';
                await db.updateUserLanguage(userId, selectedLanguage);

                // Clear language cache for this user to force refresh
                userLanguageCache.delete(userId);

                // Send welcome message with the NEW language
                bot.sendMessage(chatId, getMessage('WELCOME', selectedLanguage));

                // Check channel subscription before showing currency selection
                const subscribed = await isSubscribedToChannel(userId);
                if (!subscribed) {
                    sendJoinChannelMessage(chatId, selectedLanguage);
                    return;
                }

                // Then ask for currency immediately with the NEW language
                const keyboard = keyboards.getKeyboard('currencySelection', selectedLanguage);
                bot.sendMessage(chatId, getMessage('CURRENCY_SELECTION', selectedLanguage), keyboard);
                return;
            }

            // Get language AFTER handling language selection
            const language = await getUserLanguage(userId);

            // Handle cancel commands
            if (text === '❌ إلغاء' || text === '❌ Cancel' || text === '/cancel') {
                userStates.delete(userId);
                const isAdminUser = await isAdmin(userId);
                const isMain = isAdminUser ? await isMainAdmin(userId) : false;
                const keyboardType = isMain ? 'mainAdminKeyboard' : (isAdminUser ? 'adminKeyboard' : 'userKeyboard');
                const keyboard = keyboards.getKeyboard(keyboardType, language);
                return bot.sendMessage(chatId, getMessage('OPERATION_CANCELLED', language), keyboard);
            }

            // Check if user is banned
            const user = await db.getUser(userId);
            if (user && user.is_banned) {
                return bot.sendMessage(chatId, getMessage('USER_BANNED', language));
            }

            // ── سؤال التحقق من الدولة للمستخدمين العاديين اللي مش عندهم دولة مسجلة ──
            if (!(await isAdmin(userId)) && user && !user.country_code) {
                const currentState = userStates.get(userId);
                if (currentState !== 'waiting_country_location' && currentState !== 'waiting_country_phone') {
                    const method = await db.getSetting('country_verification_method') || 'location';
                    const newState = method === 'phone' ? 'waiting_country_phone' : 'waiting_country_location';
                    userStates.set(userId, newState);
                    await askForCountryVerification(chatId, language);
                    return;
                }
            }

            // Handle conversation states
            const userState = userStates.get(userId);
            if (userState) {
                await handleUserState(chatId, userId, text, userState, language);
                return;
            }

            // Handle buttons
            if (await isAdmin(userId)) {
                await handleAdminButtons(chatId, userId, text, language);
            } else {
                await handleUserButtons(chatId, userId, text, language);
            }
        } catch (error) {
            console.error('Error in message handler:', error);
            bot.sendMessage(chatId, '❌ حدث خطأ، حاول مرة أخرى / Error occurred, try again');
        }
    });
});

// Random foreign name generator
const FIRST_NAMES = [
    'James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles',
    'Daniel','Matthew','Anthony','Donald','Mark','Paul','Steven','Andrew','Kenneth','George',
    'Emma','Olivia','Ava','Isabella','Sophia','Mia','Charlotte','Amelia','Harper','Evelyn',
    'Emily','Abigail','Elizabeth','Sofia','Ella','Madison','Scarlett','Victoria','Aria','Grace',
    'Liam','Noah','Oliver','Elijah','Lucas','Mason','Logan','Ethan','Aiden','Jackson',
    'Sebastian','Jack','Owen','Henry','Gabriel','Carter','Wyatt','Julian','Levi','Isaac',
    'Luna','Chloe','Penelope','Layla','Riley','Zoey','Nora','Lily','Eleanor','Hannah',
    'Lillian','Addison','Aubrey','Ellie','Stella','Natalie','Zoe','Leah','Hazel','Violet'
];

const LAST_NAMES = [
    'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Taylor',
    'Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Young','Allen','King',
    'Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker',
    'Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Gomez','Phillips','Evans','Turner',
    'Parker','Collins','Edwards','Stewart','Morris','Sanchez','Rogers','Reed','Cook','Bailey',
    'Bell','Murphy','Ward','Cox','Richardson','Howard','Ramirez','Watson','Brooks','Kelly',
    'Sanders','Price','Bennett','Wood','Barnes','Ross','Henderson','Coleman','Jenkins','Perry'
];

function getRandomName() {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    return { first, last };
}

// Handle user buttons
async function handleUserButtons(chatId, userId, text, language) {
    const user = await db.getUser(userId);

    switch (text) {
        case '📋 المهام':
        case '📋 Tasks':
            await showTasksMenu(chatId, userId, language);
            break;

        case '🎲 احصل على اسم':
        case '🎲 Get a Name': {
            const { first, last } = getRandomName();
            const message = language === 'en'
                ? `🎲 Your random name:\n\n👤 First Name: \`${first}\`\n👤 Last Name: \`${last}\`\n\n💡 Press the button again for a different name!`
                : `🎲 الاسم العشوائي:\n\n👤 الاسم الأول: \`${first}\`\n👤 الاسم الأخير: \`${last}\`\n\n💡 اضغط الزر مرة أخرى للحصول على اسم مختلف!`;
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            break;
        }

        default:
            // Handle dynamic task buttons with rewards
            if (text.startsWith('📧 مهمة إنشاء يوزرات') || text.startsWith('📧 Email Creation Task')) {
                const tasksEnabled = await db.getSetting('tasks_enabled') !== 'false';
                if (tasksEnabled) {
                    // Show warning first before assigning task
                    const warningMessage = language === 'en'
                        ? `⚠️ Important Warnings:\n\n1️⃣ Make sure to use the exact password provided\n2️⃣ Do NOT link the email to any phone number\n\nPress the button below to start the task:`
                        : `⚠️ تحذيرات مهمة:\n\n1️⃣ تأكد من استخدام كلمة المرور المحددة بالضبط\n2️⃣ لا تربط الإيميل برقم هاتف\n\nاضغط الزر أدناه لبدء المهمة:`;
                    const confirmKeyboard = {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: language === 'en' ? '✅ I Understand, Start Task' : '✅ فهمت، ابدأ المهمة', callback_data: 'start_email_task' }
                            ]]
                        }
                    };
                    bot.sendMessage(chatId, warningMessage, confirmKeyboard);
                } else {
                    const message = language === 'en' ?
                        '⏸️ Tasks are currently disabled\n\n📞 Contact admin for more information' :
                        '⏸️ المهام معطلة حالياً\n\n📞 تواصل مع الإدارة للمزيد من المعلومات';
                    bot.sendMessage(chatId, message);
                }
                break;
            }

            if (text.startsWith('📱 مهمة إنشاء جيميل') || text.startsWith('📱 Gmail Creation Task')) {
                const gmailTasksEnabled = await db.getSetting('gmail_tasks_enabled') !== 'false';
                if (gmailTasksEnabled) {
                    // تحقق من الدولة أولاً قبل رسالة التحذير
                    const userCountry = user?.country_code || null;
                    const allowedCountries = await db.getAllowedCountries();

                    if (!userCountry) {
                        // مفيش دولة - اطلب موقع
                        userStates.set(userId, 'waiting_country_location');
                        const msg = language === 'en'
                            ? '📍 Please share your location first so we can record your country.\n\n📱 Must be done from your *phone*\n✅ Make sure Location Services are enabled\n\n⚠️ Required once only.'
                            : '📍 يرجى مشاركة موقعك أولاً حتى نسجل دولتك.\n\n📱 يجب من *الهاتف* فقط\n✅ تأكد أن خدمة الموقع مفعّلة\n\n⚠️ مطلوب مرة واحدة فقط.';
                        const keyboard = {
                            reply_markup: {
                                keyboard: [
                                    [{ text: language === 'en' ? '📍 Share Location' : '📍 مشاركة الموقع', request_location: true }],
                                    [{ text: language === 'en' ? '❌ Cancel' : '❌ إلغاء' }]
                                ],
                                resize_keyboard: true,
                                one_time_keyboard: true
                            }
                        };
                        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...keyboard });
                        break;
                    }

                    if (allowedCountries.length === 0 || !allowedCountries.includes(userCountry)) {
                        // دولته مش مسموحة - رسالة بدون سبب
                        const message = language === 'en'
                            ? '⏸️ The admin is currently satisfied with existing emails.\n\nYou can do the Email Creation Task instead!'
                            : '⏸️ الأدمن مكتفي بالإيميلات الحالية.\n\nيمكنك القيام بمهمة إنشاء اليوزرات بدلاً من ذلك!';
                        bot.sendMessage(chatId, message);
                        break;
                    }

                    // الدولة مسموحة - اعرض التحذير وزرار التأكيد
                    const warningMessage = language === 'en'
                        ? `⚠️ Important Warnings:\n\n1️⃣ Make sure to use the exact password provided\n2️⃣ Do NOT link the email to any phone number\n\nPress the button below to start the task:`
                        : `⚠️ تحذيرات مهمة:\n\n1️⃣ تأكد من استخدام كلمة المرور المحددة بالضبط\n2️⃣ لا تربط الإيميل برقم هاتف\n\nاضغط الزر أدناه لبدء المهمة:`;
                    const confirmKeyboard = {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: language === 'en' ? '✅ I Understand, Start Task' : '✅ فهمت، ابدأ المهمة', callback_data: 'start_gmail_task' }
                            ]]
                        }
                    };
                    bot.sendMessage(chatId, warningMessage, confirmKeyboard);
                } else {
                    const message = language === 'en' ?
                        '⏸️ Gmail tasks are currently disabled\n\n📞 Contact admin for more information' :
                        '⏸️ مهام الجيميل معطلة حالياً\n\n📞 تواصل مع الإدارة للمزيد من المعلومات';
                    bot.sendMessage(chatId, message);
                }
                break;
            }

            // Show main menu for unrecognized commands
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            bot.sendMessage(chatId, getMessage('WELCOME', language), keyboard);
            break;

        case '💰 المحفظة':
        case '💰 Wallet':
            await showWallet(chatId, userId, language);
            break;

        case '⏳ الأموال المعلقة':
        case '⏳ Pending Funds':
            await showPendingFunds(chatId, userId, language, 1);
            break;

        case '💳 السحب':
        case '💳 Withdraw':
            await initiateWithdrawal(chatId, userId, language);
            break;

        case '🆔 عرض الآيدي':
        case '🆔 Show ID':
            const idMessage = language === 'en' ?
                `🆔 Your ID:\n\`${userId}\`` :
                `🆔 الآيدي الخاص بك:\n\`${userId}\``;
            bot.sendMessage(chatId, idMessage, { parse_mode: 'Markdown' });
            break;

        case '🔗 نظام الإحالة':
        case '🔗 Referral System':
            await showReferralMenu(chatId, userId, language);
            break;

        case '🔗 كود الإحالة':
        case '🔗 Referral Code':
            await showReferralCode(chatId, userId, language);
            break;

        case '📊 إحصائيات الإحالة':
        case '📊 Referral Stats':
            await showReferralStats(chatId, userId, language);
            break;

        case '👥 قائمة الإحالات':
        case '👥 Referral List':
            await showReferralList(chatId, userId, language);
            break;

        case '💱 تغيير العملة':
        case '💱 Change Currency':
            await showCurrencyChangeMenu(chatId, userId, language);
            break;

        case '🌍 تغيير اللغة':
        case '🌍 Change Language':
            bot.sendMessage(chatId, getMessage('LANGUAGE_SELECTION'), keyboards.languageSelection);
            break;

        case '💬 الدعم':
        case '💬 Support':
            const supportMessage = await db.getSetting('support_message') || getMessage('SUPPORT', language);
            bot.sendMessage(chatId, supportMessage);
            break;

        case '🔙 العودة للقائمة الرئيسية':
        case '🔙 Back to Main Menu':
            const mainKeyboard = keyboards.getKeyboard('userKeyboard', language);
            bot.sendMessage(chatId, getMessage('WELCOME', language), mainKeyboard);
            bot.sendMessage(chatId, getMessage('CHOOSE_TASKS', language));
            break;

        // Currency selection
        case '💵 الدولار الأمريكي':
        case '💵 US Dollar':
            // Get fresh language in case it was just updated
            const usdLanguage = await getUserLanguage(userId);
            await handleCurrencySelection(chatId, userId, 'USD', usdLanguage);
            break;

        case '💰 الجنيه المصري':
        case '💰 Egyptian Pound':
            // Get fresh language in case it was just updated
            const egpLanguage = await getUserLanguage(userId);
            await handleCurrencySelection(chatId, userId, 'EGP', egpLanguage);
            break;

        // Currency change
        case '💵 تغيير إلى الدولار':
        case '💵 Change to USD':
            await handleCurrencyChange(chatId, userId, 'USD', language);
            break;

        case '💰 تغيير إلى الجنيه':
        case '💰 Change to EGP':
            await handleCurrencyChange(chatId, userId, 'EGP', language);
            break;

        // Task confirmations
        case '✅ تم إنشاء اليوزر':
        case '✅ Account Created':
            await completeTask(chatId, userId, language);
            break;

        case '✅ متابعة':
        case '✅ Continue':
            await continueGmailTask(chatId, userId, language);
            break;

        case '❌ إلغاء المهمة':
        case '❌ Cancel Task':
            await cancelTask(chatId, userId, language);
            break;
    }
}

// Handle admin buttons (simplified version)
async function handleAdminButtons(chatId, userId, text, language) {
    switch (text) {
        // Main admin menu buttons
        case '👥 إدارة المستخدمين':
        case '👥 User Management':
            const userMgmtKeyboard = keyboards.getKeyboard('userManagement', language);
            const userMgmtMessage = language === 'en' ?
                '👥 User Management:' :
                '👥 إدارة المستخدمين:';
            bot.sendMessage(chatId, userMgmtMessage, userMgmtKeyboard);
            break;

        case '📊 الإحصائيات':
        case '📊 Statistics':
            await showStatistics(chatId, language);
            break;

        case '📧 اليوزرات المنشأة':
        case '📧 Created Accounts':
            if (await isMainAdmin(userId) || await db.getSetting('admins_email_review') === 'true') {
                await showPendingAccounts(chatId, language);
            } else {
                bot.sendMessage(chatId, language === 'en' ? '❌ You don\'t have permission to review emails' : '❌ ليس لديك صلاحية مراجعة الإيميلات');
            }
            break;

        case '📱 مراجعة الجيميلات':
        case '📱 Review Gmail':
            if (await isMainAdmin(userId) || await db.getSetting('admins_email_review') === 'true') {
                await showPendingGmailAccounts(chatId, language);
            } else {
                bot.sendMessage(chatId, language === 'en' ? '❌ You don\'t have permission to review emails' : '❌ ليس لديك صلاحية مراجعة الإيميلات');
            }
            break;

        case '💳 طلبات السحب':
        case '💳 Withdrawal Requests':
            if (await isMainAdmin(userId) || await db.getSetting('admins_withdrawal_access') === 'true') {
                await showPendingWithdrawalRequests(chatId, language, await isMainAdmin(userId));
            } else {
                bot.sendMessage(chatId, language === 'en' ? '❌ You don\'t have permission to access withdrawal requests' : '❌ ليس لديك صلاحية الوصول لطلبات السحب');
            }
            break;

        case '📨 إرسال رسالة':
        case '📨 Send Message':
            const messageKeyboard = keyboards.getKeyboard('messageKeyboard', language);
            const messageMenuMessage = language === 'en' ?
                '📨 Message Options:' :
                '📨 خيارات الرسائل:';
            bot.sendMessage(chatId, messageMenuMessage, messageKeyboard);
            break;

        case '⚙️ إعدادات النظام':
        case '⚙️ System Settings':
            const settingsKeyboard = keyboards.getKeyboard('settingsKeyboard', language);
            const settingsMessage = language === 'en' ?
                '⚙️ System Settings:' :
                '⚙️ إعدادات النظام:';
            bot.sendMessage(chatId, settingsMessage, settingsKeyboard);
            break;

        case '🎮 التحكم في المهام':
        case '🎮 Task Control':
            const taskControlKeyboard = keyboards.getKeyboard('taskControl', language);
            const taskControlMessage = language === 'en' ?
                '🎮 Task Control:\n\nChoose the task you want to control:' :
                '🎮 التحكم في المهام:\n\nاختر المهمة التي تريد التحكم بها:';
            bot.sendMessage(chatId, taskControlMessage, taskControlKeyboard);
            break;

        case '📧 مهمة إنشاء اليوزرات':
        case '📧 Email Creation Task':
            await toggleEmailTasks(chatId, language);
            break;

        case '📱 مهمة إنشاء الجيميل':
        case '📱 Gmail Creation Task':
            await toggleGmailTasks(chatId, language);
            break;

        case '🇪🇬 التحقق من IP المصري':
        case '🇪🇬 Egyptian IP Verification':
            await toggleEgyptianIPCheck(chatId, language);
            break;

        case '🌍 الدول المطلوبة':
        case '🌍 Allowed Countries':
            await showAllowedCountriesMenu(chatId, userId, language);
            break;

        case '🔄 طريقة التحقق من الدولة':
        case '🔄 Country Verification Method':
            await showVerificationMethodMenu(chatId, language);
            break;

        case '➕ إضافة يوزرات':
        case '➕ Add Accounts':
            userStates.set(userId, 'add_accounts');
            const addAccountsMessage = language === 'en' ?
                '➕ Send accounts in the following format:\n\n📧 Basic format:\nemail:password\n\n👤 With names (recommended):\nemail:password:firstname:lastname\n\n📝 Examples:\njohn@gmail.com:pass123:John:Smith\nmike@gmail.com:pass456:Mike:Johnson\n\n💡 Names will be used for Gmail account creation' :
                '➕ أرسل اليوزرات بالتنسيق التالي:\n\n📧 التنسيق الأساسي:\nemail:password\n\n👤 مع الأسماء (مُوصى به):\nemail:password:firstname:lastname\n\n📝 أمثلة:\njohn@gmail.com:pass123:John:Smith\nmike@gmail.com:pass456:Mike:Johnson\n\n💡 سيتم استخدام الأسماء لإنشاء حسابات الجيميل';
            const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, addAccountsMessage, cancelKeyboard);
            break;

        case '📦 اليوزرات المتاحة':
        case '📦 Available Accounts':
            await showAvailableAccounts(chatId, language);
            break;

        case '🧹 تنظيف اليوزرات المكررة':
        case '🧹 Clean Duplicate Accounts':
            await cleanDuplicateAccounts(chatId, language);
            break;

        case '📥 إدارة الإيميلات الجماعية':
        case '📥 Bulk Email Management':
            if (await isMainAdmin(userId) || await db.getSetting('admins_email_review') === 'true') {
                const bulkEmailKeyboard = keyboards.getKeyboard('bulkEmailManagement', language);
                const bulkEmailMessage = language === 'en' ?
                    '📥 Bulk Email Management\n\nChoose an action:' :
                    '📥 إدارة الإيميلات الجماعية\n\nاختر إجراء:';
                bot.sendMessage(chatId, bulkEmailMessage, bulkEmailKeyboard);
            } else {
                bot.sendMessage(chatId, language === 'en' ? '❌ You don\'t have permission to access email management' : '❌ ليس لديك صلاحية الوصول لإدارة الإيميلات');
            }
            break;

        case '📤 تصدير كل الإيميلات':
        case '📤 Export All Emails':
            await exportAllEmails(chatId, language);
            break;

        case '📤 تصدير عدد محدد من الإيميلات':
        case '📤 Export Limited Emails':
            userStates.set(userId, 'export_limited_emails');
            bot.sendMessage(chatId, language === 'en' ?
                '📤 How many emails do you want to export? (newest first)\n\nSend a number:' :
                '📤 كم عدد الإيميلات التي تريد تصديرها؟ (الأحدث أولاً)\n\nأرسل رقماً:');
            break;

        case '↩️ إرجاع من التصدير':
        case '↩️ Restore from Export':
            userStates.set(userId, 'restore_exported_emails');
            await showRestoreOptions(chatId, language);
            break;

        case '✅ إرسال المقبولة وقبولها':
        case '✅ Send Approved & Approve':
            await sendAndApproveEmails(chatId, userId, language);
            break;

        case '❌ إرسال المرفوضة ورفضها':
        case '❌ Send Rejected & Reject':
            await sendAndRejectEmails(chatId, userId, language);
            break;

        case '⏳ الإيميلات غير الموافق عليها':
        case '⏳ Pending Unapproved Emails':
            await showAndExportPendingUnapproved(chatId, language);
            break;

        case '📦 الإيميلات غير المصدرة':
        case '📦 Non-Exported Emails':
            await showAndExportNonExported(chatId, language);
            break;

        // User management buttons
        case '🔍 البحث عن مستخدم':
        case '🔍 Search User':
            userStates.set(userId, 'searching_user');
            const searchMessage = language === 'en' ?
                '🔍 Send user ID or username to search:\n\n💡 You can search by:\n• User ID (exact): 123456789\n• Username (partial): john (finds john123, johnny, etc.)\n• Arabic names work too!' :
                '🔍 أرسل الآيدي أو اليوزر نيم للبحث:\n\n💡 يمكنك البحث بـ:\n• الآيدي (دقيق): 123456789\n• اليوزر نيم (جزئي): أحمد (يجد أحمد123، أحمدي، إلخ)\n• الأسماء العربية تعمل أيضاً!';
            const cancelKeyboard2 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, searchMessage, cancelKeyboard2);
            break;

        case '📊 آخر 10 مستخدمين':
        case '📊 Last 10 Users':
            await showLastUsers(chatId, language);
            break;

        case '📋 تقرير مستخدم كامل':
        case '📋 Full User Report':
            userStates.set(userId, 'full_user_report');
            const reportMessage = language === 'en' ?
                '📋 Send user ID to get full report:\n\n💡 Enter the exact user ID (numbers only)' :
                '📋 أرسل آيدي المستخدم للحصول على تقرير كامل:\n\n💡 أدخل الآيدي الدقيق (أرقام فقط)';
            const cancelKeyboardReport = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, reportMessage, cancelKeyboardReport);
            break;

        // Message buttons
        case '📢 رسالة جماعية':
        case '📢 Broadcast Message':
            userStates.set(userId, 'broadcast_message');
            const broadcastMessage = language === 'en' ?
                '📢 Write the broadcast message:' :
                '📢 اكتب الرسالة الجماعية:';
            const cancelKeyboard3 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, broadcastMessage, cancelKeyboard3);
            break;

        case '👤 رسالة لشخص معين':
        case '👤 Private Message':
            userStates.set(userId, 'private_message_id');
            const privateMessage = language === 'en' ?
                '👤 Send user ID:' :
                '👤 أرسل آيدي المستخدم:';
            const cancelKeyboard4 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, privateMessage, cancelKeyboard4);
            break;

        // Settings buttons
        case '💰 إعدادات المكافآت':
        case '💰 Reward Settings':
            const rewardsKeyboard = keyboards.getKeyboard('rewardsSettings', language);
            const rewardsMessage = language === 'en' ?
                '💰 Reward and Price Settings:' :
                '💰 إعدادات المكافآت والأسعار:';
            bot.sendMessage(chatId, rewardsMessage, rewardsKeyboard);
            break;

        case '💳 تغيير الحد الأدنى للسحب':
        case '💳 Change Min Withdrawal':
            userStates.set(userId, 'change_min_withdrawal');
            const currentMinWithdrawal = await db.getSetting('min_withdrawal') || config.MIN_WITHDRAWAL;
            const minWithdrawalMessage = language === 'en' ?
                `💳 Current minimum withdrawal: ${formatBalance(parseFloat(currentMinWithdrawal), 'EGP')}\nSend new minimum:` :
                `💳 الحد الأدنى الحالي: ${formatBalance(parseFloat(currentMinWithdrawal), 'EGP')}\nأرسل الحد الجديد:`;
            const cancelKeyboard5 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, minWithdrawalMessage, cancelKeyboard5);
            break;

        case '💱 معرفة سعر الصرف':
        case '💱 Check Exchange Rate': {
            const currentRate = await db.getSetting('usd_to_egp_rate') || config.USD_TO_EGP_RATE;
            const lastUpdate = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
            const exchangeRateMessage = language === 'en' ?
                `💱 Current Exchange Rate (Binance P2P)\n\n💵 1 USDT = ${currentRate} EGP\n\n🕐 Last update: ${lastUpdate}\n\n🔄 Rate updates automatically every 10 minutes` :
                `💱 سعر الصرف الحالي (Binance P2P)\n\n💵 1 USDT = ${currentRate} جنيه\n\n🕐 آخر تحديث: ${lastUpdate}\n\n🔄 السعر يتحدث تلقائياً كل 10 دقائق`;
            bot.sendMessage(chatId, exchangeRateMessage);
            break;
        }

        case '💬 تعديل رسالة الدعم':
        case '💬 Edit Support Message':
            userStates.set(userId, 'change_support_message');
            const currentSupportMessage = await db.getSetting('support_message') || getMessage('SUPPORT', language);
            const supportMessage = language === 'en' ?
                `💬 Current support message:\n\n${currentSupportMessage}\n\n💡 Send new support message:` :
                `💬 رسالة الدعم الحالية:\n\n${currentSupportMessage}\n\n💡 أرسل رسالة الدعم الجديدة:`;
            const cancelKeyboard7 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, supportMessage, cancelKeyboard7);
            break;

        case '📢 إشعارات اليوزرات الجديدة':
        case '📢 New Accounts Notifications':
            // Show current status and confirmation
            const currentNotifSetting = await db.getSetting('notify_users_new_accounts') || 'true';
            const isNotifEnabled = currentNotifSetting !== 'false';
            const notifStatusText = isNotifEnabled ? 
                (language === 'en' ? '✅ Enabled' : '✅ مفعل') : 
                (language === 'en' ? '❌ Disabled' : '❌ معطل');
            
            const notifMessage = language === 'en' ?
                `📢 New Accounts Notifications\n\nCurrent Status: ${notifStatusText}\n\n💡 When enabled, all users will be notified when you add new email accounts\n\n📝 Notification message:\n"🎉 New high-value email accounts have been added! Higher rewards available now 🚀"\n\nDo you want to ${isNotifEnabled ? 'disable' : 'enable'} notifications?` :
                `📢 إشعارات اليوزرات الجديدة\n\nالحالة الحالية: ${notifStatusText}\n\n💡 عند التفعيل، سيتم إشعار جميع المستخدمين عند إضافة إيميلات جديدة\n\n📝 رسالة الإشعار:\n"🎉 تم إضافة إيميلات جديدة بسعر مرتفع! مكافآت أعلى متاحة الآن 🚀"\n\nهل تريد ${isNotifEnabled ? 'تعطيل' : 'تفعيل'} الإشعارات؟`;
            
            const notifKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: language === 'en' ? (isNotifEnabled ? '❌ Disable' : '✅ Enable') : (isNotifEnabled ? '❌ تعطيل' : '✅ تفعيل'),
                                callback_data: `toggle_notifications_${isNotifEnabled ? 'disable' : 'enable'}`
                            }
                        ],
                        [
                            {
                                text: language === 'en' ? '🔙 Cancel' : '🔙 إلغاء',
                                callback_data: 'cancel_notification_toggle'
                            }
                        ]
                    ]
                }
            };
            
            bot.sendMessage(chatId, notifMessage, notifKeyboard);
            break;

        // Reward settings buttons
        case '💰 مكافأة مهمة اليوزرات':
        case '💰 Email Task Reward':
            userStates.set(userId, 'change_email_reward');
            const currentEmailReward = await db.getSetting('task_reward') || config.TASK_REWARD;
            const emailRewardMessage = language === 'en' ?
                `💰 Current email task reward: ${formatBalance(parseFloat(currentEmailReward), 'EGP')}\nSend new reward:` :
                `💰 مكافأة مهمة اليوزرات الحالية: ${formatBalance(parseFloat(currentEmailReward), 'EGP')}\nأرسل المكافأة الجديدة:`;
            const cancelKeyboard8 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, emailRewardMessage, cancelKeyboard8);
            break;

        case '📱 مكافأة مهمة الجيميل':
        case '📱 Gmail Task Reward':
            userStates.set(userId, 'change_gmail_reward');
            const currentGmailReward = await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD;
            const gmailRewardMessage = language === 'en' ?
                `📱 Current Gmail task reward: ${formatBalance(parseFloat(currentGmailReward), 'EGP')}\nSend new reward:` :
                `📱 مكافأة مهمة الجيميل الحالية: ${formatBalance(parseFloat(currentGmailReward), 'EGP')}\nأرسل المكافأة الجديدة:`;
            const cancelKeyboard9 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, gmailRewardMessage, cancelKeyboard9);
            break;

        case '🔗 مكافأة الإحالة':
        case '🔗 Referral Reward':
            const referralKeyboard = keyboards.getKeyboard('referralRewardSettings', language);
            const referralMessage = language === 'en' ?
                '🔗 Referral Reward Settings:' :
                '🔗 إعدادات مكافأة الإحالة:';
            bot.sendMessage(chatId, referralMessage, referralKeyboard);
            break;

        case '🔑 كلمة مرور الجيميل الموحدة':
        case '🔑 Universal Gmail Password':
            userStates.set(userId, 'change_gmail_password');
            const currentPassword = await db.getSetting('gmail_password') || config.GMAIL_PASSWORD;
            const passwordMessage = language === 'en' ?
                `🔑 Current password: ${currentPassword}\nSend new password:` :
                `🔑 كلمة المرور الحالية: ${currentPassword}\nأرسل كلمة المرور الجديدة:`;
            const cancelKeyboard10 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, passwordMessage, cancelKeyboard10);
            break;

        case '📝 تعديل نص مهمة الجيميل':
        case '📝 Edit Gmail Task Text':
            userStates.set(userId, 'change_gmail_task_text_ar');
            const currentTextAr = await db.getSetting('gmail_task_text_ar') || config.DEFAULT_GMAIL_TASK_TEXT_AR;
            const editMessageAr = language === 'en' ?
                `📝 Current Arabic Gmail task text:\n\n${currentTextAr.replace('{password}', 'PASSWORD')}\n\n💡 Send new Arabic text:\n\n⚠️ Use {password} as placeholder for password` :
                `📝 النص الحالي لمهمة الجيميل (عربي):\n\n${currentTextAr.replace('{password}', 'كلمة_المرور')}\n\n💡 أرسل النص العربي الجديد:\n\n⚠️ استخدم {password} مكان كلمة المرور`;
            const cancelKeyboard11 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, editMessageAr, cancelKeyboard11);
            break;

        case '💰 مكافأة الإحالة بالجنيه':
        case '💰 Referral Reward EGP':
            userStates.set(userId, 'change_referral_reward_egp');
            const currentReferralEGP = await db.getSetting('referral_reward_egp') || config.REFERRAL_REWARD_EGP;
            const referralEGPMessage = language === 'en' ?
                `💰 Current referral reward (EGP): ${formatBalance(parseFloat(currentReferralEGP), 'EGP')}\nSend new reward:` :
                `💰 مكافأة الإحالة الحالية (جنيه): ${formatBalance(parseFloat(currentReferralEGP), 'EGP')}\nأرسل المكافأة الجديدة:`;
            const cancelKeyboard12 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, referralEGPMessage, cancelKeyboard12);
            break;

        case '💵 مكافأة الإحالة بالدولار':
        case '💵 Referral Reward USD':
            userStates.set(userId, 'change_referral_reward_usd');
            const currentReferralUSD = await db.getSetting('referral_reward_usd') || config.REFERRAL_REWARD_USD;
            const referralUSDMessage = language === 'en' ?
                `💵 Current referral reward (USD): ${formatBalance(parseFloat(currentReferralUSD), 'USD')}\nSend new reward:` :
                `💵 مكافأة الإحالة الحالية (دولار): ${formatBalance(parseFloat(currentReferralUSD), 'USD')}\nأرسل المكافأة الجديدة:`;
            const cancelKeyboard13 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, referralUSDMessage, cancelKeyboard13);
            break;

        case '🔙 العودة لإعدادات المكافآت':
        case '🔙 Back to Reward Settings':
            const backRewardsKeyboard = keyboards.getKeyboard('rewardsSettings', language);
            const backRewardsMessage = language === 'en' ?
                '💰 Reward and Price Settings:' :
                '💰 إعدادات المكافآت والأسعار:';
            bot.sendMessage(chatId, backRewardsMessage, backRewardsKeyboard);
            break;

        // Navigation buttons
        case '🔙 العودة للإعدادات':
        case '🔙 Back to Settings':
            const backSettingsKeyboard = keyboards.getKeyboard('settingsKeyboard', language);
            const backSettingsMessage = language === 'en' ?
                '⚙️ System Settings:' :
                '⚙️ إعدادات النظام:';
            bot.sendMessage(chatId, backSettingsMessage, backSettingsKeyboard);
            break;

        case '🔙 العودة لقائمة الأدمن':
        case '🔙 Back to Admin Menu':
            const isMain = await isMainAdmin(userId);
            const keyboardType = isMain ? 'mainAdminKeyboard' : 'adminKeyboard';
            const adminKeyboard = keyboards.getKeyboard(keyboardType, language);
            const adminMessage = language === 'en' ?
                '👑 Admin Panel:' :
                '👑 لوحة الأدمن:';
            bot.sendMessage(chatId, adminMessage, adminKeyboard);
            break;

        // Admin Management (Main Admin Only)
        case '👑 إدارة الأدمنز':
        case '👑 Admin Management':
            if (await isMainAdmin(userId)) {
                const adminMgmtKeyboard = keyboards.getKeyboard('adminManagement', language);
                const adminMgmtMessage = language === 'en' ?
                    '👑 Admin Management:' :
                    '👑 إدارة الأدمنز:';
                bot.sendMessage(chatId, adminMgmtMessage, adminMgmtKeyboard);
            } else {
                const noPermMessage = language === 'en' ?
                    '❌ You don\'t have permission to access this feature' :
                    '❌ ليس لديك صلاحية للوصول لهذه الميزة';
                bot.sendMessage(chatId, noPermMessage);
            }
            break;

        case '➕ إضافة أدمن':
        case '➕ Add Admin':
            if (await isMainAdmin(userId)) {
                userStates.set(userId, 'awaiting_new_admin_id');
                const addAdminMessage = language === 'en' ?
                    '👑 Send the user ID of the new admin:' :
                    '👑 أرسل آيدي المستخدم الذي تريد إضافته كأدمن:';
                const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
                bot.sendMessage(chatId, addAdminMessage, cancelKeyboard);
            }
            break;

        case '📋 قائمة الأدمنز':
        case '📋 Admin List':
            if (await isMainAdmin(userId)) {
                await showAdminList(chatId, language);
            }
            break;

        case '❌ حذف أدمن':
        case '❌ Remove Admin':
            if (await isMainAdmin(userId)) {
                userStates.set(userId, 'awaiting_remove_admin_id');
                const removeAdminMessage = language === 'en' ?
                    '❌ Send the user ID of the admin you want to remove:' :
                    '❌ أرسل آيدي الأدمن الذي تريد حذفه:';
                const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
                bot.sendMessage(chatId, removeAdminMessage, cancelKeyboard);
            }
            break;

        case '📧 صلاحية مراجعة الإيميلات':
        case '📧 Email Review Permission':
            if (await isMainAdmin(userId)) {
                await showEmailReviewPermissionMenu(chatId, language);
            }
            break;

        case '💳 صلاحية طلبات السحب':
        case '💳 Withdrawal Access Permission':
            if (await isMainAdmin(userId)) {
                await showWithdrawalPermissionMenu(chatId, language);
            }
            break;

        default:
            // For unhandled buttons, show main admin menu
            const defaultKeyboard = keyboards.getKeyboard('adminKeyboard', language);
            const defaultMessage = language === 'en' ?
                '👑 Admin Panel - Choose an option:' :
                '👑 لوحة الأدمن - اختر خياراً:';
            bot.sendMessage(chatId, defaultMessage, defaultKeyboard);
            break;
    }
}

// Show tasks menu
async function showTasksMenu(chatId, userId, language) {
    try {
        // Get current rewards from database or config
        const emailReward = await db.getSetting('task_reward') || config.TASK_REWARD;
        const gmailReward = await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD;

        // Get user's currency for display
        const user = await db.getUser(userId);
        const currency = user?.preferred_currency || 'EGP';

        // Calculate rewards in user's currency
        let emailRewardDisplay, gmailRewardDisplay;

        if (currency === 'USD') {
            const emailRewardUSD = await convertEGPToUSD(parseFloat(emailReward));
            const gmailRewardUSD = await convertEGPToUSD(parseFloat(gmailReward));
            emailRewardDisplay = `$${emailRewardUSD.toFixed(3)}`;
            gmailRewardDisplay = `$${gmailRewardUSD.toFixed(3)}`;
        } else {
            emailRewardDisplay = formatBalance(parseFloat(emailReward), 'EGP');
            gmailRewardDisplay = formatBalance(parseFloat(gmailReward), 'EGP');
        }

        // Send warning message first
        const warningMessage = language === 'en' ?
            `⚠️ Important Notice:\n\nIf you face any problems or delays in payment, contact support immediately and don't hesitate!\n\n📞 Support is always ready to help you.` :
            `⚠️ تنبيه مهم:\n\nإذا واجهت أي مشكلة أو تأخير في الدفع، كلم الدعم فوراً ولا تتردد!\n\n📞 الدعم جاهز دائماً لمساعدتك.`;
        
        await bot.sendMessage(chatId, warningMessage);
        
        // Send tasks menu immediately
        const keyboard = keyboards.createTasksMenuWithRewards(language, emailRewardDisplay, gmailRewardDisplay);
        const message = language === 'en' ?
            `📋 Available Tasks:\n\n💰 Choose a task to start earning!\n\n✨ Rewards are updated automatically!` :
            `📋 المهام المتاحة:\n\n💰 اختر مهمة لتبدأ الربح!\n\n✨ المكافآت تتحدث تلقائياً!`;

        await bot.sendMessage(chatId, message, keyboard);
    } catch (error) {
        console.error('Error showing tasks menu:', error);
        // Fallback with warning message
        const warningMessage = language === 'en' ?
            `⚠️ Important Notice:\n\nIf you face any problems or delays in payment, contact support immediately and don't hesitate!\n\n📞 Support is always ready to help you.` :
            `⚠️ تنبيه مهم:\n\nإذا واجهت أي مشكلة أو تأخير في الدفع، كلم الدعم فوراً ولا تتردد!\n\n📞 الدعم جاهز دائماً لمساعدتك.`;
        
        await bot.sendMessage(chatId, warningMessage);
        
        // Send tasks menu immediately
        const keyboard = keyboards.getKeyboard('tasksMenu', language);
        const message = language === 'en' ?
            '📋 Available Tasks:\n\nChoose a task to start earning!' :
            '📋 المهام المتاحة:\n\nاختر مهمة لتبدأ الربح!';
        await bot.sendMessage(chatId, message, keyboard);
    }
}

// Assign email creation task
async function assignTask(chatId, userId, language) {
    try {
        // Remove any existing active task before creating new one
        const existingTask = await db.getActiveTask(userId);
        if (existingTask) {
            await db.removeActiveTask(userId);
            // If there was an email task, return the account to available pool
            if (existingTask.email !== 'gmail_task') {
                try {
                    await db.addAvailableAccount(existingTask.email, existingTask.password, existingTask.first_name, existingTask.last_name);
                } catch (error) {
                    console.error('Error returning account to pool:', error.message);
                }
            }
        }

        // Get available account
        const account = await db.getRandomAvailableAccount();
        if (!account) {
            const message = language === 'en' ?
                '⏳ Currently no email accounts available, new ones will be added soon!\n\n💡 You can try another task now:\n📱 Gmail Creation Task is available!' :
                '⏳ حالياً لا يوجد يوزرات إيميل، سيتم إضافتها قريباً!\n\n💡 يمكنك أن تقوم بمهمة أخرى الآن:\n📱 مهمة إنشاء جيميل متاحة!';
            return bot.sendMessage(chatId, message);
        }

        // Create task
        const expiresAt = new Date(Date.now() + config.TASK_TIMEOUT * 60 * 1000);
        await db.addActiveTask(userId, account.email, account.password, expiresAt, account.first_name, account.last_name);
        await db.removeAvailableAccount(account.id);

        // Send task to user
        let namesInfo = '';
        if (account.first_name || account.last_name) {
            const fullName = `${account.first_name || ''} ${account.last_name || ''}`.trim();
            namesInfo = language === 'en' ? 
                `\n👤 Use this name: ${fullName}` : 
                `\n👤 استخدم هذا الاسم: ${fullName}`;
        }
        
        const message = getMessage('TASK_ASSIGNED', language)
            .replace('{email}', account.email)
            .replace('{password}', account.password)
            .replace('{names}', namesInfo);

        const keyboard = keyboards.getKeyboard('taskConfirm', language);
        bot.sendMessage(chatId, message, { ...keyboard, parse_mode: 'Markdown' });

        // Set timeout for half-time reminder (2.5 minutes)
        setTimeout(async () => {
            const task = await db.getActiveTask(userId);
            if (task && task.email === account.email) {
                const reminderMessage = language === 'en' ?
                    '⏰ Half time has passed!\n\n⚠️ You have 2.5 minutes remaining to complete the task\n\n❌ If you are unable to complete the task, please press Cancel' :
                    '⏰ نصف الوقت مضى!\n\n⚠️ لديك 2.5 دقيقة متبقية لإكمال المهمة\n\n❌ إذا لم تستطع إكمال المهمة، اضغط إلغاء من فضلك';
                bot.sendMessage(chatId, reminderMessage);
            }
        }, (config.TASK_TIMEOUT / 2) * 60 * 1000);

        // Set timeout for task expiration
        setTimeout(async () => {
            const task = await db.getActiveTask(userId);
            if (task && task.email === account.email) {
                await db.removeActiveTask(userId);
                try {
                    await db.addAvailableAccount(account.email, account.password, task.first_name, task.last_name);
                } catch (error) {
                    console.error('Error returning expired task account to pool:', error.message);
                }
                bot.sendMessage(chatId, getMessage('TASK_TIMEOUT', language));
            }
        }, config.TASK_TIMEOUT * 60 * 1000);

    } catch (error) {
        console.error('Error assigning task:', error);
        const message = language === 'en' ?
            '❌ Error assigning task' :
            '❌ حدث خطأ في تعيين المهمة';
        bot.sendMessage(chatId, message);
    }
}

// Assign Gmail creation task
async function assignGmailTask(chatId, userId, language) {
    try {
        // تحقق من الدولة المحفوظة للمستخدم قبل أي حاجة
        const user = await db.getUser(userId);
        const userCountry = user?.country_code || null;
        const allowedCountries = await db.getAllowedCountries();

        // لو مفيش دولة محفوظة → اطلب الموقع أولاً ووقف
        if (!userCountry) {
            userStates.set(userId, 'waiting_country_location');
            const msg = language === 'en'
                ? '📍 Please share your location first so we can record your country.\n\n📱 Must be done from your *phone*\n✅ Make sure Location Services are enabled\n\n⚠️ Required once only.'
                : '📍 يرجى مشاركة موقعك أولاً حتى نسجل دولتك.\n\n📱 يجب من *الهاتف* فقط\n✅ تأكد أن خدمة الموقع مفعّلة\n\n⚠️ مطلوب مرة واحدة فقط.';
            const keyboard = {
                reply_markup: {
                    keyboard: [
                        [{ text: language === 'en' ? '📍 Share Location' : '📍 مشاركة الموقع', request_location: true }],
                        [{ text: language === 'en' ? '❌ Cancel' : '❌ إلغاء' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            };
            return await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...keyboard });
        }

        // دولته محفوظة - تحقق لو مسموحة
        if (allowedCountries.length === 0 || !allowedCountries.includes(userCountry)) {
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            const message = language === 'en'
                ? '⏸️ The admin is currently satisfied with existing emails.\n\nYou can do the Email Creation Task instead!'
                : '⏸️ الأدمن مكتفي بالإيميلات الحالية.\n\nيمكنك القيام بمهمة إنشاء اليوزرات بدلاً من ذلك!';
            return bot.sendMessage(chatId, message, keyboard);
        }

        // الدولة مسموحة - تابع
        // Remove any existing active tasks before creating new one
        const existingTask = await db.getActiveTask(userId);
        if (existingTask) {
            await db.removeActiveTask(userId);
        }

        const password = await db.getSetting('gmail_password') || config.GMAIL_PASSWORD;

        // Create Gmail task without expiration (no timeout)
        await db.addActiveTask(userId, 'gmail_task', password, null);

        // Get Gmail task text from database settings or use default based on language
        let gmailTaskText;
        if (language === 'en') {
            gmailTaskText = await db.getSetting('gmail_task_text_en');
            if (!gmailTaskText) {
                gmailTaskText = config.DEFAULT_GMAIL_TASK_TEXT_EN;
                await db.setSetting('gmail_task_text_en', gmailTaskText);
            }
        } else {
            gmailTaskText = await db.getSetting('gmail_task_text_ar');
            if (!gmailTaskText) {
                gmailTaskText = config.DEFAULT_GMAIL_TASK_TEXT_AR;
                await db.setSetting('gmail_task_text_ar', gmailTaskText);
            }
        }

        const message = gmailTaskText.replace('{password}', `\`${password}\``);

        const keyboard = keyboards.getKeyboard('gmailTask', language);
        await bot.sendMessage(chatId, message, { ...keyboard, parse_mode: 'Markdown' });

        // Send password alone in a separate message for easy one-tap copy
        setTimeout(() => {
            bot.sendMessage(chatId, `\`${password}\``, { parse_mode: 'Markdown' });
        }, 500);

        // Send additional instruction message
        const instructionMessage = language === 'en' ?
            '📱 Steps to complete this task:\n\n1️⃣ Create Gmail account using the password above\n2️⃣ Press "Continue" button below\n3️⃣ Send your new Gmail address\n4️⃣ Wait for admin approval\n\n💰 You will receive your reward after approval!\n\n❌ If you are unable to complete the task, please cancel it' :
            '📱 خطوات إكمال هذه المهمة:\n\n1️⃣ أنشئ حساب جيميل باستخدام كلمة المرور أعلاه\n2️⃣ اضغط زر "متابعة" أدناه\n3️⃣ أرسل عنوان الجيميل الجديد\n4️⃣ انتظر موافقة الأدمن\n\n💰 ستحصل على مكافأتك بعد الموافقة!\n\n❌ إذا لم تتمكن من إكمال المهمة، يرجى إلغاؤها';
        
        setTimeout(() => {
            bot.sendMessage(chatId, instructionMessage);
        }, 2000);

        // No timeout for Gmail tasks - user can take as long as needed

    } catch (error) {
        console.error('Error assigning Gmail task:', error);
        const message = language === 'en' ?
            '❌ Error assigning Gmail task' :
            '❌ حدث خطأ في تعيين مهمة الجيميل';
        bot.sendMessage(chatId, message);
    }
}

// Complete email task
async function completeTask(chatId, userId, language) {
    try {
        const task = await db.getActiveTask(userId);
        if (!task) {
            const message = language === 'en' ?
                '❌ No active task found' :
                '❌ لا توجد مهمة نشطة';
            return bot.sendMessage(chatId, message);
        }

        try {
            await db.addPendingAccount(userId, task.email, task.password, 'email');
        } catch (error) {
            // Email already in pending
            await db.removeActiveTask(userId);
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            const message = language === 'en' ?
                '❌ This account is already submitted for review!\n\n💡 Please wait for admin approval or try a different task' :
                '❌ هذا الحساب تم إرساله للمراجعة بالفعل!\n\n💡 يرجى انتظار موافقة الأدمن أو جرب مهمة أخرى';
            return bot.sendMessage(chatId, message, keyboard);
        }
        
        await db.removeActiveTask(userId);

        const keyboard = keyboards.getKeyboard('userKeyboard', language);
        bot.sendMessage(chatId, getMessage('TASK_COMPLETED', language), keyboard);

        // Notify admin
        const user = await db.getUser(userId);
        const adminMessage = `📧 New account for review!\n\nUser: ${user.username || 'Unknown'}\nID: \`${userId}\`\nEmail: ${task.email}\nPassword: ${task.password}`;
        bot.sendMessage(config.ADMIN_ID, adminMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error completing task:', error);
        const message = language === 'en' ?
            '❌ Error completing task' :
            '❌ حدث خطأ في إكمال المهمة';
        bot.sendMessage(chatId, message);
    }
}

// Handle location message
async function handleLocationMessage(chatId, userId, location, language) {
    try {
        const userState = userStates.get(userId);
        const latitude = location.latitude;
        const longitude = location.longitude;

        // ── حالة تسجيل الدولة عند بداية البوت ──
        if (userState === 'waiting_country_location') {
            userStates.delete(userId);

            const processingMsg = language === 'en'
                ? '⏳ Detecting your country...'
                : '⏳ جاري تحديد دولتك...';
            await bot.sendMessage(chatId, processingMsg);

            const countryCode = await getCountryFromCoords(latitude, longitude);

            if (!countryCode) {
                // فشل تحديد الدولة - اسمح بالاستمرار بدون حظر
                const msg = language === 'en'
                    ? '⚠️ Could not detect your country. You can still use the bot!'
                    : '⚠️ لم نتمكن من تحديد دولتك. يمكنك استخدام البوت على أي حال!';
                await bot.sendMessage(chatId, msg);
                const keyboard = keyboards.getKeyboard('userKeyboard', language);
                await bot.sendMessage(chatId, getMessage('WELCOME', language), keyboard);
                return;
            }

            // حفظ الدولة
            await db.setUserCountry(userId, countryCode);

            const countryEntry = COUNTRIES_LIST.find(c => c.code === countryCode);
            const countryName = countryEntry ? countryEntry.name.split(' / ')[1] || countryEntry.name : countryCode;

            const successMsg = language === 'en'
                ? `✅ Your country has been recorded: ${countryName}\n\nWelcome! You can now use the bot.`
                : `✅ تم تسجيل دولتك: ${countryName}\n\nأهلاً! يمكنك الآن استخدام البوت.`;
            await bot.sendMessage(chatId, successMsg);

            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            await bot.sendMessage(chatId, getMessage('WELCOME', language), keyboard);
            return;
        }

        // ── حالة التحقق للجيميل ──
        if (userState === 'gmail_waiting_location') {
            const countryCode = await getCountryFromCoords(latitude, longitude);

            if (!countryCode) {
                // فشل تحديد الدولة - ارفض بشكل آمن
                const msg = language === 'en'
                    ? '❌ Could not detect your location. Please try again.'
                    : '❌ لم نتمكن من تحديد موقعك. حاول مرة أخرى.';
                return bot.sendMessage(chatId, msg);
            }

            // حفظ الدولة لو مش محفوظة
            const user = await db.getUser(userId);
            if (!user.country_code) {
                await db.setUserCountry(userId, countryCode);
            }

            // تحقق من الدول المسموحة
            const allowedCountries = await db.getAllowedCountries();
            const countryEntry = COUNTRIES_LIST.find(c => c.code === countryCode);
            const countryName = countryEntry ? countryEntry.name : countryCode;

            // لو القائمة فاضية = مفيش دول مسموحة = الجيميل مقفول للكل
            // لو القائمة فيها دول = بس الدول دي مسموحة
            if (allowedCountries.length === 0 || !allowedCountries.includes(countryCode)) {
                userStates.delete(userId);
                await db.removeActiveTask(userId);
                const keyboard = keyboards.getKeyboard('userKeyboard', language);
                const message = language === 'en'
                    ? '⏸️ The admin is currently satisfied with existing emails.\n\nYou can do the Email Creation Task instead!'
                    : '⏸️ الأدمن مكتفي بالإيميلات الحالية.\n\nيمكنك القيام بمهمة إنشاء اليوزرات بدلاً من ذلك!';
                await bot.sendMessage(chatId, message, keyboard);
                return;
            }

            // الدولة مسموحة - تابع لإرسال الإيميل
            userStates.set(userId, 'gmail_waiting_email');
            const message = language === 'en'
                ? '✅ Location verified!\n\n📧 Now send the Gmail address you created:\n\n💡 Example: yourname@gmail.com\n\n⚠️ Make sure to send only the email address!'
                : '✅ تم التحقق من الموقع!\n\n📧 الآن أرسل عنوان الجيميل الذي أنشأته:\n\n💡 مثال: yourname@gmail.com\n\n⚠️ تأكد من إرسال عنوان الإيميل فقط!';

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            await bot.sendMessage(chatId, message, keyboard);
        }
    } catch (error) {
        console.error('Error handling location:', error);
        const message = language === 'en'
            ? '❌ Error processing location'
            : '❌ حدث خطأ في معالجة الموقع';
        bot.sendMessage(chatId, message);
    }
}

// Continue Gmail task
async function continueGmailTask(chatId, userId, language) {
    try {
        const task = await db.getActiveTask(userId);
        if (!task || task.email !== 'gmail_task') {
            const message = language === 'en' ?
                '❌ No active Gmail task found\n\n💡 Please start a new Gmail task from the Tasks menu' :
                '❌ لا توجد مهمة جيميل نشطة\n\n💡 يرجى بدء مهمة جيميل جديدة من قائمة المهام';
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // تحقق من الدولة المحفوظة للمستخدم
        const user = await db.getUser(userId);
        const userCountry = user?.country_code || null;
        const allowedCountries = await db.getAllowedCountries();

        // لو مفيش دولة محفوظة → اطلب الموقع مرة واحدة
        if (!userCountry) {
            userStates.set(userId, 'gmail_waiting_location');
            const message = language === 'en'
                ? '📍 Please share your location to verify your country:\n\n💡 Click the button below to share your location\n\n📱 Must be done from your *phone*\n✅ Make sure Location Services are enabled'
                : '📍 يرجى مشاركة موقعك للتحقق من دولتك:\n\n💡 اضغط على الزر أدناه لمشاركة موقعك\n\n📱 يجب من *الهاتف* فقط\n✅ تأكد أن خدمة الموقع مفعّلة';
            const keyboard = {
                reply_markup: {
                    keyboard: [
                        [{ text: language === 'en' ? '📍 Share Location' : '📍 مشاركة الموقع', request_location: true }],
                        [{ text: language === 'en' ? '❌ Cancel' : '❌ إلغاء' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            };
            return await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
        }

        // الدولة محفوظة - تحقق منها مباشرة
        // لو القائمة فاضية أو الدولة مش فيها → مهمة غير متاحة
        if (allowedCountries.length === 0 || !allowedCountries.includes(userCountry)) {
            await db.removeActiveTask(userId);
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            const message = language === 'en'
                ? '⏸️ The admin is currently satisfied with existing emails.\n\nYou can do the Email Creation Task instead!'
                : '⏸️ الأدمن مكتفي بالإيميلات الحالية.\n\nيمكنك القيام بمهمة إنشاء اليوزرات بدلاً من ذلك!';
            return bot.sendMessage(chatId, message, keyboard);
        }

        // الدولة مسموحة - تابع لإرسال الإيميل
        userStates.set(userId, 'gmail_waiting_email');
        const message = language === 'en'
            ? '📧 Perfect! Now send the Gmail address you created:\n\n💡 Example: yourname@gmail.com\n\n⚠️ Make sure to send only the email address!'
            : '📧 ممتاز! الآن أرسل عنوان الجيميل الذي أنشأته:\n\n💡 مثال: yourname@gmail.com\n\n⚠️ تأكد من إرسال عنوان الإيميل فقط!';
        const keyboard = keyboards.getKeyboard('cancelUser', language);
        await bot.sendMessage(chatId, message, keyboard);

    } catch (error) {
        console.error('Error in Gmail task continuation:', error);
        const message = language === 'en'
            ? '❌ Error in Gmail task'
            : '❌ حدث خطأ في مهمة الجيميل';
        bot.sendMessage(chatId, message);
    }
}

// Cancel task
async function cancelTask(chatId, userId, language) {
    try {
        // Check cancellation rate limit
        const now = Date.now();
        const userCancellations = taskCancellations.get(userId) || [];
        const recentCancellations = userCancellations.filter(time => now - time < CANCEL_LIMIT_WINDOW);
        
        if (recentCancellations.length >= MAX_CANCELLATIONS_PER_HOUR) {
            const message = language === 'en' ?
                '⚠️ You have cancelled too many tasks recently!\n\n💡 Please complete your current task or wait before cancelling again\n\n⏰ Limit: 5 cancellations per hour' :
                '⚠️ لقد ألغيت عدد كبير من المهام مؤخراً!\n\n💡 يرجى إكمال مهمتك الحالية أو الانتظار قبل الإلغاء مرة أخرى\n\n⏰ الحد: 5 إلغاءات في الساعة';
            return bot.sendMessage(chatId, message);
        }
        
        const task = await db.getActiveTask(userId);
        if (task && task.email !== 'gmail_task') {
            try {
                await db.addAvailableAccount(task.email, task.password, task.first_name, task.last_name);
            } catch (error) {
                console.error('Error returning cancelled task account to pool:', error.message);
            }
        }
        await db.removeActiveTask(userId);
        
        // Track cancellation
        recentCancellations.push(now);
        taskCancellations.set(userId, recentCancellations);

        const keyboard = keyboards.getKeyboard('userKeyboard', language);
        const message = language === 'en' ?
            '✅ Task cancelled' :
            '✅ تم إلغاء المهمة';
        bot.sendMessage(chatId, message, keyboard);

    } catch (error) {
        console.error('Error cancelling task:', error);
    }
}

// Handle currency selection
async function handleCurrencySelection(chatId, userId, currency, language) {
    try {
        await db.setUserPreferredCurrency(userId, currency);

        // Get current rewards from database or config
        const emailReward = await db.getSetting('task_reward') || config.TASK_REWARD;
        const gmailReward = await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD;

        let message = '';
        if (currency === 'USD') {
            const emailRewardUSD = await convertEGPToUSD(parseFloat(emailReward));
            const gmailRewardUSD = await convertEGPToUSD(parseFloat(gmailReward));
            message = language === 'en' ?
                `✅ US Dollar selected as preferred currency!\n\n💵 You will receive rewards in USD\n💳 Withdrawals via Binance\n\n📊 Reward rates:\n📧 Email task: $${emailRewardUSD.toFixed(3)}\n📱 Gmail task: $${gmailRewardUSD.toFixed(3)}\n\n💡 You can change currency later from "💱 Change Currency"` :
                `✅ تم اختيار الدولار الأمريكي كعملة مفضلة!\n\n💵 ستحصل على مكافآتك بالدولار\n💳 السحب سيكون عبر Binance\n\n📊 أسعار المكافآت:\n📧 مهمة اليوزرات: $${emailRewardUSD.toFixed(3)}\n📱 مهمة الجيميل: $${gmailRewardUSD.toFixed(3)}\n\n💡 يمكنك تغيير العملة لاحقاً من زر "💱 تغيير العملة"`;
        } else {
            message = language === 'en' ?
                `✅ Egyptian Pound selected as preferred currency!\n\n💰 You will receive rewards in EGP\n💳 Withdrawals via local wallets\n\n📊 Reward rates:\n📧 Email task: ${formatBalance(parseFloat(emailReward), 'EGP')}\n📱 Gmail task: ${formatBalance(parseFloat(gmailReward), 'EGP')}\n\n💡 You can change currency later from "💱 Change Currency"` :
                `✅ تم اختيار الجنيه المصري كعملة مفضلة!\n\n💰 ستحصل على مكافآتك بالجنيه المصري\n💳 السحب سيكون عبر المحافظ المحلية\n\n📊 أسعار المكافآت:\n📧 مهمة اليوزرات: ${formatBalance(parseFloat(emailReward), 'EGP')}\n📱 مهمة الجيميل: ${formatBalance(parseFloat(gmailReward), 'EGP')}\n\n💡 يمكنك تغيير العملة لاحقاً من زر "💱 تغيير العملة"`;
        }

        const keyboard = keyboards.getKeyboard('userKeyboard', language);
        bot.sendMessage(chatId, message, keyboard);

        setTimeout(() => {
            bot.sendMessage(chatId, getMessage('CHOOSE_TASKS', language));
        }, 1000);

    } catch (error) {
        console.error('Error selecting currency:', error);
        const message = language === 'en' ?
            '❌ Error selecting currency, try again' :
            '❌ حدث خطأ في اختيار العملة، حاول مرة أخرى';
        bot.sendMessage(chatId, message);
    }
}

// Show currency change menu
async function showCurrencyChangeMenu(chatId, userId, language) {
    try {
        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User data not found' :
                '❌ لم يتم العثور على بياناتك';
            return bot.sendMessage(chatId, message);
        }

        const currentCurrency = user.preferred_currency || 'EGP';
        const currentCurrencyName = language === 'en' ?
            (currentCurrency === 'USD' ? 'US Dollar' : 'Egyptian Pound') :
            (currentCurrency === 'USD' ? 'الدولار الأمريكي' : 'الجنيه المصري');

        const currentMethod = language === 'en' ?
            (currentCurrency === 'USD' ? 'Binance' : 'Local wallets') :
            (currentCurrency === 'USD' ? 'Binance' : 'محافظ محلية');

        let balanceInfo = '';
        if (currentCurrency === 'USD') {
            const usdBalance = user.balance_usd || 0;
            const egpEquivalent = await convertUSDToEGP(usdBalance);
            balanceInfo = language === 'en' ?
                `💰 Current balance: $${usdBalance.toFixed(2)}\n💱 EGP equivalent: ${formatBalance(egpEquivalent, 'EGP')}` :
                `💰 رصيدك الحالي: $${usdBalance.toFixed(2)}\n💱 معادل بالجنيه: ${formatBalance(egpEquivalent, 'EGP')}`;
        } else {
            const egpBalance = user.balance || 0;
            const usdEquivalent = await convertEGPToUSD(egpBalance);
            balanceInfo = language === 'en' ?
                `💰 Current balance: ${formatBalance(egpBalance, 'EGP')}\n💱 USD equivalent: $${usdEquivalent.toFixed(3)}` :
                `💰 رصيدك الحالي: ${formatBalance(egpBalance, 'EGP')}\n💱 معادل بالدولار: $${usdEquivalent.toFixed(3)}`;
        }

        const currentRate = await db.getSetting('usd_to_egp_rate') || config.USD_TO_EGP_RATE;
        const message = language === 'en' ?
            `💱 Currency Settings\n\n📊 Current currency: ${currentCurrencyName}\n💳 Withdrawal method: ${currentMethod}\n\n${balanceInfo}\n\n⚠️ Currency conversion:\n• Your balance will be converted at current rate (1$ = ${currentRate} EGP)\n• You won't lose any balance\n• Withdrawal method will change based on new currency\n\n💡 Choose new currency:` :
            `💱 إعدادات العملة\n\n📊 العملة الحالية: ${currentCurrencyName}\n💳 طريقة السحب: ${currentMethod}\n\n${balanceInfo}\n\n⚠️ تحويل العملة:\n• سيتم تحويل رصيدك بسعر الصرف الحالي (1$ = ${currentRate} جنيه)\n• لن تفقد أي من رصيدك\n• ستتغير طريقة السحب حسب العملة الجديدة\n\n💡 اختر العملة الجديدة:`;

        const keyboard = keyboards.getKeyboard('currencyChange', language);
        bot.sendMessage(chatId, message, keyboard);
    } catch (error) {
        console.error('Error showing currency change menu:', error);
        const message = language === 'en' ?
            '❌ Error occurred, try again' :
            '❌ حدث خطأ، حاول مرة أخرى';
        bot.sendMessage(chatId, message);
    }
}

// Handle currency change
async function handleCurrencyChange(chatId, userId, newCurrency, language) {
    try {
        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User data not found' :
                '❌ لم يتم العثور على بياناتك';
            return bot.sendMessage(chatId, message);
        }

        const currentCurrency = user.preferred_currency || 'EGP';

        if (currentCurrency === newCurrency) {
            const currencyName = language === 'en' ?
                (newCurrency === 'USD' ? 'US Dollar' : 'Egyptian Pound') :
                (newCurrency === 'USD' ? 'الدولار الأمريكي' : 'الجنيه المصري');
            const message = language === 'en' ?
                `💡 You are already using ${currencyName}!` :
                `💡 أنت تستخدم ${currencyName} بالفعل!`;
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Convert balance
        if (currentCurrency === 'EGP' && newCurrency === 'USD') {
            const egpBalance = user.balance || 0;
            const usdBalance = await convertEGPToUSD(egpBalance);

            await db.setUserPreferredCurrency(userId, 'USD');
            await db.setUserUSDBalance(userId, usdBalance);
            await db.setUserBalance(userId, 0);

            const message = language === 'en' ?
                `✅ Currency changed to US Dollar!\n\n💱 Balance converted:\n${formatBalance(egpBalance, 'EGP')} → $${usdBalance.toFixed(2)}\n\n💳 New withdrawal method: Binance\n📊 You will receive rewards in USD from now on` :
                `✅ تم تغيير العملة إلى الدولار الأمريكي!\n\n💱 تم تحويل رصيدك:\n${formatBalance(egpBalance, 'EGP')} ← $${usdBalance.toFixed(2)}\n\n💳 طريقة السحب الجديدة: Binance\n📊 ستحصل على المكافآت بالدولار من الآن`;

            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            bot.sendMessage(chatId, message, keyboard);

        } else if (currentCurrency === 'USD' && newCurrency === 'EGP') {
            const usdBalance = user.balance_usd || 0;
            const egpBalance = await convertUSDToEGP(usdBalance);

            await db.setUserPreferredCurrency(userId, 'EGP');
            await db.setUserBalance(userId, egpBalance);
            await db.setUserUSDBalance(userId, 0);

            const message = language === 'en' ?
                `✅ Currency changed to Egyptian Pound!\n\n💱 Balance converted:\n$${usdBalance.toFixed(2)} → ${formatBalance(egpBalance, 'EGP')}\n\n💳 New withdrawal method: Local wallets\n📊 You will receive rewards in EGP from now on` :
                `✅ تم تغيير العملة إلى الجنيه المصري!\n\n💱 تم تحويل رصيدك:\n$${usdBalance.toFixed(2)} ← ${formatBalance(egpBalance, 'EGP')}\n\n💳 طريقة السحب الجديدة: محافظ محلية\n📊 ستحصل على المكافآت بالجنيه من الآن`;

            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            bot.sendMessage(chatId, message, keyboard);
        }

        setTimeout(() => {
            bot.sendMessage(chatId, getMessage('CHOOSE_TASKS', language));
        }, 1000);

    } catch (error) {
        console.error('Error changing currency:', error);
        const message = language === 'en' ?
            '❌ Error changing currency, try again' :
            '❌ حدث خطأ في تغيير العملة، حاول مرة أخرى';
        bot.sendMessage(chatId, message);
    }
}

// Show wallet
async function showWallet(chatId, userId, language) {
    try {
        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User data not found' :
                '❌ لم يتم العثور على بياناتك';
            return bot.sendMessage(chatId, message);
        }

        let message = language === 'en' ? '💰 Your Wallet:\n\n' : '💰 محفظتك:\n\n';

        if (user.preferred_currency === 'USD') {
            const usdBalance = user.balance_usd || 0;
            const minWithdrawalUSD = await db.getSetting('min_withdrawal_usd') || config.MIN_WITHDRAWAL_USD;
            message += language === 'en' ?
                `Current balance: $${usdBalance.toFixed(2)}\nMinimum withdrawal: $${parseFloat(minWithdrawalUSD).toFixed(2)}\n💳 Withdrawal method: Binance\n\n` :
                `الرصيد الحالي: $${usdBalance.toFixed(2)}\nالحد الأدنى للسحب: $${parseFloat(minWithdrawalUSD).toFixed(2)}\n💳 طريقة السحب: Binance\n\n`;
            const egpEquivalent = await convertUSDToEGP(usdBalance);
            message += language === 'en' ?
                `💱 EGP equivalent: ${formatBalance(egpEquivalent, 'EGP')}` :
                `💱 معادل بالجنيه: ${formatBalance(egpEquivalent, 'EGP')}`;
        } else {
            const egpBalance = user.balance || 0;
            const minWithdrawalEGP = await db.getSetting('min_withdrawal') || config.MIN_WITHDRAWAL;
            message += language === 'en' ?
                `Current balance: ${formatBalance(egpBalance, 'EGP')}\nMinimum withdrawal: ${formatBalance(parseFloat(minWithdrawalEGP), 'EGP')}\n💳 Withdrawal method: Local wallets\n\n` :
                `الرصيد الحالي: ${formatBalance(egpBalance, 'EGP')}\nالحد الأدنى للسحب: ${formatBalance(parseFloat(minWithdrawalEGP), 'EGP')}\n💳 طريقة السحب: محافظ محلية\n\n`;
            const usdEquivalent = await convertEGPToUSD(egpBalance);
            message += language === 'en' ?
                `💱 USD equivalent: $${usdEquivalent.toFixed(3)}` :
                `💱 معادل بالدولار: $${usdEquivalent.toFixed(3)}`;
        }

        bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error showing wallet:', error);
        const message = language === 'en' ?
            '❌ Error showing wallet' :
            '❌ حدث خطأ في عرض المحفظة';
        bot.sendMessage(chatId, message);
    }
}

// Show pending funds (emails & gmails submitted by user with their status)
async function showPendingFunds(chatId, userId, language, page = 1, editMessageId = null) {
    try {
        const ITEMS_PER_PAGE = 10;

        // Get all pending/approved/rejected emails for this user
        const [pendingEmails, gmailAccounts] = await Promise.all([
            db.getUserPendingAccounts(userId),
            db.getUserGmailAccounts(userId)
        ]);

        // Merge both lists with type label
        const allItems = [
            ...pendingEmails.map(e => ({ ...e, type: 'email' })),
            ...gmailAccounts.map(g => ({ ...g, type: 'gmail' }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (allItems.length === 0) {
            const msg = language === 'en'
                ? '⏳ Pending Funds\n\nYou have not submitted any accounts yet.'
                : '⏳ الأموال المعلقة\n\nلم تقم بإرسال أي حسابات بعد.';
            if (editMessageId) {
                return bot.editMessageText(msg, { chat_id: chatId, message_id: editMessageId });
            }
            return bot.sendMessage(chatId, msg);
        }

        const totalPages = Math.ceil(allItems.length / ITEMS_PER_PAGE);
        page = Math.max(1, Math.min(page, totalPages));
        const start = (page - 1) * ITEMS_PER_PAGE;
        const pageItems = allItems.slice(start, start + ITEMS_PER_PAGE);

        // Format date helper - shows UTC time
        const formatDate = (dateStr) => {
            if (!dateStr) return '—';
            const d = new Date(dateStr);
            return d.toISOString().replace('T', ' ').substring(0, 16);
        };

        // Status emoji
        const statusEmoji = (status) => {
            if (status === 'approved') return '✅';
            if (status === 'rejected') return '❌';
            if (status === 'processing') return '⚙️';
            return '⏳';
        };

        const statusLabel = (status, lang) => {
            const labels = {
                approved: lang === 'en' ? 'Approved' : 'مقبول',
                rejected: lang === 'en' ? 'Rejected' : 'مرفوض',
                processing: lang === 'en' ? 'Processing' : 'جاري المعالجة',
                pending: lang === 'en' ? 'Pending' : 'معلق'
            };
            return labels[status] || (lang === 'en' ? 'Pending' : 'معلق');
        };

        const typeLabel = (type, lang) => {
            if (type === 'gmail') return lang === 'en' ? '📱 Gmail' : '📱 جيميل';
            return lang === 'en' ? '📧 Email' : '📧 يوزر';
        };

        let message = language === 'en'
            ? `⏳ *Pending Funds* — Page ${page}/${totalPages}\n\n`
            : `⏳ *الأموال المعلقة* — صفحة ${page}/${totalPages}\n\n`;

        pageItems.forEach((item, i) => {
            const num = start + i + 1;
            const processedDate = item.processed_at || item.updated_at || null;

            message += `${num}. ${typeLabel(item.type, language)}\n`;
            message += `📧 \`${item.email}\`\n`;
            message += language === 'en'
                ? `📊 Status: ${statusEmoji(item.status)} ${statusLabel(item.status, language)}\n`
                : `📊 الحالة: ${statusEmoji(item.status)} ${statusLabel(item.status, language)}\n`;
            message += language === 'en'
                ? `📅 Sent: ${formatDate(item.created_at)}\n`
                : `📅 تاريخ الإرسال: ${formatDate(item.created_at)}\n`;

            if (item.status === 'approved' || item.status === 'rejected') {
                message += language === 'en'
                    ? `🕐 ${item.status === 'approved' ? 'Approved' : 'Rejected'}: ${formatDate(processedDate)}\n`
                    : `🕐 ${item.status === 'approved' ? 'تاريخ القبول' : 'تاريخ الرفض'}: ${formatDate(processedDate)}\n`;
            }
            message += '\n';
        });

        // Pagination buttons
        const inlineButtons = [];
        const navRow = [];
        if (page > 1) navRow.push({ text: '◀️ السابق', callback_data: `pending_funds_page_${page - 1}` });
        if (page < totalPages) navRow.push({ text: 'التالي ▶️', callback_data: `pending_funds_page_${page + 1}` });
        if (navRow.length > 0) inlineButtons.push(navRow);

        const opts = {
            parse_mode: 'Markdown',
            reply_markup: inlineButtons.length > 0 ? { inline_keyboard: inlineButtons } : undefined
        };

        if (editMessageId) {
            bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, ...opts });
        } else {
            bot.sendMessage(chatId, message, opts);
        }

    } catch (error) {
        console.error('Error showing pending funds:', error);
        const msg = language === 'en' ? '❌ Error loading data' : '❌ حدث خطأ في تحميل البيانات';
        bot.sendMessage(chatId, msg);
    }
}

// Initiate withdrawal
async function initiateWithdrawal(chatId, userId, language) {
    try {
        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User data not found' :
                '❌ لم يتم العثور على بياناتك';
            return bot.sendMessage(chatId, message);
        }

        const currentBalance = user.preferred_currency === 'USD' ? user.balance_usd : user.balance;
        const minWithdrawalEGP = await db.getSetting('min_withdrawal') || config.MIN_WITHDRAWAL;
        const minWithdrawalUSD = await db.getSetting('min_withdrawal_usd') || config.MIN_WITHDRAWAL_USD;
        const minWithdrawal = user.preferred_currency === 'USD' ? parseFloat(minWithdrawalUSD) : parseFloat(minWithdrawalEGP);

        if (currentBalance < minWithdrawal) {
            const message = language === 'en' ?
                `❌ Insufficient balance for withdrawal\nMinimum: ${formatBalance(minWithdrawal, user.preferred_currency)}` :
                `❌ رصيدك غير كافي للسحب\nالحد الأدنى: ${formatBalance(minWithdrawal, user.preferred_currency)}`;
            return bot.sendMessage(chatId, message);
        }

        userStates.set(userId, 'withdrawal_amount');
        const message = language === 'en' ?
            `💳 Current balance: ${formatBalance(currentBalance, user.preferred_currency)}\nSend the amount to withdraw:` :
            `💳 رصيدك الحالي: ${formatBalance(currentBalance, user.preferred_currency)}\nأرسل المبلغ المراد سحبه:`;

        const keyboard = keyboards.getKeyboard('cancelUser', language);
        bot.sendMessage(chatId, message, keyboard);
    } catch (error) {
        console.error('Error initiating withdrawal:', error);
        const message = language === 'en' ?
            '❌ Error in withdrawal process' :
            '❌ حدث خطأ في عملية السحب';
        bot.sendMessage(chatId, message);
    }
}

// Handle user states
async function handleUserState(chatId, userId, text, state, language) {
    // Handle both object and string states
    const stateValue = typeof state === 'object' ? state.state : state;
    
    switch (stateValue) {
        case 'gmail_waiting_email':
            await processGmailEmail(chatId, userId, text, language);
            break;

        case 'withdrawal_amount':
            await processWithdrawal(chatId, userId, text, language);
            break;

        case 'awaiting_new_admin_id':
            await processAddAdmin(chatId, userId, text, language);
            break;

        case 'awaiting_remove_admin_id':
            await processRemoveAdmin(chatId, userId, text, language);
            break;

        case 'change_gmail_task_text_ar':
            await changeGmailTaskTextAr(chatId, userId, text, language);
            break;

        case 'change_gmail_task_text_en':
            await changeGmailTaskTextEn(chatId, userId, text, language);
            break;

        case 'searching_user':
            await searchAndShowUser(chatId, text, language);
            userStates.delete(userId);
            const userMgmtKeyboard = keyboards.getKeyboard('userManagement', language);
            const userMgmtMessage = language === 'en' ? '👥 User Management:' : '👥 إدارة المستخدمين:';
            bot.sendMessage(chatId, userMgmtMessage, userMgmtKeyboard);
            break;

        case 'full_user_report':
            await showFullUserReport(chatId, text, language);
            userStates.delete(userId);
            const userMgmtKeyboard2 = keyboards.getKeyboard('userManagement', language);
            const userMgmtMessage2 = language === 'en' ? '👥 User Management:' : '👥 إدارة المستخدمين:';
            bot.sendMessage(chatId, userMgmtMessage2, userMgmtKeyboard2);
            break;

        case 'broadcast_message':
            // Store the message and ask for confirmation
            userStates.set(userId, { state: 'broadcast_confirm', message: text });
            
            const userCount = await db.getUserCount();
            const confirmMessage = language === 'en' ?
                `📢 Broadcast Message Confirmation\n\n👥 Recipients: ${userCount} users\n\n📝 Message:\n"${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"\n\n⚠️ Are you sure you want to send this message to all users?` :
                `📢 تأكيد الرسالة الجماعية\n\n👥 المستلمون: ${userCount} مستخدم\n\n📝 الرسالة:\n"${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"\n\n⚠️ هل أنت متأكد من إرسال هذه الرسالة لجميع المستخدمين؟`;
            
            const confirmKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: language === 'en' ? '✅ Yes, Send' : '✅ نعم، أرسل',
                                callback_data: 'confirm_broadcast'
                            }
                        ],
                        [
                            {
                                text: language === 'en' ? '❌ Cancel' : '❌ إلغاء',
                                callback_data: 'cancel_broadcast'
                            }
                        ]
                    ]
                }
            };
            
            bot.sendMessage(chatId, confirmMessage, confirmKeyboard);
            break;

        case 'private_message_id':
            const targetUser = await db.getUser(text);
            if (!targetUser) {
                const errorMessage = language === 'en' ?
                    '❌ User not found\nSend a valid ID or press Cancel:' :
                    '❌ لم يتم العثور على المستخدم\nأرسل آيدي صحيح أو اضغط إلغاء:';
                const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
                return bot.sendMessage(chatId, errorMessage, cancelKeyboard);
            }
            userStates.set(userId, `private_message_text_${text}`);
            const privateMessage = language === 'en' ?
                `📝 Write message for user: ${targetUser.username || 'Unknown'}` :
                `📝 اكتب الرسالة للمستخدم: ${targetUser.username || 'غير محدد'}`;
            const cancelKeyboard2 = keyboards.getKeyboard('cancelAdmin', language);
            bot.sendMessage(chatId, privateMessage, cancelKeyboard2);
            break;

        case 'restore_exported_emails':
            await restoreEmailsByList(chatId, userId, text, language);
            userStates.delete(userId);
            break;

        case 'export_limited_emails':
            await exportLimitedEmails(chatId, text, language);
            userStates.delete(userId);
            break;

        case 'add_accounts':
            await addAccounts(chatId, userId, text, language);            // Don't delete userState here - addAccounts may set a new state for notifications
            // Only show admin keyboard if no new state was set
            if (!userStates.has(userId)) {
                const adminKeyboard = keyboards.getKeyboard('adminKeyboard', language);
                const adminMessage = language === 'en' ? '👑 Admin Panel:' : '👑 لوحة الأدمن:';
                bot.sendMessage(chatId, adminMessage, adminKeyboard);
            }
            break;

        case 'change_min_withdrawal':
            await changeMinWithdrawal(chatId, text, language);
            userStates.delete(userId);
            const settingsKeyboard = keyboards.getKeyboard('settingsKeyboard', language);
            const settingsMessage = language === 'en' ? '⚙️ System Settings:' : '⚙️ إعدادات النظام:';
            bot.sendMessage(chatId, settingsMessage, settingsKeyboard);
            break;

        case 'change_exchange_rate':
            await changeExchangeRate(chatId, text, language);
            userStates.delete(userId);
            const settingsKeyboard2 = keyboards.getKeyboard('settingsKeyboard', language);
            const settingsMessage2 = language === 'en' ? '⚙️ System Settings:' : '⚙️ إعدادات النظام:';
            bot.sendMessage(chatId, settingsMessage2, settingsKeyboard2);
            break;

        case 'change_support_message':
            await changeSupportMessage(chatId, text, language);
            userStates.delete(userId);
            const settingsKeyboard3 = keyboards.getKeyboard('settingsKeyboard', language);
            const settingsMessage3 = language === 'en' ? '⚙️ System Settings:' : '⚙️ إعدادات النظام:';
            bot.sendMessage(chatId, settingsMessage3, settingsKeyboard3);
            break;

        case 'change_email_reward':
            await changeEmailTaskReward(chatId, text, language);
            userStates.delete(userId);
            const rewardsKeyboard = keyboards.getKeyboard('rewardsSettings', language);
            const rewardsMessage = language === 'en' ? '💰 Reward and Price Settings:' : '💰 إعدادات المكافآت والأسعار:';
            bot.sendMessage(chatId, rewardsMessage, rewardsKeyboard);
            break;

        case 'change_gmail_reward':
            await changeGmailTaskReward(chatId, text, language);
            userStates.delete(userId);
            const rewardsKeyboard2 = keyboards.getKeyboard('rewardsSettings', language);
            const rewardsMessage2 = language === 'en' ? '💰 Reward and Price Settings:' : '💰 إعدادات المكافآت والأسعار:';
            bot.sendMessage(chatId, rewardsMessage2, rewardsKeyboard2);
            break;

        case 'change_gmail_password':
            await changeGmailPassword(chatId, text, language);
            userStates.delete(userId);
            const rewardsKeyboard3 = keyboards.getKeyboard('rewardsSettings', language);
            const rewardsMessage3 = language === 'en' ? '💰 Reward and Price Settings:' : '💰 إعدادات المكافآت والأسعار:';
            bot.sendMessage(chatId, rewardsMessage3, rewardsKeyboard3);
            break;

        case 'change_referral_reward_egp':
            await changeReferralRewardEGP(chatId, text, language);
            userStates.delete(userId);
            const referralKeyboard1 = keyboards.getKeyboard('referralRewardSettings', language);
            const referralMessage1 = language === 'en' ? '🔗 Referral Reward Settings:' : '🔗 إعدادات مكافأة الإحالة:';
            bot.sendMessage(chatId, referralMessage1, referralKeyboard1);
            break;

        case 'change_referral_reward_usd':
            await changeReferralRewardUSD(chatId, text, language);
            userStates.delete(userId);
            const referralKeyboard2 = keyboards.getKeyboard('referralRewardSettings', language);
            const referralMessage2 = language === 'en' ? '🔗 Referral Reward Settings:' : '🔗 إعدادات مكافأة الإحالة:';
            bot.sendMessage(chatId, referralMessage2, referralKeyboard2);
            break;

        case 'toggle_country':
            await handleCountryToggle(chatId, userId, text, language);
            break;

        case 'waiting_country_phone':
            // الـ contact بيتعالج في msg.contact handler - لو وصل هنا text عادي نتجاهله
            {
                const msg2 = language === 'en'
                    ? '📱 Please use the button to share your phone number, don\'t type it manually.'
                    : '📱 يرجى استخدام الزرار لمشاركة رقم هاتفك، لا تكتبه يدوياً.';
                bot.sendMessage(chatId, msg2);
            }
            break;

        case 'waiting_approve_emails':
            await processSelectiveApproval(chatId, userId, text, language);
            break;

        case 'waiting_reject_emails':
            await processSelectiveRejection(chatId, userId, text, language);
            break;

        default:
            if (stateValue.startsWith('withdrawal_binance_')) {
                const amount = parseFloat(stateValue.replace('withdrawal_binance_', ''));
                await processBinanceWithdrawal(chatId, userId, text, amount, language);
            } else if (stateValue.startsWith('withdrawal_cash_')) {
                const amount = parseFloat(stateValue.replace('withdrawal_cash_', ''));
                await processCashWithdrawal(chatId, userId, text, amount, language);
            } else if (stateValue.startsWith('private_message_text_')) {
                const targetUserId = stateValue.replace('private_message_text_', '');
                
                // Store message and ask for confirmation
                userStates.set(userId, { state: 'private_message_confirm', targetUserId: targetUserId, message: text });
                
                const targetUser = await db.getUser(targetUserId);
                const targetUsername = targetUser ? (targetUser.username || targetUserId) : targetUserId;
                
                const confirmMessage = language === 'en' ?
                    `📨 Private Message Confirmation\n\n👤 Recipient: ${targetUsername}\n🆔 ID: ${targetUserId}\n\n📝 Message:\n"${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"\n\n⚠️ Send this message?` :
                    `📨 تأكيد الرسالة الخاصة\n\n👤 المستلم: ${targetUsername}\n🆔 الآيدي: ${targetUserId}\n\n📝 الرسالة:\n"${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"\n\n⚠️ إرسال هذه الرسالة؟`;
                
                const confirmKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: language === 'en' ? '✅ Yes, Send' : '✅ نعم، أرسل',
                                    callback_data: 'confirm_private_message'
                                }
                            ],
                            [
                                {
                                    text: language === 'en' ? '❌ Cancel' : '❌ إلغاء',
                                    callback_data: 'cancel_private_message'
                                }
                            ]
                        ]
                    }
                };
                
                bot.sendMessage(chatId, confirmMessage, confirmKeyboard);
            } else if (stateValue.startsWith('edit_balance_')) {
                const targetUserId = stateValue.replace('edit_balance_', '');
                if (await isMainAdmin(userId)) {
                    await processBalanceEdit(chatId, targetUserId, text, language);
                } else {
                    userStates.delete(userId);
                    bot.sendMessage(chatId, language === 'en' ? '❌ Only main admin can edit balance' : '❌ تعديل الرصيد للأدمن الرئيسي فقط');
                }
                userStates.delete(userId);
                const userMgmtKeyboard = keyboards.getKeyboard('userManagement', language);
                const userMgmtMessage = language === 'en' ? '👥 User Management:' : '👥 إدارة المستخدمين:';
                bot.sendMessage(chatId, userMgmtMessage, userMgmtKeyboard);
            } else if (stateValue.startsWith('send_message_')) {
                const targetUserId = stateValue.replace('send_message_', '');
                await sendDirectMessage(chatId, targetUserId, text, language);
                userStates.delete(userId);
                const userMgmtKeyboard = keyboards.getKeyboard('userManagement', language);
                const userMgmtMessage = language === 'en' ? '👥 User Management:' : '👥 إدارة المستخدمين:';
                bot.sendMessage(chatId, userMgmtMessage, userMgmtKeyboard);
            }
            break;
    }
}

// Process Gmail email submission
async function processGmailEmail(chatId, userId, text, language) {
    try {
        // Check if user has active Gmail task
        const task = await db.getActiveTask(userId);
        if (!task || task.email !== 'gmail_task') {
            const message = language === 'en' ?
                '❌ No active Gmail task found\n\n💡 Please start a new Gmail task from the Tasks menu' :
                '❌ لا توجد مهمة جيميل نشطة\n\n💡 يرجى بدء مهمة جيميل جديدة من قائمة المهام';
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            userStates.delete(userId);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@gmail\.com$/i;
        if (!emailRegex.test(text)) {
            const message = language === 'en' ?
                '❌ Invalid Gmail address\n\n💡 Please send a valid Gmail address (example: yourname@gmail.com)\n\nOr press Cancel to exit:' :
                '❌ عنوان جيميل غير صحيح\n\n💡 يرجى إرسال عنوان جيميل صحيح (مثال: yourname@gmail.com)\n\nأو اضغط إلغاء للخروج:';
            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Check if email already exists (pending or approved, but not rejected)
        const emailExists = await db.checkGmailEmailExists(text);
        if (emailExists) {
            const message = language === 'en' ?
                '❌ This Gmail address cannot be used!\n\n⚠️ Possible reasons:\n• Already submitted and waiting for approval\n• Already approved previously\n\n💡 Please create a NEW Gmail account with a different email address\n\n🔄 Each Gmail address can only be used once\n\nOr press Cancel to exit:' :
                '❌ لا يمكن استخدام هذا العنوان!\n\n⚠️ الأسباب المحتملة:\n• تم إرساله بالفعل وفي انتظار الموافقة\n• تمت الموافقة عليه مسبقاً\n\n💡 يرجى إنشاء حساب جيميل جديد بعنوان مختلف\n\n🔄 كل عنوان جيميل يمكن استخدامه مرة واحدة فقط\n\nأو اضغط إلغاء للخروج:';
            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        await db.addGmailAccount(userId, text);
        await db.removeActiveTask(userId);
        userStates.delete(userId);

        const keyboard = keyboards.getKeyboard('userKeyboard', language);
        const message = language === 'en' ?
            '✅ Excellent! Gmail account sent for review!\n\n💰 You will receive your reward after admin approval\n\n📞 If you have any questions, contact support' :
            '✅ ممتاز! تم إرسال حساب الجيميل للمراجعة!\n\n💰 ستحصل على مكافأتك بعد موافقة الأدمن\n\n📞 إذا كان لديك أي استفسار، تواصل مع الدعم';
        await bot.sendMessage(chatId, message, keyboard);

        // Notify admin
        const user = await db.getUser(userId);
        const adminMessage = `📱 New Gmail account for review!\n\nUser: ${user.username || 'Unknown'}\nID: \`${userId}\`\nGmail: ${text}`;
        bot.sendMessage(config.ADMIN_ID, adminMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error processing Gmail email:', error);
        const message = language === 'en' ?
            '❌ Error processing Gmail account' :
            '❌ حدث خطأ في معالجة حساب الجيميل';
        bot.sendMessage(chatId, message);
    }
}

// Change Gmail task text Arabic (Admin function)
async function changeGmailTaskTextAr(chatId, userId, text, language) {
    try {
        // Save new Arabic Gmail task text to database
        await db.setSetting('gmail_task_text_ar', text);

        // Now ask for English text
        userStates.set(userId, 'change_gmail_task_text_en');
        
        const askEnglishMessage = language === 'en' ?
            '✅ Arabic text saved!\n\n📝 Now send the English Gmail task text:\n\n⚠️ Use {password} as placeholder for password' :
            '✅ تم حفظ النص العربي!\n\n📝 الآن أرسل نص مهمة الجيميل بالإنجليزية:\n\n⚠️ استخدم {password} كمكان لكلمة المرور';

        bot.sendMessage(chatId, askEnglishMessage);

    } catch (error) {
        console.error('Error changing Gmail task text (Arabic):', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating Arabic Gmail task text' :
            '❌ حدث خطأ في تحديث نص مهمة الجيميل العربي';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change Gmail task text English (Admin function)
async function changeGmailTaskTextEn(chatId, userId, text, language) {
    try {
        // Save new English Gmail task text to database
        await db.setSetting('gmail_task_text_en', text);

        userStates.delete(userId);

        const successMessage = language === 'en' ?
            '✅ Gmail task texts updated successfully!\n\n💡 Arabic users will see the Arabic text\n💡 English users will see the English text' :
            '✅ تم تحديث نصوص مهمة الجيميل بنجاح!\n\n💡 المستخدمون العرب سيرون النص العربي\n💡 المستخدمون الإنجليز سيرون النص الإنجليزي';

        const rewardsKeyboard = keyboards.getKeyboard('rewardsSettings', language);
        bot.sendMessage(chatId, successMessage, rewardsKeyboard);

    } catch (error) {
        console.error('Error changing Gmail task text (English):', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating English Gmail task text' :
            '❌ حدث خطأ في تحديث نص مهمة الجيميل';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Process withdrawal request
async function processWithdrawal(chatId, userId, text, language) {
    try {
        const withdrawAmount = parseFloat(text);
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            const message = language === 'en' ?
                '❌ Invalid amount\nSend a valid number or press Cancel:' :
                '❌ المبلغ غير صحيح\nأرسل رقم صحيح أو اضغط إلغاء:';
            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        const user = await db.getUser(userId);
        const currentBalance = user.preferred_currency === 'USD' ? user.balance_usd : user.balance;
        const minWithdrawalEGP = await db.getSetting('min_withdrawal') || config.MIN_WITHDRAWAL;
        const minWithdrawalUSD = await db.getSetting('min_withdrawal_usd') || config.MIN_WITHDRAWAL_USD;
        const minWithdrawal = user.preferred_currency === 'USD' ? parseFloat(minWithdrawalUSD) : parseFloat(minWithdrawalEGP);

        if (withdrawAmount > currentBalance) {
            const message = language === 'en' ?
                `❌ Amount exceeds your balance\nCurrent balance: ${formatBalance(currentBalance, user.preferred_currency)}\nSend a smaller amount or press Cancel:` :
                `❌ المبلغ أكبر من رصيدك\nرصيدك الحالي: ${formatBalance(currentBalance, user.preferred_currency)}\nأرسل مبلغ أقل أو اضغط إلغاء:`;
            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        if (withdrawAmount < minWithdrawal) {
            const message = language === 'en' ?
                `❌ Amount below minimum: ${formatBalance(minWithdrawal, user.preferred_currency)}\nSend a larger amount or press Cancel:` :
                `❌ المبلغ أقل من الحد الأدنى: ${formatBalance(minWithdrawal, user.preferred_currency)}\nأرسل مبلغ أكبر أو اضغط إلغاء:`;
            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Ask for withdrawal method for USD
        if (user.preferred_currency === 'USD') {
            // Show withdrawal method selection for USD
            userStates.set(userId, `withdrawal_binance_${withdrawAmount}`);
            const message = language === 'en' ?
                `💳 Binance Withdrawal\n\n💰 Amount: $${withdrawAmount.toFixed(2)}\n\n📝 Send your Binance ID:` :
                `💳 سحب Binance\n\n💰 المبلغ: $${withdrawAmount.toFixed(2)}\n\n📝 أرسل معرف Binance الخاص بك:`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            bot.sendMessage(chatId, message, keyboard);
        } else {
            // Ask for cash wallet number (EGP)
            userStates.set(userId, `withdrawal_cash_${withdrawAmount}`);
            const message = language === 'en' ?
                `💳 Cash Wallet Withdrawal Request\n\n💰 Amount: ${formatBalance(withdrawAmount, 'EGP')}\n\n📝 Please send your cash wallet number:\n\n📋 Format: 11 digits (01234567890)\n\n⚠️ Make sure the number is correct!\nIncorrect number may result in loss of funds.` :
                `💳 طلب سحب محفظة كاش\n\n💰 المبلغ: ${formatBalance(withdrawAmount, 'EGP')}\n\n📝 يرجى إرسال رقم محفظة الكاش:\n\n📋 الصيغة: 11 رقم (01234567890)\n\n⚠️ تأكد من صحة الرقم!\nالرقم الخاطئ قد يؤدي لفقدان الأموال.`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            bot.sendMessage(chatId, message, keyboard);
        }

    } catch (error) {
        console.error('Error processing withdrawal:', error);
        const message = language === 'en' ?
            '❌ Error processing withdrawal request' :
            '❌ حدث خطأ في معالجة طلب السحب';
        bot.sendMessage(chatId, message);
    }
}

// Handle callback queries (inline button clicks)
// ── Callback deduplication lock ──
// بيمنع تنفيذ نفس الـ callback أكتر من مرة (double-click أو retry بسبب انقطاع النت)
const processingCallbacks = new Set();

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    const callbackId = callbackQuery.id;

    // لو الـ callback ده بيتعالج دلوقتي، اتجاهله فوراً
    // المفتاح = userId + messageId + data عشان نمنع نفس العملية من نفس الرسالة
    const lockKey = `${userId}:${messageId}:${data}`;
    if (processingCallbacks.has(lockKey)) {
        try { await bot.answerCallbackQuery(callbackId); } catch {}
        return;
    }
    processingCallbacks.add(lockKey);

    // بعد 5 ثواني امسح الـ lock (عشان ميتعملش leak)
    setTimeout(() => processingCallbacks.delete(lockKey), 5000);

    // Auto-register user if not exists
    await ensureUser(userId, callbackQuery.from);

    try {
        // Handle email task start after warning confirmation
        if (data === 'start_email_task') {
            const language = await getUserLanguage(userId);
            await bot.answerCallbackQuery(callbackQuery.id);
            await assignTask(chatId, userId, language);
            return;
        }

        // Handle gmail task start after warning confirmation
        if (data === 'start_gmail_task') {
            const language = await getUserLanguage(userId);
            await bot.answerCallbackQuery(callbackQuery.id);
            await assignGmailTask(chatId, userId, language);
            return;
        }

        // Handle channel subscription check
        if (data === 'check_subscription') {
            const language = await getUserLanguage(userId);
            const subscribed = await isSubscribedToChannel(userId);
            if (subscribed) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: language === 'en' ? '✅ Subscribed successfully!' : '✅ تم التحقق من الاشتراك!',
                    show_alert: false
                });
                const keyboard = keyboards.getKeyboard('currencySelection', language);
                bot.sendMessage(chatId, getMessage('CURRENCY_SELECTION', language), keyboard);
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: language === 'en' ? '❌ You have not joined the channel yet!' : '❌ لم تشترك في القناة بعد!',
                    show_alert: true
                });
            }
            return;
        }

        // Check if user is admin (except for withdrawal confirmation buttons)
        const isWithdrawalButton = data.startsWith('confirm_cash_') ||
            data.startsWith('confirm_binance_') ||
            data === 'cancel_withdrawal';

        // Pending funds pagination - allowed for all users
        if (data.startsWith('pending_funds_page_')) {
            const page = parseInt(data.replace('pending_funds_page_', ''));
            await showPendingFunds(chatId, userId, await getUserLanguage(userId), page, messageId);
            return bot.answerCallbackQuery(callbackQuery.id);
        }

        if (!(await isAdmin(userId)) && !isWithdrawalButton) {
            return bot.answerCallbackQuery(callbackQuery.id, {
                text: 'غير مسموح / Not authorized',
                show_alert: true
            });
        }

        const language = await getUserLanguage(userId);

        if (data.startsWith('approve_email_')) {
            const accountId = data.replace('approve_email_', '');
            await handleEmailApproval(chatId, accountId, messageId, language, true);
        } else if (data.startsWith('reject_email_')) {
            const accountId = data.replace('reject_email_', '');
            await handleEmailApproval(chatId, accountId, messageId, language, false);
        } else if (data.startsWith('approve_gmail_')) {
            const accountId = data.replace('approve_gmail_', '');
            await handleGmailApproval(chatId, accountId, messageId, language, true);
        } else if (data.startsWith('reject_gmail_')) {
            const accountId = data.replace('reject_gmail_', '');
            await handleGmailApproval(chatId, accountId, messageId, language, false);
        } else if (data.startsWith('ban_user_')) {
            const targetUserId = data.replace('ban_user_', '');
            await handleUserBan(chatId, targetUserId, messageId, language, true);
        } else if (data.startsWith('unban_user_')) {
            const targetUserId = data.replace('unban_user_', '');
            await handleUserBan(chatId, targetUserId, messageId, language, false);
        } else if (data.startsWith('edit_balance_')) {
            const targetUserId = data.replace('edit_balance_', '');
            if (await isMainAdmin(userId)) {
                await handleBalanceEdit(chatId, targetUserId, language);
            } else {
                bot.answerCallbackQuery(callbackQuery.id, {
                    text: language === 'en' ? '❌ Only main admin can edit balance' : '❌ تعديل الرصيد للأدمن الرئيسي فقط',
                    show_alert: true
                });
                return;
            }
        } else if (data.startsWith('message_user_')) {
            const targetUserId = data.replace('message_user_', '');
            await handleUserMessage(chatId, targetUserId, language);
        } else if (data.startsWith('user_details_')) {
            const targetUserId = data.replace('user_details_', '');
            await handleUserDetails(chatId, targetUserId, messageId, language);
        } else if (data.startsWith('refresh_user_')) {
            const targetUserId = data.replace('refresh_user_', '');
            await handleUserRefresh(chatId, targetUserId, messageId, language);
        } else if (data.startsWith('delete_account_')) {
            const accountId = data.replace('delete_account_', '');
            await handleDeleteAccount(chatId, accountId, messageId, language);
        } else if (data.startsWith('accounts_page_')) {
            const page = parseInt(data.replace('accounts_page_', ''));
            await showAvailableAccounts(chatId, language, page);
        } else if (data.startsWith('gmail_page_')) {
            const page = parseInt(data.replace('gmail_page_', ''));
            await showPendingGmailAccounts(chatId, language, page);
        } else if (data.startsWith('email_page_')) {
            const page = parseInt(data.replace('email_page_', ''));
            await showPendingAccounts(chatId, language, page);
        } else if (data === 'page_info') {
            // Just acknowledge the callback, no action needed for page info button
            bot.answerCallbackQuery(callbackQuery.id, {
                text: language === 'en' ? 'Page information' : 'معلومات الصفحة',
                show_alert: false
            });
            return; // Don't call answerCallbackQuery again at the end
        } else if (data === 'delete_all_accounts_confirm') {
            await handleDeleteAllAccountsConfirm(chatId, messageId, language);
        } else if (data === 'delete_all_accounts_yes') {
            await handleDeleteAllAccounts(chatId, messageId, language);
        } else if (data === 'delete_all_accounts_no') {
            await handleDeleteAllAccountsCancel(chatId, messageId, language);
        } else if (data.startsWith('confirm_cash_')) {
            await handleCashWithdrawalConfirm(chatId, messageId, data, language);
        } else if (data.startsWith('confirm_binance_')) {
            await handleBinanceWithdrawalConfirm(chatId, messageId, data, language);
        } else if (data === 'cancel_withdrawal') {
            await handleWithdrawalCancel(chatId, messageId, language);
        } else if (data.startsWith('complete_withdrawal_')) {
            await handleWithdrawalCompletion(chatId, messageId, data, language);
        } else if (data.startsWith('return_withdrawal_')) {
            await handleWithdrawalReturn(chatId, messageId, data, language);
        } else if (data === 'toggle_email_tasks') {
            await handleToggleEmailTasks(chatId, messageId, language);
        } else if (data === 'toggle_gmail_tasks') {
            await handleToggleGmailTasks(chatId, messageId, language);
        } else if (data === 'bulk_approve_confirm') {
            await processBulkApproval(chatId, messageId, language);
        } else if (data === 'bulk_approve_cancel') {
            const cancelMessage = language === 'en' ?
                '❌ Bulk approval cancelled' :
                '❌ تم إلغاء القبول الجماعي';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data === 'bulk_reject_confirm') {
            await processBulkRejection(chatId, messageId, language);
        } else if (data === 'bulk_reject_cancel') {
            const cancelMessage = language === 'en' ?
                '🔙 Bulk rejection cancelled' :
                '🔙 تم إلغاء الرفض الجماعي';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data.startsWith('selective_approve_')) {
            await processSelectiveApprovalConfirm(chatId, messageId, data, language);
        } else if (data.startsWith('toggle_notifications_')) {
            const action = data.replace('toggle_notifications_', '');
            const newSetting = action === 'enable' ? 'true' : 'false';
            await db.setSetting('notify_users_new_accounts', newSetting);
            
            const statusText = action === 'enable' ? 
                (language === 'en' ? '✅ Enabled' : '✅ مفعل') : 
                (language === 'en' ? '❌ Disabled' : '❌ معطل');
            
            const successMessage = language === 'en' ?
                `✅ Notifications ${action === 'enable' ? 'enabled' : 'disabled'} successfully!\n\n📢 Status: ${statusText}\n\n💡 Users will ${action === 'enable' ? 'now' : 'no longer'} be notified when you add new accounts` :
                `✅ تم ${action === 'enable' ? 'تفعيل' : 'تعطيل'} الإشعارات بنجاح!\n\n📢 الحالة: ${statusText}\n\n💡 ${action === 'enable' ? 'سيتم' : 'لن يتم'} إشعار المستخدمين عند إضافة حسابات جديدة`;
            
            bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data === 'cancel_notification_toggle') {
            const cancelMessage = language === 'en' ?
                '🔙 Operation cancelled' :
                '🔙 تم إلغاء العملية';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data.startsWith('refresh_report_')) {
            const targetUserId = data.replace('refresh_report_', '');
            bot.editMessageText(language === 'en' ? '🔄 Refreshing report...' : '🔄 جاري تحديث التقرير...', {
                chat_id: chatId,
                message_id: messageId
            });
            await showFullUserReport(chatId, targetUserId, language);
        } else if (data === 'confirm_broadcast') {
            const userState = userStates.get(userId);
            if (userState && userState.state === 'broadcast_confirm') {
                const messageText = userState.message;
                userStates.delete(userId);
                
                // Edit message to show sending status
                const sendingMessage = language === 'en' ?
                    '📤 Sending broadcast message...' :
                    '📤 جاري إرسال الرسالة الجماعية...';
                bot.editMessageText(sendingMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });
                
                // Send the broadcast
                await sendBroadcastMessage(chatId, messageText, language);
                
                const messageKeyboard = keyboards.getKeyboard('messageKeyboard', language);
                const messageMenuMessage = language === 'en' ? '📨 Message Options:' : '📨 خيارات الرسائل:';
                bot.sendMessage(chatId, messageMenuMessage, messageKeyboard);
            }
        } else if (data === 'cancel_broadcast') {
            userStates.delete(userId);
            const cancelMessage = language === 'en' ?
                '❌ Broadcast cancelled' :
                '❌ تم إلغاء الرسالة الجماعية';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data === 'confirm_private_message') {
            const userState = userStates.get(userId);
            if (userState && userState.state === 'private_message_confirm') {
                const targetUserId = userState.targetUserId;
                const messageText = userState.message;
                userStates.delete(userId);
                
                // Edit message to show sending status
                const sendingMessage = language === 'en' ?
                    '📤 Sending message...' :
                    '📤 جاري إرسال الرسالة...';
                bot.editMessageText(sendingMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });
                
                // Send the private message
                await sendPrivateMessage(chatId, targetUserId, messageText, language);
                
                const messageKeyboard = keyboards.getKeyboard('messageKeyboard', language);
                const messageMenuMessage = language === 'en' ? '📨 Message Options:' : '📨 خيارات الرسائل:';
                bot.sendMessage(chatId, messageMenuMessage, messageKeyboard);
            }
        } else if (data === 'cancel_private_message') {
            userStates.delete(userId);
            const cancelMessage = language === 'en' ?
                '❌ Message cancelled' :
                '❌ تم إلغاء الرسالة';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data === 'confirm_notify_accounts') {
            console.log('Confirm notify accounts callback received');
            console.log('userId from callback:', userId);
            console.log('All userStates keys:', Array.from(userStates.keys()));
            const userState = userStates.get(userId);
            console.log('User state:', userState);
            if (userState && userState.startsWith('notify_new_accounts_confirm:')) {
                const count = parseInt(userState.split(':')[1]);
                userStates.delete(userId);
                
                // Edit message to show sending status
                const sendingMessage = language === 'en' ?
                    '📤 Sending notifications to all users...' :
                    '📤 جاري إرسال الإشعارات لجميع المستخدمين...';
                bot.editMessageText(sendingMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });
                
                // Send the notifications
                await notifyUsersAboutNewAccounts(count);
                
                const successMessage = language === 'en' ?
                    '✅ Notifications sent successfully!' :
                    '✅ تم إرسال الإشعارات بنجاح!';
                bot.sendMessage(chatId, successMessage);
            } else {
                console.log('User state not found or invalid');
            }
        } else if (data === 'cancel_notify_accounts') {
            userStates.delete(userId);
            const cancelMessage = language === 'en' ?
                '❌ Notifications cancelled' :
                '❌ تم إلغاء الإشعارات';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data === 'selective_approve_cancel') {
            const cancelMessage = language === 'en' ?
                '❌ Selective approval cancelled' :
                '❌ تم إلغاء القبول الانتقائي';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data.startsWith('selective_reject_')) {
            await processSelectiveRejectionConfirm(chatId, messageId, data, language);
        } else if (data === 'selective_reject_cancel') {
            const cancelMessage = language === 'en' ?
                '🔙 Selective rejection cancelled' :
                '🔙 تم إلغاء الرفض الانتقائي';
            bot.editMessageText(cancelMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (data === 'email_review_perm_enable' || data === 'email_review_perm_disable') {
            if (await isMainAdmin(userId)) {
                const newValue = data === 'email_review_perm_enable' ? 'true' : 'false';
                await db.setSetting('admins_email_review', newValue);
                const isEnabled = newValue === 'true';
                const statusText = isEnabled
                    ? (language === 'en' ? '✅ Enabled' : '✅ مفعّل')
                    : (language === 'en' ? '❌ Disabled' : '❌ معطّل');
                const msg = language === 'en'
                    ? `✅ Email review permission ${isEnabled ? 'enabled' : 'disabled'} successfully!\n\nStatus: ${statusText}\n\n${isEnabled ? 'Admins can now review emails.' : 'Only main admin can review emails now.'}`
                    : `✅ تم ${isEnabled ? 'تفعيل' : 'تعطيل'} صلاحية مراجعة الإيميلات بنجاح!\n\nالحالة: ${statusText}\n\n${isEnabled ? 'الأدمنز الآن يقدروا يراجعوا الإيميلات.' : 'بس الأدمن الرئيسي يقدر يراجع الإيميلات الآن.'}`;
                bot.editMessageText(msg, { chat_id: chatId, message_id: messageId });
            }

        } else if (data === 'withdrawal_perm_enable' || data === 'withdrawal_perm_disable') {
            if (await isMainAdmin(userId)) {
                const newValue = data === 'withdrawal_perm_enable' ? 'true' : 'false';
                await db.setSetting('admins_withdrawal_access', newValue);
                const isEnabled = newValue === 'true';
                const statusText = isEnabled
                    ? (language === 'en' ? '✅ Enabled' : '✅ مفعّل')
                    : (language === 'en' ? '❌ Disabled' : '❌ معطّل');
                const msg = language === 'en'
                    ? `✅ Withdrawal access ${isEnabled ? 'enabled' : 'disabled'} successfully!\n\nStatus: ${statusText}\n\n${isEnabled ? 'Admins can now access withdrawal requests.' : 'Only main admin can access withdrawal requests now.'}`
                    : `✅ تم ${isEnabled ? 'تفعيل' : 'تعطيل'} صلاحية طلبات السحب بنجاح!\n\nالحالة: ${statusText}\n\n${isEnabled ? 'الأدمنز الآن يقدروا يخشوا على طلبات السحب.' : 'بس الأدمن الرئيسي يقدر يخش على طلبات السحب الآن.'}`;
                bot.editMessageText(msg, { chat_id: chatId, message_id: messageId });
            }

        } else if (data === 'export_unapproved_emails') {
            // تصدير الإيميلات غير الموافق عليها كملف
            try {
                const pendingEmails = await db.getAllPendingEmails();
                const pendingFiltered = pendingEmails.filter(e => e.status === 'pending' || !e.status);
                const pendingGmails = await db.getPendingGmailAccounts();

                let fileContent = '';
                pendingFiltered.forEach(e => { fileContent += `${e.email}\n`; });
                pendingGmails.forEach(g => { fileContent += `${g.email}\n`; });

                const total = pendingFiltered.length + pendingGmails.length;
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const filename = `unapproved_${timestamp}.txt`;

                fs.writeFileSync(filename, fileContent, 'utf8');

                await bot.sendDocument(chatId, filename, {
                    caption: language === 'en'
                        ? `⏳ Unapproved Emails\n\n📧 Regular: ${pendingFiltered.length}\n📱 Gmail: ${pendingGmails.length}\n📊 Total: ${total}`
                        : `⏳ الإيميلات غير الموافق عليها\n\n📧 عادية: ${pendingFiltered.length}\n📱 جيميل: ${pendingGmails.length}\n📊 الإجمالي: ${total}`
                });

                fs.unlinkSync(filename);
            } catch (err) {
                console.error('Error exporting unapproved:', err);
                bot.sendMessage(chatId, language === 'en' ? '❌ Export failed' : '❌ فشل التصدير');
            }

        } else if (data === 'export_nonexported_emails') {
            // تصدير الإيميلات غير المصدرة كملف (بدون تغيير حالة exported)
            try {
                const nonExportedEmails = await db.getNonExportedPendingEmails();
                const nonExportedGmails = await db.getNonExportedPendingGmails();

                let fileContent = '';
                nonExportedEmails.forEach(e => { fileContent += `${e.email}\n`; });
                nonExportedGmails.forEach(g => { fileContent += `${g.email}\n`; });

                const total = nonExportedEmails.length + nonExportedGmails.length;
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                const filename = `nonexported_${timestamp}.txt`;

                fs.writeFileSync(filename, fileContent, 'utf8');

                await bot.sendDocument(chatId, filename, {
                    caption: language === 'en'
                        ? `📦 Non-Exported Emails\n\n📧 Regular: ${nonExportedEmails.length}\n📱 Gmail: ${nonExportedGmails.length}\n📊 Total: ${total}\n\n⚠️ Export status NOT changed`
                        : `📦 الإيميلات غير المصدرة\n\n📧 عادية: ${nonExportedEmails.length}\n📱 جيميل: ${nonExportedGmails.length}\n📊 الإجمالي: ${total}\n\n⚠️ لم يتم تغيير حالة التصدير`
                });

                fs.unlinkSync(filename);
            } catch (err) {
                console.error('Error exporting non-exported:', err);
                bot.sendMessage(chatId, language === 'en' ? '❌ Export failed' : '❌ فشل التصدير');
            }

        } else if (data === 'set_verify_method_location' || data === 'set_verify_method_phone') {
            const newMethod = data === 'set_verify_method_phone' ? 'phone' : 'location';
            await db.setSetting('country_verification_method', newMethod);

            const methodName = language === 'en'
                ? (newMethod === 'phone' ? '📱 Phone Number' : '📍 Location')
                : (newMethod === 'phone' ? '📱 رقم الهاتف' : '📍 الموقع');

            const successMsg = language === 'en'
                ? `✅ Verification method changed to: ${methodName}\n\nNew users will now be asked to verify via ${newMethod === 'phone' ? 'phone number' : 'location'}.`
                : `✅ تم تغيير طريقة التحقق إلى: ${methodName}\n\nالمستخدمون الجدد سيُطلب منهم التحقق عبر ${newMethod === 'phone' ? 'رقم الهاتف' : 'الموقع'} من الآن.`;

            bot.editMessageText(successMsg, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Answer the callback query to remove loading state
        bot.answerCallbackQuery(callbackQuery.id);

    } catch (error) {
        console.error('Error handling callback query:', error);
        bot.answerCallbackQuery(callbackQuery.id, {
            text: 'حدث خطأ / Error occurred',
            show_alert: true
        });
    } finally {
        // حرر الـ lock فوراً بعد الانتهاء
        processingCallbacks.delete(lockKey);
    }
});

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

bot.on('error', (error) => {
    console.error('Bot error:', error);
});

// Graceful shutdown - upload final backup before exit
async function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] 🛑 استلام إشارة ${signal} - جاري رفع آخر نسخة احتياطية...`);
    try {
        const { uploadDatabase } = require('./github-backup');
        await uploadDatabase();
        console.log('[Shutdown] ✅ تم رفع آخر نسخة احتياطية بنجاح');
    } catch (err) {
        console.error('[Shutdown] ❌ فشل رفع النسخة الاحتياطية:', err.message);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// عرض وتبديل طريقة التحقق من الدولة
async function showVerificationMethodMenu(chatId, language) {
    const current = await db.getSetting('country_verification_method') || 'location';

    const locationStatus = current === 'location' ? '✅' : '⬜';
    const phoneStatus    = current === 'phone'    ? '✅' : '⬜';

    const message = language === 'en'
        ? `🔄 *Country Verification Method*\n\nCurrent method: ${current === 'phone' ? '📱 Phone Number' : '📍 Location'}\n\n${locationStatus} 📍 Location — user shares GPS location\n${phoneStatus} 📱 Phone Number — user sends number with country code\n\nChoose the method:`
        : `🔄 *طريقة التحقق من الدولة*\n\nالطريقة الحالية: ${current === 'phone' ? '📱 رقم الهاتف' : '📍 الموقع'}\n\n${locationStatus} 📍 الموقع — المستخدم يشارك موقع GPS\n${phoneStatus} 📱 رقم الهاتف — المستخدم يبعت رقمه مع كود الدولة\n\nاختر الطريقة:`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `${locationStatus} 📍 ${language === 'en' ? 'Location' : 'الموقع'}`,     callback_data: 'set_verify_method_location' },
                    { text: `${phoneStatus} 📱 ${language === 'en' ? 'Phone Number' : 'رقم الهاتف'}`, callback_data: 'set_verify_method_phone' }
                ]
            ]
        }
    };

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
}

// معالجة إدخال رقم الهاتف للتحقق من الدولة
async function handlePhoneCountryVerification(chatId, userId, text, language) {
    const countryCode = getCountryFromPhone(text);

    if (!countryCode) {
        const msg = language === 'en'
            ? '❌ Could not detect your country from this number.\n\n💡 Make sure to include the country code.\n📝 Example: +201234567890 or 00201234567890\n\nTry again:'
            : '❌ لم نتمكن من تحديد دولتك من هذا الرقم.\n\n💡 تأكد من تضمين كود الدولة.\n📝 مثال: +201234567890 أو 00201234567890\n\nحاول مرة أخرى:';
        return bot.sendMessage(chatId, msg);
    }

    // حفظ الدولة
    userStates.delete(userId);
    await db.setUserCountry(userId, countryCode);

    const countryEntry = COUNTRIES_LIST.find(c => c.code === countryCode);
    const countryName = countryEntry ? countryEntry.name.split(' / ')[1] || countryEntry.name : countryCode;

    const successMsg = language === 'en'
        ? `✅ Your country has been recorded: ${countryName}\n\nWelcome! You can now use the bot.`
        : `✅ تم تسجيل دولتك: ${countryName}\n\nأهلاً! يمكنك الآن استخدام البوت.`;
    await bot.sendMessage(chatId, successMsg);

    const keyboard = keyboards.getKeyboard('userKeyboard', language);
    await bot.sendMessage(chatId, getMessage('WELCOME', language), keyboard);
}

// ========================
// إدارة الدول المطلوبة
// ========================

// عرض شاشة الدول مع الأرقام وعلامات الصح
async function showAllowedCountriesMenu(chatId, userId, language) {
    const allowedCountries = await db.getAllowedCountries();

    let message = language === 'en'
        ? `🌍 *Allowed Countries for Gmail Task*\n\n✅ = allowed | empty = not allowed\n\n`
        : `🌍 *الدول المطلوبة لمهمة الجيميل*\n\n✅ = مسموحة | فارغ = غير مسموحة\n\n`;

    // نعرض الدول على شكل صفحات (50 دولة لكل رسالة)
    const CHUNK = 50;
    const totalPages = Math.ceil(COUNTRIES_LIST.length / CHUNK);

    // حفظ الـ state للأدمن عشان يقدر يكتب رقم
    userStates.set(userId, 'toggle_country');

    // ابعت أول صفحة
    let page1 = message;
    for (let i = 0; i < Math.min(CHUNK, COUNTRIES_LIST.length); i++) {
        const c = COUNTRIES_LIST[i];
        const check = allowedCountries.includes(c.code) ? '✅' : '⬜';
        page1 += `${check} ${i + 1}. ${c.name}\n`;
    }

    if (COUNTRIES_LIST.length > CHUNK) {
        page1 += language === 'en' ? `\n_(Page 1/${totalPages})_` : `\n_(صفحة 1/${totalPages})_`;
    }

    await bot.sendMessage(chatId, page1, { parse_mode: 'Markdown' });

    // باقي الصفحات
    for (let p = 1; p < totalPages; p++) {
        let pageMsg = '';
        const start = p * CHUNK;
        const end = Math.min(start + CHUNK, COUNTRIES_LIST.length);
        for (let i = start; i < end; i++) {
            const c = COUNTRIES_LIST[i];
            const check = allowedCountries.includes(c.code) ? '✅' : '⬜';
            pageMsg += `${check} ${i + 1}. ${c.name}\n`;
        }
        pageMsg += language === 'en' ? `\n_(Page ${p + 1}/${totalPages})_` : `\n_(صفحة ${p + 1}/${totalPages})_`;
        await bot.sendMessage(chatId, pageMsg, { parse_mode: 'Markdown' });
    }

    // رسالة التعليمات
    const currentAllowed = allowedCountries.length > 0
        ? allowedCountries.map(code => {
            const c = COUNTRIES_LIST.find(x => x.code === code);
            return c ? c.name : code;
          }).join('\n')
        : (language === 'en' ? 'No restrictions (all countries allowed)' : 'لا قيود (جميع الدول مسموحة)');

    const instructionMsg = language === 'en'
        ? `📝 *Instructions:*\n• Send a number to toggle that country (✅/⬜)\n• Send multiple numbers separated by spaces: \`1 5 23\`\n• Send \`clear\` to remove all restrictions\n\n*Currently allowed:*\n${currentAllowed}`
        : `📝 *التعليمات:*\n• أرسل رقم لتفعيل/إلغاء الدولة (✅/⬜)\n• أرسل أرقام متعددة مفصولة بمسافة: \`1 5 23\`\n• أرسل \`clear\` لإزالة جميع القيود\n\n*الدول المسموحة حالياً:*\n${currentAllowed}`;

    const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
    await bot.sendMessage(chatId, instructionMsg, { parse_mode: 'Markdown', ...cancelKeyboard });
}

// معالجة إدخال رقم الدولة من الأدمن
async function handleCountryToggle(chatId, userId, text, language) {
    // clear = شيل كل القيود
    if (text.trim().toLowerCase() === 'clear') {
        await db.setAllowedCountries([]);
        userStates.delete(userId);
        const msg = language === 'en'
            ? '✅ All country restrictions removed.\n\nGmail task is now available for ALL countries.'
            : '✅ تم إزالة جميع قيود الدول.\n\nمهمة الجيميل متاحة الآن لجميع الدول.';
        const adminKeyboard = keyboards.getKeyboard('taskControl', language);
        await bot.sendMessage(chatId, msg, adminKeyboard);
        return;
    }

    // حلل الأرقام المدخلة
    const parts = text.trim().split(/\s+/);
    const nums = parts.map(p => parseInt(p)).filter(n => !isNaN(n) && n >= 1 && n <= COUNTRIES_LIST.length);

    if (nums.length === 0) {
        const msg = language === 'en'
            ? '❌ Invalid input. Send a number between 1 and ' + COUNTRIES_LIST.length
            : '❌ إدخال غير صحيح. أرسل رقم بين 1 و' + COUNTRIES_LIST.length;
        return bot.sendMessage(chatId, msg);
    }

    // Toggle كل رقم
    let allowedCountries = await db.getAllowedCountries();
    const toggled = [];

    for (const num of nums) {
        const country = COUNTRIES_LIST[num - 1];
        const idx = allowedCountries.indexOf(country.code);
        if (idx === -1) {
            allowedCountries.push(country.code);
            toggled.push(`✅ ${num}. ${country.name}`);
        } else {
            allowedCountries.splice(idx, 1);
            toggled.push(`⬜ ${num}. ${country.name}`);
        }
    }

    await db.setAllowedCountries(allowedCountries);

    // رد بالتغييرات
    const toggledText = toggled.join('\n');
    const currentAllowed = allowedCountries.length > 0
        ? allowedCountries.map(code => {
            const c = COUNTRIES_LIST.find(x => x.code === code);
            const idx = COUNTRIES_LIST.indexOf(c) + 1;
            return `✅ ${idx}. ${c ? c.name : code}`;
          }).join('\n')
        : (language === 'en' ? 'No restrictions (all countries allowed)' : 'لا قيود (جميع الدول مسموحة)');

    const msg = language === 'en'
        ? `🔄 *Updated:*\n${toggledText}\n\n📋 *Currently allowed countries:*\n${currentAllowed}\n\n💡 Send another number to continue, or press Cancel to finish.`
        : `🔄 *تم التحديث:*\n${toggledText}\n\n📋 *الدول المسموحة حالياً:*\n${currentAllowed}\n\n💡 أرسل رقم آخر للمتابعة، أو اضغط إلغاء للانتهاء.`;

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// Handle delete all accounts confirmation
async function handleDeleteAllAccountsConfirm(chatId, messageId, language) {
    try {
        const totalCount = await db.getAvailableAccountsCount();

        if (totalCount === 0) {
            const message = language === 'en' ?
                '📦 No accounts to delete' :
                '📦 لا توجد يوزرات للحذف';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        const confirmMessage = language === 'en' ?
            `⚠️ DELETE ALL ACCOUNTS CONFIRMATION\n\n🗑️ You are about to delete ALL ${totalCount} available accounts!\n\n⚠️ This action CANNOT be undone!\n⚠️ All accounts will be permanently removed!\n⚠️ Users will not be able to get new tasks until you add new accounts!\n\n❓ Are you absolutely sure you want to continue?` :
            `⚠️ تأكيد حذف جميع اليوزرات\n\n🗑️ أنت على وشك حذف جميع الـ ${totalCount} يوزر المتاح!\n\n⚠️ هذا الإجراء لا يمكن التراجع عنه!\n⚠️ سيتم حذف جميع اليوزرات نهائياً!\n⚠️ لن يتمكن المستخدمون من الحصول على مهام جديدة حتى تضيف يوزرات جديدة!\n\n❓ هل أنت متأكد تماماً من المتابعة؟`;

        const confirmKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '✅ YES, DELETE ALL' : '✅ نعم، احذف الكل',
                            callback_data: 'delete_all_accounts_yes'
                        },
                        {
                            text: language === 'en' ? '❌ NO, CANCEL' : '❌ لا، إلغاء',
                            callback_data: 'delete_all_accounts_no'
                        }
                    ]
                ]
            }
        };

        bot.editMessageText(confirmMessage, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: confirmKeyboard.reply_markup
        });

    } catch (error) {
        console.error('Error showing delete all confirmation:', error);
        const errorMessage = language === 'en' ?
            '❌ Error showing confirmation' :
            '❌ حدث خطأ في عرض التأكيد';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle delete all accounts execution
async function handleDeleteAllAccounts(chatId, messageId, language) {
    try {
        const totalCount = await db.getAvailableAccountsCount();

        if (totalCount === 0) {
            const message = language === 'en' ?
                '📦 No accounts to delete' :
                '📦 لا توجد يوزرات للحذف';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Delete all accounts
        const deletedCount = await db.deleteAllAvailableAccounts();

        const successMessage = language === 'en' ?
            `🗑️ ALL ACCOUNTS DELETED SUCCESSFULLY!\n\n📊 Deleted Accounts: ${deletedCount}\n📅 Deletion Date: ${new Date().toLocaleString()}\n\n⚠️ All available accounts have been permanently removed!\n💡 You can add new accounts using "➕ Add Accounts" button\n\n🔄 The account pool is now empty - users cannot get new tasks until you add accounts.` :
            `🗑️ تم حذف جميع اليوزرات بنجاح!\n\n📊 اليوزرات المحذوفة: ${deletedCount}\n📅 تاريخ الحذف: ${new Date().toLocaleString()}\n\n⚠️ تم حذف جميع اليوزرات المتاحة نهائياً!\n💡 يمكنك إضافة يوزرات جديدة باستخدام زر "➕ إضافة يوزرات"\n\n🔄 مجموعة اليوزرات فارغة الآن - لن يتمكن المستخدمون من الحصول على مهام جديدة حتى تضيف يوزرات.`;

        bot.editMessageText(successMessage, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error deleting all accounts:', error);
        const errorMessage = language === 'en' ?
            '❌ Error deleting all accounts' :
            '❌ حدث خطأ في حذف جميع اليوزرات';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle delete all accounts cancellation
async function handleDeleteAllAccountsCancel(chatId, messageId, language) {
    try {
        const cancelMessage = language === 'en' ?
            '✅ Operation Cancelled\n\n💡 No accounts were deleted.\nAll accounts remain safe and available.' :
            '✅ تم إلغاء العملية\n\n💡 لم يتم حذف أي يوزرات.\nجميع اليوزرات آمنة ومتاحة.';

        bot.editMessageText(cancelMessage, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error cancelling delete all:', error);
        const errorMessage = language === 'en' ?
            '❌ Error cancelling operation' :
            '❌ حدث خطأ في إلغاء العملية';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Process Payeer withdrawal with wallet validation
async function processPayeerWithdrawal(chatId, userId, walletAddress, amount, language) {
    try {
        // Validate Payeer wallet format: P + numbers (any length)
        const payeerRegex = /^P\d+$/;
        if (!payeerRegex.test(walletAddress)) {
            const message = language === 'en' ?
                `❌ Invalid Payeer wallet format!\n\n📋 Required format: P + numbers\n• Must start with P (capital letter)\n• Followed by numbers only\n\n📝 Examples:\n• P12345678\n• P1234567890\n• P123456\n\nPlease send correct wallet address or press Cancel:` :
                `❌ صيغة محفظة Payeer غير صحيحة!\n\n📋 الصيغة المطلوبة: P + أرقام\n• يجب أن تبدأ بـ P (حرف كبير)\n• متبوعة بأرقام فقط\n\n📝 أمثلة:\n• P12345678\n• P1234567890\n• P123456\n\nيرجى إرسال عنوان المحفظة الصحيح أو اضغط إلغاء:`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Show confirmation message
        const confirmMessage = language === 'en' ?
            `💳 Confirm Payeer Withdrawal\n\n💰 Amount: $${amount.toFixed(2)}\n🏦 Payeer Wallet: ${walletAddress}\n\n⚠️ Please verify your wallet address carefully!\nOnce confirmed, this cannot be changed.\n\n✅ Is this information correct?` :
            `💳 تأكيد سحب Payeer\n\n💰 المبلغ: $${amount.toFixed(2)}\n🏦 محفظة Payeer: ${walletAddress}\n\n⚠️ يرجى التحقق من عنوان المحفظة بعناية!\nبعد التأكيد، لا يمكن تغيير هذه المعلومات.\n\n✅ هل هذه المعلومات صحيحة؟`;

        const confirmKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '✅ Confirm Withdrawal' : '✅ تأكيد السحب',
                            callback_data: `confirm_payeer_${userId}_${amount}_${walletAddress}`
                        }
                    ],
                    [
                        {
                            text: language === 'en' ? '❌ Cancel' : '❌ إلغاء',
                            callback_data: 'cancel_withdrawal'
                        }
                    ]
                ]
            }
        };

        userStates.delete(userId);
        bot.sendMessage(chatId, confirmMessage, confirmKeyboard);

    } catch (error) {
        console.error('Error processing Payeer withdrawal:', error);
        const message = language === 'en' ?
            '❌ Error processing withdrawal request' :
            '❌ حدث خطأ في معالجة طلب السحب';
        bot.sendMessage(chatId, message);
    }
}

// Process Cash withdrawal with wallet validation
async function processCashWithdrawal(chatId, userId, walletNumber, amount, language) {
    try {
        // Validate cash wallet format: 11 digits
        const cashRegex = /^\d{11}$/;
        if (!cashRegex.test(walletNumber)) {
            const message = language === 'en' ?
                `❌ Invalid cash wallet number!\n\n📋 Required format: 11 digits\n• Must be exactly 11 numbers\n• No spaces or special characters\n\n📝 Example: 01234567890\n\nPlease send correct wallet number or press Cancel:` :
                `❌ رقم محفظة الكاش غير صحيح!\n\n📋 الصيغة المطلوبة: 11 رقم\n• يجب أن يكون 11 رقم بالضبط\n• بدون مسافات أو رموز خاصة\n\n📝 مثال: 01234567890\n\nيرجى إرسال رقم المحفظة الصحيح أو اضغط إلغاء:`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Show confirmation message
        const confirmMessage = language === 'en' ?
            `💳 Confirm Cash Wallet Withdrawal\n\n💰 Amount: ${formatBalance(amount, 'EGP')}\n📱 Cash Wallet: ${walletNumber}\n\n⚠️ Please verify your wallet number carefully!\nOnce confirmed, this cannot be changed.\n\n✅ Is this information correct?` :
            `💳 تأكيد سحب محفظة الكاش\n\n💰 المبلغ: ${formatBalance(amount, 'EGP')}\n📱 محفظة الكاش: ${walletNumber}\n\n⚠️ يرجى التحقق من رقم المحفظة بعناية!\nبعد التأكيد، لا يمكن تغيير هذه المعلومات.\n\n✅ هل هذه المعلومات صحيحة؟`;

        const confirmKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '✅ Confirm Withdrawal' : '✅ تأكيد السحب',
                            callback_data: `confirm_cash_${userId}_${amount}_${walletNumber}`
                        }
                    ],
                    [
                        {
                            text: language === 'en' ? '❌ Cancel' : '❌ إلغاء',
                            callback_data: 'cancel_withdrawal'
                        }
                    ]
                ]
            }
        };

        userStates.delete(userId);
        bot.sendMessage(chatId, confirmMessage, confirmKeyboard);

    } catch (error) {
        console.error('Error processing cash withdrawal:', error);
        const message = language === 'en' ?
            '❌ Error processing withdrawal request' :
            '❌ حدث خطأ في معالجة طلب السحب';
        bot.sendMessage(chatId, message);
    }
}

// Handle Payeer withdrawal confirmation
async function handlePayeerWithdrawalConfirm(chatId, messageId, data, language) {
    try {
        // Parse callback data: confirm_payeer_userId_amount_walletAddress
        const parts = data.split('_');
        const userId = parts[2];
        const amount = parseFloat(parts[3]);
        const walletAddress = parts.slice(4).join('_'); // In case wallet has underscores

        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // DO NOT deduct balance here - it will be deducted when admin completes the withdrawal
        // This prevents double deduction

        // Save withdrawal request
        const method = 'Payeer';
        const details = `Payeer Wallet: ${walletAddress}`;
        const requestId = await db.addWithdrawalRequest(userId, amount, 'USD', method, details);

        // Notify admin
        const adminMessage = language === 'en' ?
            `💳 New Payeer withdrawal request!\n\n👤 User: ${user.username || 'Unknown'}\n🆔 ID: \`${userId}\`\n💰 Amount: ${amount.toFixed(2)}\n🏦 Payeer Wallet: ${walletAddress}\n💰 Current balance: ${(user.balance_usd || 0).toFixed(2)}\n📋 Request ID: #${requestId}` :
            `💳 طلب سحب Payeer جديد!\n\n👤 المستخدم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${userId}\`\n💰 المبلغ: ${amount.toFixed(2)}\n🏦 محفظة Payeer: ${walletAddress}\n💰 الرصيد الحالي: ${(user.balance_usd || 0).toFixed(2)}\n📋 رقم الطلب: #${requestId}`;

        bot.sendMessage(config.ADMIN_ID, adminMessage, { parse_mode: 'Markdown' });

        const message = language === 'en' ?
            `✅ Payeer withdrawal request confirmed!\n\n💰 Amount: ${amount.toFixed(2)}\n🏦 Payeer Wallet: ${walletAddress}\n📋 Request ID: #${requestId}\n\n⏳ Your request will be processed soon\n💡 You will be notified once completed\n\n⚠️ Your balance will be deducted after admin approval` :
            `✅ تم تأكيد طلب سحب Payeer!\n\n💰 المبلغ: ${amount.toFixed(2)}\n🏦 محفظة Payeer: ${walletAddress}\n📋 رقم الطلب: #${requestId}\n\n⏳ سيتم معالجة طلبك قريباً\n💡 سيتم إشعارك عند الانتهاء\n\n⚠️ سيتم خصم الرصيد بعد موافقة الأدمن`;

        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error confirming Payeer withdrawal:', error);
        const errorMessage = language === 'en' ?
            '❌ Error confirming withdrawal' :
            '❌ حدث خطأ في تأكيد السحب';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}


// Handle Cash withdrawal confirmation
async function handleCashWithdrawalConfirm(chatId, messageId, data, language) {
    try {
        // Parse callback data: confirm_cash_userId_amount_walletNumber
        const parts = data.split('_');
        const userId = parts[2];
        const amount = parseFloat(parts[3]);
        const walletNumber = parts[4];

        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Deduct balance immediately when user confirms withdrawal
        const currentBalance = user.balance || 0;
        if (currentBalance < amount) {
            const message = language === 'en' ?
                `❌ Insufficient balance!\n\n💰 Current balance: ${formatBalance(currentBalance, 'EGP')}\n💰 Requested amount: ${formatBalance(amount, 'EGP')}` :
                `❌ رصيد غير كافٍ!\n\n💰 الرصيد الحالي: ${formatBalance(currentBalance, 'EGP')}\n💰 المبلغ المطلوب: ${formatBalance(amount, 'EGP')}`;
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        const newBalance = currentBalance - amount;
        await db.setUserBalance(userId, newBalance);

        // Save withdrawal request
        const method = 'Cash Wallet';
        const details = walletNumber; // store number only
        const requestId = await db.addWithdrawalRequest(userId, amount, 'EGP', method, details);

        // Notify admin
        const adminMessage = language === 'en' ?
            `💳 New cash wallet withdrawal request!\n\n👤 User: ${user.username || 'Unknown'}\n🆔 ID: \`${userId}\`\n💰 Amount: ${formatBalance(amount, 'EGP')}\n📱 Cash Wallet: \`${walletNumber}\`\n💰 New balance: ${formatBalance(newBalance, 'EGP')}\n📋 Request ID: #${requestId}` :
            `💳 طلب سحب محفظة كاش جديد!\n\n👤 المستخدم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${userId}\`\n💰 المبلغ: ${formatBalance(amount, 'EGP')}\n📱 محفظة الكاش: \`${walletNumber}\`\n💰 الرصيد الجديد: ${formatBalance(newBalance, 'EGP')}\n📋 رقم الطلب: #${requestId}`;

        bot.sendMessage(config.ADMIN_ID, adminMessage, { parse_mode: 'Markdown' });

        const message = language === 'en' ?
            `✅ Cash wallet withdrawal request confirmed!\n\n💰 Amount: ${formatBalance(amount, 'EGP')}\n📱 Cash Wallet: \`${walletNumber}\`\n📋 Request ID: #${requestId}\n💰 New balance: ${formatBalance(newBalance, 'EGP')}\n\n⏳ Your request will be processed soon\n💡 You will be notified once completed` :
            `✅ تم تأكيد طلب سحب محفظة الكاش!\n\n💰 المبلغ: ${formatBalance(amount, 'EGP')}\n📱 محفظة الكاش: \`${walletNumber}\`\n📋 رقم الطلب: #${requestId}\n💰 الرصيد الجديد: ${formatBalance(newBalance, 'EGP')}\n\n⏳ سيتم معالجة طلبك قريباً\n💡 سيتم إشعارك عند الانتهاء`;

        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error('Error confirming cash withdrawal:', error);
        const errorMessage = language === 'en' ?
            '❌ Error confirming withdrawal' :
            '❌ حدث خطأ في تأكيد السحب';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle withdrawal return by admin (إرجاع الرصيد للمستخدم وحذف الطلب)
async function handleWithdrawalReturn(chatId, messageId, data, language) {
    try {
        const requestId = data.replace('return_withdrawal_', '');

        const request = await db.getWithdrawalRequest(requestId);
        if (!request) {
            return bot.editMessageText(
                language === 'en' ? '❌ Withdrawal request not found' : '❌ طلب السحب غير موجود',
                { chat_id: chatId, message_id: messageId }
            );
        }

        if (request.status !== 'pending') {
            return bot.editMessageText(
                language === 'en' ? '❌ This request has already been processed' : '❌ تم معالجة هذا الطلب مسبقاً',
                { chat_id: chatId, message_id: messageId }
            );
        }

        const user = await db.getUser(request.user_id);
        if (!user) {
            return bot.editMessageText(
                language === 'en' ? '❌ User not found' : '❌ المستخدم غير موجود',
                { chat_id: chatId, message_id: messageId }
            );
        }

        // إرجاع الرصيد للمستخدم
        if (request.currency === 'USD') {
            const newBalance = (parseFloat(user.balance_usd) || 0) + parseFloat(request.amount);
            await db.setUserUSDBalance(request.user_id, newBalance);
        } else {
            const newBalance = (parseFloat(user.balance) || 0) + parseFloat(request.amount);
            await db.setUserBalance(request.user_id, newBalance);
        }

        // تغيير حالة الطلب لـ cancelled
        await db.db.run(
            'UPDATE withdrawal_requests SET status = "cancelled", processed_at = datetime("now") WHERE id = ?',
            [requestId]
        );

        // تحديث رسالة الأدمن
        const adminMsg = language === 'en'
            ? `↩️ Withdrawal Returned!\n\n💳 Request #${requestId}\n👤 User: ${user?.username || 'Unknown'}\n🆔 User ID: ${request.user_id}\n💰 Amount: ${formatBalance(request.amount, request.currency)}\n💳 Method: ${request.method}\n📋 Details: ${extractWalletNumber(request.details)}\n\n✅ Balance refunded to user`
            : `↩️ تم إرجاع طلب السحب!\n\n💳 طلب رقم #${requestId}\n👤 المستخدم: ${user?.username || 'غير محدد'}\n🆔 آيدي المستخدم: ${request.user_id}\n💰 المبلغ: ${formatBalance(request.amount, request.currency)}\n💳 الطريقة: ${request.method}\n📋 التفاصيل: ${extractWalletNumber(request.details)}\n\n✅ تم إرجاع الرصيد للمستخدم`;

        bot.editMessageText(adminMsg, { chat_id: chatId, message_id: messageId });

        // إشعار المستخدم
        const userLanguage = await getUserLanguage(request.user_id);
        const userMsg = userLanguage === 'en'
            ? `↩️ Your withdrawal request has been returned.\n\n💰 Amount: ${formatBalance(request.amount, request.currency)}\n📋 Request ID: #${requestId}\n\n✅ Your balance has been refunded.\n💡 You can submit a new withdrawal request anytime.`
            : `↩️ تم إرجاع طلب السحب الخاص بك.\n\n💰 المبلغ: ${formatBalance(request.amount, request.currency)}\n📋 رقم الطلب: #${requestId}\n\n✅ تم إرجاع رصيدك.\n💡 يمكنك تقديم طلب سحب جديد في أي وقت.`;

        await safeSendMessage(request.user_id, userMsg);

    } catch (error) {
        console.error('Error returning withdrawal:', error);
        bot.editMessageText(
            language === 'en' ? '❌ Error returning withdrawal' : '❌ حدث خطأ في إرجاع الطلب',
            { chat_id: chatId, message_id: messageId }
        );
    }
}

// Handle withdrawal cancellation
async function handleWithdrawalCancel(chatId, messageId, language) {
    try {
        const message = language === 'en' ?
            '❌ Withdrawal request cancelled\n\n💡 You can start a new withdrawal request anytime from the main menu.' :
            '❌ تم إلغاء طلب السحب\n\n💡 يمكنك بدء طلب سحب جديد في أي وقت من القائمة الرئيسية.';

        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error cancelling withdrawal:', error);
        const errorMessage = language === 'en' ?
            '❌ Error cancelling withdrawal' :
            '❌ حدث خطأ في إلغاء السحب';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle withdrawal completion by admin
async function handleWithdrawalCompletion(chatId, messageId, data, language) {
    try {
        // Parse callback data: complete_withdrawal_requestId
        const requestId = data.replace('complete_withdrawal_', '');

        // Get withdrawal request details
        const request = await db.getWithdrawalRequest(requestId);
        if (!request) {
            const message = language === 'en' ?
                '❌ Withdrawal request not found' :
                '❌ طلب السحب غير موجود';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        if (request.status !== 'pending') {
            const message = language === 'en' ?
                '❌ This withdrawal request has already been processed' :
                '❌ تم معالجة طلب السحب هذا مسبقاً';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Get user
        const user = await db.getUser(request.user_id);
        if (!user) {
            const message = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Balance was already deducted when user confirmed withdrawal
        // Just update withdrawal status to completed
        await db.completeWithdrawalRequest(requestId);

        // Update admin message
        const adminMessage = language === 'en' ?
            `✅ Withdrawal Completed!\n\n💳 Request #${requestId}\n👤 User: ${user?.username || 'Unknown'}\n🆔 User ID: ${request.user_id}\n💰 Amount: ${formatBalance(request.amount, request.currency)}\n💳 Method: ${request.method}\n📋 Details: ${request.details}\n📅 Completed: ${new Date().toLocaleString()}\n\n✅ Status: Payment Completed` :
            `✅ تم إكمال السحب!\n\n💳 طلب رقم #${requestId}\n👤 المستخدم: ${user?.username || 'غير محدد'}\n🆔 آيدي المستخدم: ${request.user_id}\n💰 المبلغ: ${formatBalance(request.amount, request.currency)}\n💳 الطريقة: ${request.method}\n📋 التفاصيل: ${request.details}\n📅 تاريخ الإكمال: ${new Date().toLocaleString()}\n\n✅ الحالة: تم الدفع`;

        bot.editMessageText(adminMessage, {
            chat_id: chatId,
            message_id: messageId
        });

        // Notify user about successful withdrawal
        try {
            const userLanguage = await getUserLanguage(request.user_id);
            const userMessage = userLanguage === 'en' ?
                `✅ Withdrawal Completed Successfully!\n\n💰 Amount: ${formatBalance(request.amount, request.currency)}\n💳 Method: ${request.method}\n📋 Details: ${request.details}\n📅 Completed: ${new Date().toLocaleString()}\n\n💡 Please check your wallet!\nThe payment has been sent to your account.\n\n📋 Request ID: #${requestId}` :
                `✅ تم إكمال السحب بنجاح!\n\n💰 المبلغ: ${formatBalance(request.amount, request.currency)}\n💳 الطريقة: ${request.method}\n📋 التفاصيل: ${request.details}\n📅 تاريخ الإكمال: ${new Date().toLocaleString()}\n\n💡 تأكد من محفظتك!\nتم إرسال الدفعة إلى حسابك.\n\n📋 رقم الطلب: #${requestId}`;

            await safeSendMessage(request.user_id, userMessage);
        } catch (error) {
            console.error('Failed to notify user about withdrawal completion:', error);
        }

        // Notify group about successful withdrawal
        try {
            const groupId = process.env.WITHDRAWAL_GROUP_ID || config.WITHDRAWAL_GROUP_ID;
            if (groupId) {
                const username = user?.username ? `@${user.username}` : `User ${request.user_id}`;
                const completedAt = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
                const groupMessage =
                    `🎉 تم صرف مكافأة جديدة!\n\n` +
                    `👤 المستخدم: ${username}\n` +
                    `💰 القيمة: ${formatBalance(request.amount, request.currency)}\n` +
                    `📅 الوقت: ${completedAt}\n\n` +
                    `🙏 شكراً لأنك تعمل معنا!\nاستمر في العمل وستحصل على المزيد 💪\n\n` +
                    `🤖 @SellGmailsearnmoney_bot`;
                await bot.sendMessage(groupId, groupMessage);
            }
        } catch (error) {
            console.error('Failed to notify group about withdrawal:', error);
        }

    } catch (error) {
        console.error('Error completing withdrawal:', error);
        const errorMessage = language === 'en' ?
            '❌ Error completing withdrawal' :
            '❌ حدث خطأ في إكمال السحب';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle withdrawal method selection for USD
async function handleWithdrawalMethodSelection(chatId, userId, text, amount, language) {
    try {
        if (text === '🏦 Payeer') {
            // Ask for Payeer wallet address
            userStates.set(userId, `withdrawal_payeer_${amount}`);
            const message = language === 'en' ?
                `💳 Payeer Withdrawal Request\n\n💰 Amount: $${amount.toFixed(2)}\n\n📝 Please send your Payeer wallet address:\n\n📋 Format: P + 8 numbers (P12345678)\n\n⚠️ Make sure the address is correct!\nIncorrect address may result in loss of funds.` :
                `💳 طلب سحب Payeer\n\n💰 المبلغ: $${amount.toFixed(2)}\n\n📝 يرجى إرسال عنوان محفظة Payeer:\n\n📋 الصيغة: P + 8 أرقام (P12345678)\n\n⚠️ تأكد من صحة العنوان!\nالعنوان الخاطئ قد يؤدي لفقدان الأموال.`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            bot.sendMessage(chatId, message, keyboard);

        } else if (text === '🟡 Binance') {
            // Ask for Binance ID
            userStates.set(userId, `withdrawal_binance_${amount}`);
            const message = language === 'en' ?
                `💳 Binance Withdrawal Request\n\n💰 Amount: $${amount.toFixed(2)}\n\n📝 Please send your Binance ID:\n\n📋 Format: 7-15 digits\n📝 Examples: 1234567 or 123456789012345\n\n⚠️ Make sure the ID is correct!\nIncorrect ID may result in loss of funds.` :
                `💳 طلب سحب Binance\n\n💰 المبلغ: $${amount.toFixed(2)}\n\n📝 يرجى إرسال معرف Binance:\n\n📋 الصيغة: 7-15 رقم\n📝 أمثلة: 1234567 أو 123456789012345\n\n⚠️ تأكد من صحة المعرف!\nالمعرف الخاطئ قد يؤدي لفقدان الأموال.`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            bot.sendMessage(chatId, message, keyboard);

        } else if (text === '❌ Cancel' || text === '❌ إلغاء') {
            userStates.delete(userId);
            const message = language === 'en' ?
                '❌ Withdrawal cancelled' :
                '❌ تم إلغاء السحب';
            const keyboard = keyboards.getKeyboard('userKeyboard', language);
            bot.sendMessage(chatId, message, keyboard);
        } else {
            // Invalid selection
            const message = language === 'en' ?
                '❌ Invalid selection. Please choose a withdrawal method or press Cancel:' :
                '❌ اختيار غير صحيح. يرجى اختيار طريقة سحب أو اضغط إلغاء:';
            bot.sendMessage(chatId, message);
        }
    } catch (error) {
        console.error('Error handling withdrawal method selection:', error);
        const message = language === 'en' ?
            '❌ Error processing selection' :
            '❌ حدث خطأ في معالجة الاختيار';
        bot.sendMessage(chatId, message);
    }
}

// Process Binance withdrawal with ID validation
async function processBinanceWithdrawal(chatId, userId, binanceId, amount, language) {
    try {
        // Validate Binance ID format: 7-15 digits
        const binanceRegex = /^\d{7,15}$/;
        if (!binanceRegex.test(binanceId)) {
            const message = language === 'en' ?
                `❌ Invalid Binance ID format!\n\n📋 Required format: 7-15 digits\n• Must be between 7 and 15 numbers\n• No letters or special characters\n\n📝 Examples: 1234567, 123456789012345\n\nPlease send correct Binance ID or press Cancel:` :
                `❌ صيغة معرف Binance غير صحيحة!\n\n📋 الصيغة المطلوبة: 7-15 رقم\n• يجب أن يكون بين 7 و 15 رقم\n• بدون حروف أو رموز خاصة\n\n📝 أمثلة: 1234567، 123456789012345\n\nيرجى إرسال معرف Binance الصحيح أو اضغط إلغاء:`;

            const keyboard = keyboards.getKeyboard('cancelUser', language);
            return bot.sendMessage(chatId, message, keyboard);
        }

        // Show confirmation message
        const confirmMessage = language === 'en' ?
            `💳 Confirm Binance Withdrawal\n\n💰 Amount: $${amount.toFixed(2)}\n🟡 Binance ID: ${binanceId}\n\n⚠️ Please verify your Binance ID carefully!\nOnce confirmed, this cannot be changed.\n\n✅ Is this information correct?` :
            `💳 تأكيد سحب Binance\n\n💰 المبلغ: $${amount.toFixed(2)}\n🟡 معرف Binance: ${binanceId}\n\n⚠️ يرجى التحقق من معرف Binance بعناية!\nبعد التأكيد، لا يمكن تغيير هذه المعلومات.\n\n✅ هل هذه المعلومات صحيحة؟`;

        const confirmKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '✅ Confirm Withdrawal' : '✅ تأكيد السحب',
                            callback_data: `confirm_binance_${userId}_${amount}_${binanceId}`
                        }
                    ],
                    [
                        {
                            text: language === 'en' ? '❌ Cancel' : '❌ إلغاء',
                            callback_data: 'cancel_withdrawal'
                        }
                    ]
                ]
            }
        };

        userStates.delete(userId);
        bot.sendMessage(chatId, confirmMessage, confirmKeyboard);

    } catch (error) {
        console.error('Error processing Binance withdrawal:', error);
        const message = language === 'en' ?
            '❌ Error processing withdrawal request' :
            '❌ حدث خطأ في معالجة طلب السحب';
        bot.sendMessage(chatId, message);
    }
}

// Handle Binance withdrawal confirmation
async function handleBinanceWithdrawalConfirm(chatId, messageId, data, language) {
    try {
        // Parse callback data: confirm_binance_userId_amount_binanceId
        const parts = data.split('_');
        const userId = parts[2];
        const amount = parseFloat(parts[3]);
        const binanceId = parts[4];

        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Deduct balance immediately when user confirms withdrawal
        const currentBalance = user.balance_usd || 0;
        if (currentBalance < amount) {
            const message = language === 'en' ?
                `❌ Insufficient balance!\n\n💰 Current balance: $${currentBalance.toFixed(2)}\n💰 Requested amount: $${amount.toFixed(2)}` :
                `❌ رصيد غير كافٍ!\n\n💰 الرصيد الحالي: $${currentBalance.toFixed(2)}\n💰 المبلغ المطلوب: $${amount.toFixed(2)}`;
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        const newBalance = currentBalance - amount;
        await db.setUserUSDBalance(userId, newBalance);

        // Save withdrawal request
        const method = 'Binance';
        const details = `Binance ID: ${binanceId}`;
        const requestId = await db.addWithdrawalRequest(userId, amount, 'USD', method, details);

        // Notify admin
        const adminMessage = language === 'en' ?
            `💳 New Binance withdrawal request!\n\n👤 User: ${user.username || 'Unknown'}\n🆔 ID: \`${userId}\`\n💰 Amount: $${amount.toFixed(2)}\n🟡 Binance ID: ${binanceId}\n💰 New balance: $${newBalance.toFixed(2)}\n📋 Request ID: #${requestId}` :
            `💳 طلب سحب Binance جديد!\n\n👤 المستخدم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${userId}\`\n💰 المبلغ: $${amount.toFixed(2)}\n🟡 معرف Binance: ${binanceId}\n💰 الرصيد الجديد: $${newBalance.toFixed(2)}\n📋 رقم الطلب: #${requestId}`;

        bot.sendMessage(config.ADMIN_ID, adminMessage, { parse_mode: 'Markdown' });

        const message = language === 'en' ?
            `✅ Binance withdrawal request confirmed!\n\n💰 Amount: $${amount.toFixed(2)}\n🟡 Binance ID: ${binanceId}\n📋 Request ID: #${requestId}\n💰 New balance: $${newBalance.toFixed(2)}\n\n⏳ Your request will be processed soon\n💡 You will be notified once completed` :
            `✅ تم تأكيد طلب سحب Binance!\n\n💰 المبلغ: $${amount.toFixed(2)}\n🟡 معرف Binance: ${binanceId}\n📋 رقم الطلب: #${requestId}\n💰 الرصيد الجديد: $${newBalance.toFixed(2)}\n\n⏳ سيتم معالجة طلبك قريباً\n💡 سيتم إشعارك عند الانتهاء`;

        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error confirming Binance withdrawal:', error);
        const errorMessage = language === 'en' ?
            '❌ Error confirming withdrawal' :
            '❌ حدث خطأ في تأكيد السحب';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}


// Bulk email management functions

// ── إيميلات غير الموافق عليها (pending) ──
async function showAndExportPendingUnapproved(chatId, language) {
    try {
        // pending_accounts اللي status = pending
        const pendingEmails = await db.getAllPendingEmails();
        const pendingFiltered = pendingEmails.filter(e => e.status === 'pending' || !e.status);

        // gmail_accounts اللي status = pending
        const pendingGmails = await db.getPendingGmailAccounts();

        const total = pendingFiltered.length + pendingGmails.length;

        if (total === 0) {
            const msg = language === 'en'
                ? '✅ No unapproved emails!\n\nAll emails have been reviewed.'
                : '✅ لا توجد إيميلات غير موافق عليها!\n\nتمت مراجعة جميع الإيميلات.';
            return bot.sendMessage(chatId, msg);
        }

        // رسالة الإحصائيات أولاً
        const statsMsg = language === 'en'
            ? `⏳ *Pending Unapproved Emails*\n\n📧 Regular: ${pendingFiltered.length}\n📱 Gmail: ${pendingGmails.length}\n📊 Total: ${total}\n\nPress the button below to export as file:`
            : `⏳ *الإيميلات غير الموافق عليها*\n\n📧 عادية: ${pendingFiltered.length}\n📱 جيميل: ${pendingGmails.length}\n📊 الإجمالي: ${total}\n\nاضغط الزرار أدناه لتصديرهم كملف:`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: language === 'en' ? `📥 Export ${total} Emails` : `📥 تصدير ${total} إيميل`,
                        callback_data: 'export_unapproved_emails'
                    }
                ]]
            }
        };

        bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
        console.error('Error showing pending unapproved:', error);
        bot.sendMessage(chatId, language === 'en' ? '❌ Error loading data' : '❌ حدث خطأ في تحميل البيانات');
    }
}

// ── إيميلات غير المصدرة ──
async function showAndExportNonExported(chatId, language) {
    try {
        const nonExportedEmails = await db.getNonExportedPendingEmails();
        const nonExportedGmails = await db.getNonExportedPendingGmails();

        const total = nonExportedEmails.length + nonExportedGmails.length;

        if (total === 0) {
            const msg = language === 'en'
                ? '✅ No non-exported emails!\n\nAll emails have been exported.'
                : '✅ لا توجد إيميلات غير مصدرة!\n\nتم تصدير جميع الإيميلات.';
            return bot.sendMessage(chatId, msg);
        }

        const statsMsg = language === 'en'
            ? `📦 *Non-Exported Emails*\n\n📧 Regular: ${nonExportedEmails.length}\n📱 Gmail: ${nonExportedGmails.length}\n📊 Total: ${total}\n\nPress the button below to export as file:`
            : `📦 *الإيميلات غير المصدرة*\n\n📧 عادية: ${nonExportedEmails.length}\n📱 جيميل: ${nonExportedGmails.length}\n📊 الإجمالي: ${total}\n\nاضغط الزرار أدناه لتصديرهم كملف:`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: language === 'en' ? `📥 Export ${total} Emails` : `📥 تصدير ${total} إيميل`,
                        callback_data: 'export_nonexported_emails'
                    }
                ]]
            }
        };

        bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown', ...keyboard });

    } catch (error) {
        console.error('Error showing non-exported:', error);
        bot.sendMessage(chatId, language === 'en' ? '❌ Error loading data' : '❌ حدث خطأ في تحميل البيانات');
    }
}

async function exportAllEmails(chatId, language) {
    try {
        const pendingEmails = await db.getNonExportedPendingEmails();
        const pendingGmails = await db.getNonExportedPendingGmails();

        // Check if there are any pending emails
        if (pendingEmails.length === 0 && pendingGmails.length === 0) {
            const message = language === 'en' ? 
                '✅ No pending emails!\n\nAll emails have been reviewed.' : 
                '✅ لا توجد إيميلات معلقة!\n\nتمت مراجعة جميع الإيميلات.';
            return bot.sendMessage(chatId, message);
        }

        // Create file content - just emails, one per line
        let fileContent = '';
        
        // Add all emails
        pendingEmails.forEach((email) => {
            fileContent += `${email.email}\n`;
        });

        pendingGmails.forEach((gmail) => {
            fileContent += `${gmail.email}\n`;
        });

        const total = pendingEmails.length + pendingGmails.length;

        // Create filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `pending_emails_${timestamp}.txt`;

        // Write to file
        fs.writeFileSync(filename, fileContent, 'utf8');

        // Mark emails as exported
        const emailIds = pendingEmails.map(e => e.id);
        const gmailIds = pendingGmails.map(g => g.id);
        await db.markEmailsAsExported(emailIds, gmailIds);

        // Send file
        const caption = language === 'en' ?
            `📤 Pending Emails Export\n\n📊 Total: ${total} emails\n⏳ Regular: ${pendingEmails.length}\n📱 Gmail: ${pendingGmails.length}` :
            `📤 تصدير الإيميلات المعلقة\n\n📊 الإجمالي: ${total} إيميل\n⏳ عادية: ${pendingEmails.length}\n📱 جيميل: ${pendingGmails.length}`;

        await bot.sendDocument(chatId, filename, {
            caption: caption
        });

        // Delete file after sending
        fs.unlinkSync(filename);

        console.log(`Exported ${total} pending emails to ${filename}`);

    } catch (error) {
        console.error('Error exporting emails:', error);
        const errorMessage = language === 'en' ?
            '❌ Error exporting emails' :
            '❌ حدث خطأ في تصدير الإيميلات';
        bot.sendMessage(chatId, errorMessage);
    }
}

async function exportLimitedEmails(chatId, countInput, language) {
    try {
        const count = parseInt(countInput);
        if (isNaN(count) || count <= 0) {
            return bot.sendMessage(chatId, language === 'en' ?
                '❌ Invalid number! Please send a valid positive number.' :
                '❌ رقم غير صحيح! أرسل رقماً صحيحاً موجباً.');
        }

        const allEmails = await db.getNonExportedPendingEmails();
        const allGmails = await db.getNonExportedPendingGmails();

        const combined = [
            ...allEmails.map(e => ({ ...e, type: 'email' })),
            ...allGmails.map(g => ({ ...g, type: 'gmail' }))
        ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        const limited = combined.slice(0, count);

        if (limited.length === 0) {
            return bot.sendMessage(chatId, language === 'en' ?
                '✅ No pending emails found!' :
                '✅ لا توجد إيميلات معلقة!');
        }

        let fileContent = '';

        limited.forEach((item) => {
            fileContent += `${item.email}\n`;
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `emails_limited_${count}_${timestamp}.txt`;
        fs.writeFileSync(filename, fileContent, 'utf8');

        // Mark emails as exported
        const emailIds = limited.filter(e => e.type === 'email').map(e => e.id);
        const gmailIds = limited.filter(e => e.type === 'gmail').map(e => e.id);
        await db.markEmailsAsExported(emailIds, gmailIds);

        await bot.sendDocument(chatId, filename, {
            caption: language === 'en' ?
                `📤 Limited Export\n\n📊 Requested: ${count}\n✅ Exported: ${limited.length}\n🕐 Newest first` :
                `📤 تصدير محدود\n\n📊 المطلوب: ${count}\n✅ تم تصدير: ${limited.length}\n🕐 الأحدث أولاً`
        });

        fs.unlinkSync(filename);

    } catch (error) {
        console.error('Error exporting limited emails:', error);
        bot.sendMessage(chatId, language === 'en' ?
            '❌ Error exporting emails' :
            '❌ حدث خطأ في تصدير الإيميلات');
    }
}

async function showRestoreOptions(chatId, language) {
    try {
        const exportedEmails = await db.getExportedEmails();
        const exportedGmails = await db.getExportedGmails();
        const total = exportedEmails.length + exportedGmails.length;

        if (total === 0) {
            return bot.sendMessage(chatId, language === 'en' ?
                '✅ No exported emails found!\n\nAll emails are available for export.' :
                '✅ لا توجد إيميلات مُصدّرة!\n\nجميع الإيميلات متاحة للتصدير.');
        }

        const message = language === 'en' ?
            `↩️ Restore from Export\n\n📊 Total exported emails: ${total}\n📧 Regular: ${exportedEmails.length}\n📱 Gmail: ${exportedGmails.length}\n\n📝 Send the emails you want to restore (one per line):\n\nExample:\nuser1@gmail.com\nuser2@gmail.com` :
            `↩️ إرجاع من التصدير\n\n📊 إجمالي الإيميلات المُصدّرة: ${total}\n📧 عادية: ${exportedEmails.length}\n📱 جيميل: ${exportedGmails.length}\n\n📝 أرسل الإيميلات التي تريد إرجاعها (واحد في كل سطر):\n\nمثال:\nuser1@gmail.com\nuser2@gmail.com`;

        bot.sendMessage(chatId, message);

    } catch (error) {
        console.error('Error showing restore options:', error);
        bot.sendMessage(chatId, language === 'en' ?
            '❌ Error loading exported emails' :
            '❌ حدث خطأ في تحميل الإيميلات المُصدّرة');
    }
}

async function restoreEmailsByList(chatId, userId, emailsText, language) {
    try {
        const emailLines = emailsText.split('\n').map(e => e.trim()).filter(e => e);
        
        if (emailLines.length === 0) {
            return bot.sendMessage(chatId, language === 'en' ?
                '❌ No emails provided!' :
                '❌ لم يتم إدخال أي إيميلات!');
        }

        const exportedEmails = await db.getExportedEmails();
        const exportedGmails = await db.getExportedGmails();

        const emailIds = [];
        const gmailIds = [];
        const found = [];
        const notFound = [];

        for (const email of emailLines) {
            const foundEmail = exportedEmails.find(e => e.email === email);
            const foundGmail = exportedGmails.find(g => g.email === email);

            if (foundEmail) {
                emailIds.push(foundEmail.id);
                found.push(email);
            } else if (foundGmail) {
                gmailIds.push(foundGmail.id);
                found.push(email);
            } else {
                notFound.push(email);
            }
        }

        if (emailIds.length === 0 && gmailIds.length === 0) {
            return bot.sendMessage(chatId, language === 'en' ?
                `❌ None of the provided emails were found in exported list!\n\n📝 Not found:\n${notFound.join('\n')}` :
                `❌ لم يتم العثور على أي من الإيميلات المُدخلة في قائمة المُصدّرة!\n\n📝 غير موجودة:\n${notFound.join('\n')}`);
        }

        await db.unmarkEmailsAsExported(emailIds, gmailIds);

        let message = language === 'en' ?
            `✅ Restored ${found.length} emails!\n\n📧 Restored:\n${found.join('\n')}` :
            `✅ تم إرجاع ${found.length} إيميل!\n\n📧 تم الإرجاع:\n${found.join('\n')}`;

        if (notFound.length > 0) {
            message += language === 'en' ?
                `\n\n❌ Not found (${notFound.length}):\n${notFound.join('\n')}` :
                `\n\n❌ غير موجودة (${notFound.length}):\n${notFound.join('\n')}`;
        }

        bot.sendMessage(chatId, message);

    } catch (error) {
        console.error('Error restoring emails by list:', error);
        bot.sendMessage(chatId, language === 'en' ?
            '❌ Error restoring emails' :
            '❌ حدث خطأ في إرجاع الإيميلات');
    }
}

async function sendAndApproveEmails(chatId, userId, language) {
    try {
        const pendingGmails = await db.getPendingGmailAccounts();
        const pendingEmails = await db.getAllPendingEmails();

        if (pendingGmails.length === 0 && pendingEmails.length === 0) {
            const message = language === 'en' ?
                '📭 No pending emails to approve' :
                '📭 لا توجد إيميلات معلقة للقبول';
            return bot.sendMessage(chatId, message);
        }

        // Ask admin to send the emails to approve
        const instructionMessage = language === 'en' ?
            `✅ Selective Email Approval\n\n📝 Please send the emails you want to approve, one per line.\n\nExample:\nmrmostafa020@gmail.com\nmgdgdgdsf0@gmail.com\nuser@gmail.com\n\n💡 Only these specific emails will be approved.\n\n⏳ Waiting for your list...` :
            `✅ قبول إيميلات محددة\n\n📝 أرسل الإيميلات التي تريد قبولها، كل واحد في سطر.\n\nمثال:\nmrmostafa020@gmail.com\nmgdgdgdsf0@gmail.com\nuser@gmail.com\n\n💡 سيتم قبول هذه الإيميلات المحددة فقط.\n\n⏳ في انتظار قائمتك...`;

        // Set user state to wait for emails list
        userStates.set(userId, { 
            state: 'waiting_approve_emails',
            timestamp: Date.now()
        });

        const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
        bot.sendMessage(chatId, instructionMessage, cancelKeyboard);

    } catch (error) {
        console.error('Error in sendAndApproveEmails:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing approval' :
            '❌ حدث خطأ في معالجة القبول';
        bot.sendMessage(chatId, errorMessage);
    }
}

async function sendAndRejectEmails(chatId, userId, language) {
    try {
        const pendingGmails = await db.getPendingGmailAccounts();
        const pendingEmails = await db.getAllPendingEmails();

        if (pendingGmails.length === 0 && pendingEmails.length === 0) {
            const message = language === 'en' ?
                '📭 No pending emails to reject' :
                '📭 لا توجد إيميلات معلقة للرفض';
            return bot.sendMessage(chatId, message);
        }

        // Ask admin to send the emails to reject
        const instructionMessage = language === 'en' ?
            `❌ Selective Email Rejection\n\n📝 Please send the emails you want to reject, one per line.\n\nExample:\nmrmostafa020@gmail.com\nmgdgdgdsf0@gmail.com\nuser@gmail.com\n\n💡 Only these specific emails will be rejected.\n\n⏳ Waiting for your list...` :
            `❌ رفض إيميلات محددة\n\n📝 أرسل الإيميلات التي تريد رفضها، كل واحد في سطر.\n\nمثال:\nmrmostafa020@gmail.com\nmgdgdgdsf0@gmail.com\nuser@gmail.com\n\n💡 سيتم رفض هذه الإيميلات المحددة فقط.\n\n⏳ في انتظار قائمتك...`;

        // Set user state to wait for emails list
        userStates.set(userId, { 
            state: 'waiting_reject_emails',
            timestamp: Date.now()
        });

        const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
        bot.sendMessage(chatId, instructionMessage, cancelKeyboard);

    } catch (error) {
        console.error('Error in sendAndRejectEmails:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing rejection' :
            '❌ حدث خطأ في معالجة الرفض';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Process selective email approval
async function processSelectiveApproval(chatId, userId, text, language) {
    try {
        // Parse emails from text (one per line)
        const emailList = text.split('\n')
            .map(email => email.trim().toLowerCase())
            .filter(email => email.length > 0 && email.includes('@'));

        if (emailList.length === 0) {
            const message = language === 'en' ?
                '❌ No valid emails found\n\nPlease send emails, one per line.\n\nOr press Cancel to exit:' :
                '❌ لم يتم العثور على إيميلات صحيحة\n\nأرسل الإيميلات، كل واحد في سطر.\n\nأو اضغط إلغاء للخروج:';
            const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
            return bot.sendMessage(chatId, message, cancelKeyboard);
        }

        // Get all pending emails
        const pendingGmails = await db.getPendingGmailAccounts();
        const pendingEmails = await db.getAllPendingEmails();

        // Find matching emails
        const matchedGmails = pendingGmails.filter(gmail => 
            emailList.includes(gmail.email.toLowerCase())
        );
        const matchedEmails = pendingEmails.filter(email => 
            emailList.includes(email.email.toLowerCase())
        );

        const totalMatched = matchedGmails.length + matchedEmails.length;

        if (totalMatched === 0) {
            const message = language === 'en' ?
                `❌ No matching pending emails found\n\n📝 You sent ${emailList.length} emails, but none of them are in the pending list.\n\n💡 Make sure the emails are correct and pending review.` :
                `❌ لم يتم العثور على إيميلات معلقة مطابقة\n\n📝 أرسلت ${emailList.length} إيميل، لكن لا يوجد أي منها في قائمة المعلقة.\n\n💡 تأكد من أن الإيميلات صحيحة ومعلقة للمراجعة.`;
            userStates.delete(userId);
            const adminKeyboard = keyboards.getKeyboard('adminKeyboard', language);
            return bot.sendMessage(chatId, message, adminKeyboard);
        }

        // Show confirmation
        const confirmMessage = language === 'en' ?
            `✅ Found ${totalMatched} matching emails to approve:\n\n` +
            `📱 Gmail accounts: ${matchedGmails.length}\n` +
            `📧 Regular emails: ${matchedEmails.length}\n\n` +
            `This will:\n` +
            `✅ Mark these emails as approved\n` +
            `💰 Add rewards to users\n\n` +
            `Are you sure?` :
            `✅ تم العثور على ${totalMatched} إيميل مطابق للقبول:\n\n` +
            `📱 حسابات جيميل: ${matchedGmails.length}\n` +
            `📧 إيميلات عادية: ${matchedEmails.length}\n\n` +
            `هذا سوف:\n` +
            `✅ يضع علامة على هذه الإيميلات كمقبولة\n` +
            `💰 يضيف المكافآت للمستخدمين\n\n` +
            `هل أنت متأكد؟`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '✅ Yes, Approve' : '✅ نعم، قبول',
                            callback_data: `selective_approve_${matchedGmails.map(g => g.id).join(',')}_${matchedEmails.map(e => e.id).join(',')}`
                        },
                        {
                            text: language === 'en' ? '❌ Cancel' : '❌ إلغاء',
                            callback_data: 'selective_approve_cancel'
                        }
                    ]
                ]
            }
        };

        userStates.delete(userId);
        bot.sendMessage(chatId, confirmMessage, keyboard);

    } catch (error) {
        console.error('Error in processSelectiveApproval:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing approval' :
            '❌ حدث خطأ في معالجة القبول';
        userStates.delete(userId);
        bot.sendMessage(chatId, errorMessage);
    }
}

// Process selective email rejection
async function processSelectiveRejection(chatId, userId, text, language) {
    try {
        // Parse emails from text (one per line)
        const emailList = text.split('\n')
            .map(email => email.trim().toLowerCase())
            .filter(email => email.length > 0 && email.includes('@'));

        if (emailList.length === 0) {
            const message = language === 'en' ?
                '❌ No valid emails found\n\nPlease send emails, one per line.\n\nOr press Cancel to exit:' :
                '❌ لم يتم العثور على إيميلات صحيحة\n\nأرسل الإيميلات، كل واحد في سطر.\n\nأو اضغط إلغاء للخروج:';
            const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
            return bot.sendMessage(chatId, message, cancelKeyboard);
        }

        // Get all pending emails
        const pendingGmails = await db.getPendingGmailAccounts();
        const pendingEmails = await db.getAllPendingEmails();

        // Find matching emails
        const matchedGmails = pendingGmails.filter(gmail => 
            emailList.includes(gmail.email.toLowerCase())
        );
        const matchedEmails = pendingEmails.filter(email => 
            emailList.includes(email.email.toLowerCase())
        );

        const totalMatched = matchedGmails.length + matchedEmails.length;

        if (totalMatched === 0) {
            const message = language === 'en' ?
                `❌ No matching pending emails found\n\n📝 You sent ${emailList.length} emails, but none of them are in the pending list.\n\n💡 Make sure the emails are correct and pending review.` :
                `❌ لم يتم العثور على إيميلات معلقة مطابقة\n\n📝 أرسلت ${emailList.length} إيميل، لكن لا يوجد أي منها في قائمة المعلقة.\n\n💡 تأكد من أن الإيميلات صحيحة ومعلقة للمراجعة.`;
            userStates.delete(userId);
            const adminKeyboard = keyboards.getKeyboard('adminKeyboard', language);
            return bot.sendMessage(chatId, message, adminKeyboard);
        }

        // Show confirmation
        const confirmMessage = language === 'en' ?
            `❌ Found ${totalMatched} matching emails to reject:\n\n` +
            `📱 Gmail accounts: ${matchedGmails.length}\n` +
            `📧 Regular emails: ${matchedEmails.length}\n\n` +
            `This will:\n` +
            `❌ Mark these emails as rejected\n` +
            `📧 Notify users about rejection\n\n` +
            `Are you sure?` :
            `❌ تم العثور على ${totalMatched} إيميل مطابق للرفض:\n\n` +
            `📱 حسابات جيميل: ${matchedGmails.length}\n` +
            `📧 إيميلات عادية: ${matchedEmails.length}\n\n` +
            `هذا سوف:\n` +
            `❌ يضع علامة على هذه الإيميلات كمرفوضة\n` +
            `📧 يخطر المستخدمين بالرفض\n\n` +
            `هل أنت متأكد؟`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '❌ Yes, Reject' : '❌ نعم، رفض',
                            callback_data: `selective_reject_${matchedGmails.map(g => g.id).join(',')}_${matchedEmails.map(e => e.id).join(',')}`
                        },
                        {
                            text: language === 'en' ? '🔙 Cancel' : '🔙 إلغاء',
                            callback_data: 'selective_reject_cancel'
                        }
                    ]
                ]
            }
        };

        userStates.delete(userId);
        bot.sendMessage(chatId, confirmMessage, keyboard);

    } catch (error) {
        console.error('Error in processSelectiveRejection:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing rejection' :
            '❌ حدث خطأ في معالجة الرفض';
        userStates.delete(userId);
        bot.sendMessage(chatId, errorMessage);
    }
}

async function processBulkApproval(chatId, messageId, language) {
    try {
        const pendingGmails = await db.getPendingGmailAccounts();
        
        if (pendingGmails.length === 0) {
            const message = language === 'en' ?
                '📭 No pending emails found' :
                '📭 لا توجد إيميلات معلقة';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Update status message
        const processingMessage = language === 'en' ?
            `⏳ Processing ${pendingGmails.length} emails...\n\nPlease wait...` :
            `⏳ جاري معالجة ${pendingGmails.length} إيميل...\n\nالرجاء الانتظار...`;
        
        await bot.editMessageText(processingMessage, {
            chat_id: chatId,
            message_id: messageId
        });

        let successCount = 0;
        let errorCount = 0;

        // Process each email
        for (const gmail of pendingGmails) {
            try {
                // Prevent double processing - check status first
                if (gmail.status !== 'pending') {
                    continue;
                }

                // Mark as processing first to prevent double-click
                await db.updateGmailAccountStatus(gmail.id, 'processing');

                // Get user and add reward
                const user = await db.getUser(gmail.user_id);
                if (user) {
                    const gmailReward = parseFloat(await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD);
                    const currency = user.preferred_currency || 'EGP';

                    if (currency === 'USD') {
                        const usdReward = await convertEGPToUSD(gmailReward);
                        const freshUser = await db.getUser(gmail.user_id);
                        const newBalance = (parseFloat(freshUser.balance_usd) || 0) + usdReward;
                        await db.setUserUSDBalance(gmail.user_id, newBalance);
                    } else {
                        const freshUser = await db.getUser(gmail.user_id);
                        const newBalance = (parseFloat(freshUser.balance) || 0) + gmailReward;
                        await db.setUserBalance(gmail.user_id, newBalance);
                    }

                    // First task = big one-time referral reward, subsequent = per-email
                    const referralBulk = await db.getReferralByReferredId(gmail.user_id);
                    if (referralBulk && referralBulk.status === 'pending') {
                        await processReferralReward(gmail.user_id);
                    } else {
                        await processPerEmailReferralReward(gmail.user_id);
                    }

                    // Notify user
                    const userLanguage = await getUserLanguage(gmail.user_id);
                    const displayReward = currency === 'USD' ?
                        `${(await convertEGPToUSD(gmailReward)).toFixed(3)} USD` :
                        `${formatBalance(gmailReward, 'EGP')} جنيه`;
                    const approvalDate = new Date().toISOString().replace('T', ' ').substring(0, 16);
                    const approvalMessage = userLanguage === 'en' ?
                        `✅ Your Gmail account has been approved!\n\n💰 Reward: ${displayReward}\n📱 Gmail: ${gmail.email}\n📅 Approval Date: ${approvalDate}` :
                        `✅ تم قبول حساب الجيميل الخاص بك!\n\n💰 المكافأة: ${displayReward}\n📱 الجيميل: ${gmail.email}\n📅 تاريخ القبول: ${approvalDate}`;
                    await safeSendMessage(gmail.user_id, approvalMessage);

                    // Set final approved status
                    await db.updateGmailAccountStatus(gmail.id, 'approved');
                } else {
                    // User not found - still mark approved to avoid stuck 'processing'
                    await db.updateGmailAccountStatus(gmail.id, 'approved');
                }

                successCount++;
            } catch (error) {
                console.error(`Error approving email ${gmail.id}:`, error);
                errorCount++;
            }
        }

        // Send final report
        const reportMessage = language === 'en' ?
            `✅ Bulk Approval Complete!\n\n📊 Results:\n✅ Approved: ${successCount}\n❌ Errors: ${errorCount}\n📧 Total: ${pendingGmails.length}` :
            `✅ اكتمل القبول الجماعي!\n\n📊 النتائج:\n✅ مقبول: ${successCount}\n❌ أخطاء: ${errorCount}\n📧 الإجمالي: ${pendingGmails.length}`;

        bot.editMessageText(reportMessage, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error in processBulkApproval:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing bulk approval' :
            '❌ حدث خطأ في معالجة القبول الجماعي';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Process selective approval confirmation
async function processSelectiveApprovalConfirm(chatId, messageId, data, language) {
    try {
        // Parse IDs from callback data
        const parts = data.replace('selective_approve_', '').split('_');
        const gmailIds = parts[0] ? parts[0].split(',').filter(id => id).map(id => parseInt(id)) : [];
        const emailIds = parts[1] ? parts[1].split(',').filter(id => id).map(id => parseInt(id)) : [];

        const total = gmailIds.length + emailIds.length;

        // Update status message
        const processingMessage = language === 'en' ?
            `⏳ Processing ${total} emails...\n\nPlease wait...` :
            `⏳ جاري معالجة ${total} إيميل...\n\nالرجاء الانتظار...`;
        
        await bot.editMessageText(processingMessage, {
            chat_id: chatId,
            message_id: messageId
        });

        let successCount = 0;
        let errorCount = 0;

        // Process Gmail accounts
        for (const gmailId of gmailIds) {
            try {
                const gmail = await db.getGmailAccountById(gmailId);
                if (!gmail) continue;

                // ✅ CRITICAL FIX: Check if already processed
                if (gmail.status !== 'pending') {
                    console.log(`Gmail ${gmailId} already processed, skipping`);
                    continue;
                }

                // Update status FIRST to prevent duplicate processing
                await db.updateGmailAccountStatus(gmailId, 'processing');

                const user = await db.getUser(gmail.user_id);
                if (user) {
                    const gmailReward = parseFloat(await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD);
                    const currency = user.preferred_currency || 'EGP';

                    if (currency === 'USD') {
                        const usdReward = await convertEGPToUSD(gmailReward);
                        const freshUser = await db.getUser(gmail.user_id);
                        const newBalance = (parseFloat(freshUser.balance_usd) || 0) + usdReward;
                        await db.setUserUSDBalance(gmail.user_id, newBalance);
                    } else {
                        const freshUser = await db.getUser(gmail.user_id);
                        const newBalance = (parseFloat(freshUser.balance) || 0) + gmailReward;
                        await db.setUserBalance(gmail.user_id, newBalance);
                    }

                    // First task = big one-time referral reward, subsequent = per-email
                    const referralSelGmail = await db.getReferralByReferredId(gmail.user_id);
                    if (referralSelGmail && referralSelGmail.status === 'pending') {
                        await processReferralReward(gmail.user_id);
                    } else {
                        await processPerEmailReferralReward(gmail.user_id);
                    }

                    const userLanguage = await getUserLanguage(gmail.user_id);
                    const displayReward = currency === 'USD' ?
                        `${(await convertEGPToUSD(gmailReward)).toFixed(3)} USD` :
                        `${formatBalance(gmailReward, 'EGP')} جنيه`;
                    const approvalDate = new Date().toISOString().replace('T', ' ').substring(0, 16);
                    const approvalMessage = userLanguage === 'en' ?
                        `✅ Your Gmail account has been approved!\n\n💰 Reward: ${displayReward}\n📱 Gmail: ${gmail.email}\n📅 Approval Date: ${approvalDate}` :
                        `✅ تم قبول حساب الجيميل الخاص بك!\n\n💰 المكافأة: ${displayReward}\n📱 الجيميل: ${gmail.email}\n📅 تاريخ القبول: ${approvalDate}`;
                    await safeSendMessage(gmail.user_id, approvalMessage);
                }

                // Update to final status
                await db.updateGmailAccountStatus(gmailId, 'approved');

                successCount++;
            } catch (error) {
                console.error(`Error approving Gmail ${gmailId}:`, error);
                errorCount++;
            }
        }

        // Process regular emails (similar logic)
        for (const emailId of emailIds) {
            try {
                const email = await db.getPendingAccountById(emailId);
                if (!email) continue;

                // Prevent double processing
                if (email.status !== 'pending' && email.status !== null) {
                    console.log(`Email ${emailId} already processed, skipping`);
                    continue;
                }

                // Mark as processing first
                await db.updatePendingAccountStatus(emailId, 'processing');

                const user = await db.getUser(email.user_id);
                if (user) {
                    const emailReward = parseFloat(await db.getSetting('task_reward') || config.TASK_REWARD);
                    const currency = user.preferred_currency || 'EGP';

                    if (currency === 'USD') {
                        const usdReward = await convertEGPToUSD(emailReward);
                        const freshUser = await db.getUser(email.user_id);
                        const newBalance = (parseFloat(freshUser.balance_usd) || 0) + usdReward;
                        await db.setUserUSDBalance(email.user_id, newBalance);
                    } else {
                        const freshUser = await db.getUser(email.user_id);
                        const newBalance = (parseFloat(freshUser.balance) || 0) + emailReward;
                        await db.setUserBalance(email.user_id, newBalance);
                    }

                    // First task = big one-time referral reward, subsequent = per-email
                    const referralSelEmail = await db.getReferralByReferredId(email.user_id);
                    if (referralSelEmail && referralSelEmail.status === 'pending') {
                        await processReferralReward(email.user_id);
                    } else {
                        await processPerEmailReferralReward(email.user_id);
                    }

                    const userLanguage = await getUserLanguage(email.user_id);
                    const displayReward = currency === 'USD' ?
                        `${(await convertEGPToUSD(emailReward)).toFixed(3)} USD` :
                        `${formatBalance(emailReward, 'EGP')} جنيه`;
                    const approvalDate = new Date().toISOString().replace('T', ' ').substring(0, 16);
                    const approvalMessage = userLanguage === 'en' ?
                        `✅ Your account has been approved!\n\n💰 Reward: ${displayReward}\n📧 Email: ${email.email}\n📅 Approval Date: ${approvalDate}` :
                        `✅ تم قبول حسابك!\n\n💰 المكافأة: ${displayReward}\n📧 الإيميل: ${email.email}\n📅 تاريخ القبول: ${approvalDate}`;
                    await safeSendMessage(email.user_id, approvalMessage);
                }

                // Mark as approved (final status)
                await db.updatePendingAccountStatus(emailId, 'approved');

                successCount++;
            } catch (error) {
                console.error(`Error approving email ${emailId}:`, error);
                errorCount++;
            }
        }

        // Send final report
        const reportMessage = language === 'en' ?
            `✅ Selective Approval Complete!\n\n📊 Results:\n✅ Approved: ${successCount}\n❌ Errors: ${errorCount}\n📧 Total: ${total}` :
            `✅ اكتمل القبول الانتقائي!\n\n📊 النتائج:\n✅ مقبول: ${successCount}\n❌ أخطاء: ${errorCount}\n📧 الإجمالي: ${total}`;

        bot.editMessageText(reportMessage, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error in processSelectiveApprovalConfirm:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing selective approval' :
            '❌ حدث خطأ في معالجة القبول الانتقائي';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Process selective rejection confirmation
async function processSelectiveRejectionConfirm(chatId, messageId, data, language) {
    try {
        // Parse IDs from callback data
        const parts = data.replace('selective_reject_', '').split('_');
        const gmailIds = parts[0] ? parts[0].split(',').filter(id => id).map(id => parseInt(id)) : [];
        const emailIds = parts[1] ? parts[1].split(',').filter(id => id).map(id => parseInt(id)) : [];

        const total = gmailIds.length + emailIds.length;

        // Update status message
        const processingMessage = language === 'en' ?
            `⏳ Processing ${total} emails...\n\nPlease wait...` :
            `⏳ جاري معالجة ${total} إيميل...\n\nالرجاء الانتظار...`;
        
        await bot.editMessageText(processingMessage, {
            chat_id: chatId,
            message_id: messageId
        });

        let successCount = 0;
        let errorCount = 0;

        // Process Gmail accounts
        for (const gmailId of gmailIds) {
            try {
                const gmail = await db.getGmailAccountById(gmailId);
                if (!gmail) continue;

                // Only reject pending emails
                if (gmail.status !== 'pending') {
                    console.log(`Gmail ${gmailId} already processed, skipping`);
                    continue;
                }

                await db.updateGmailAccountStatus(gmailId, 'rejected');

                const userLanguage = await getUserLanguage(gmail.user_id);
                const rejectionMessage = userLanguage === 'en' ?
                    `❌ Your account has been rejected\n\n📱 Gmail: ${gmail.email}\n\n💡 Make sure you create the account correctly next time\n📞 If there is a problem, contact support\n\n🌟 Don't give up! You can try again` :
                    `❌ تم رفض حسابك\n\n📱 الجيميل: ${gmail.email}\n\n💡 تأكد من أنك أنشأت الحساب بشكل صحيح المرة القادمة\n📞 إذا هناك مشكلة، تواصل مع الدعم\n\n🌟 لا تيأس! يمكنك المحاولة مرة أخرى`;
                await safeSendMessage(gmail.user_id, rejectionMessage);

                successCount++;
            } catch (error) {
                console.error(`Error rejecting Gmail ${gmailId}:`, error);
                errorCount++;
            }
        }

        // Process regular emails
        for (const emailId of emailIds) {
            try {
                const email = await db.getPendingAccountById(emailId);
                if (!email) continue;

                // Only reject pending emails
                if (email.status !== 'pending' && email.status !== null) {
                    console.log(`Email ${emailId} already processed, skipping`);
                    continue;
                }

                // Return email to available pool
                try {
                    await db.addAvailableAccount(email.email, email.password, email.first_name || null, email.last_name || null);
                } catch (err) {
                    console.error('Error returning rejected email to pool:', err.message);
                }

                // Mark as rejected (keep record)
                await db.updatePendingAccountStatus(emailId, 'rejected');

                const userLanguage = await getUserLanguage(email.user_id);
                const rejectionMessage = userLanguage === 'en' ?
                    `❌ Your account has been rejected\n\n📧 Email: ${email.email}\n\n💡 Make sure you create the account correctly next time\n📞 If there is a problem, contact support\n\n🌟 Don't give up! You can try again` :
                    `❌ تم رفض حسابك\n\n📧 الإيميل: ${email.email}\n\n💡 تأكد من أنك أنشأت الحساب بشكل صحيح المرة القادمة\n📞 إذا هناك مشكلة، تواصل مع الدعم\n\n🌟 لا تيأس! يمكنك المحاولة مرة أخرى`;
                await safeSendMessage(email.user_id, rejectionMessage);

                successCount++;
            } catch (error) {
                console.error(`Error rejecting email ${emailId}:`, error);
                errorCount++;
            }
        }

        // Send final report
        const reportMessage = language === 'en' ?
            `❌ Selective Rejection Complete!\n\n📊 Results:\n❌ Rejected: ${successCount}\n⚠️ Errors: ${errorCount}\n📧 Total: ${total}` :
            `❌ اكتمل الرفض الانتقائي!\n\n📊 النتائج:\n❌ مرفوض: ${successCount}\n⚠️ أخطاء: ${errorCount}\n📧 الإجمالي: ${total}`;

        bot.editMessageText(reportMessage, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error in processSelectiveRejectionConfirm:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing selective rejection' :
            '❌ حدث خطأ في معالجة الرفض الانتقائي';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Admin Management Functions
async function processAddAdmin(chatId, userId, adminIdInput, language) {
    try {
        const adminId = adminIdInput.trim();
        
        // Validate admin ID
        if (!/^\d+$/.test(adminId)) {
            const message = language === 'en' ?
                '❌ Invalid user ID. Please enter numbers only.' :
                '❌ آيدي غير صحيح. أدخل أرقام فقط.';
            return bot.sendMessage(chatId, message);
        }
        
        // Check if user exists
        const user = await db.getUser(adminId);
        if (!user) {
            const message = language === 'en' ?
                `❌ User with ID "${adminId}" not found` :
                `❌ لم يتم العثور على مستخدم بالآيدي "${adminId}"`;
            userStates.delete(userId);
            return bot.sendMessage(chatId, message);
        }
        
        // Check if already admin
        if (await db.isAdmin(adminId)) {
            const message = language === 'en' ?
                '❌ This user is already an admin' :
                '❌ هذا المستخدم أدمن بالفعل';
            userStates.delete(userId);
            return bot.sendMessage(chatId, message);
        }
        
        // Add admin
        await db.addAdmin(adminId, user.username || 'Unknown', userId);
        
        userStates.delete(userId);
        const keyboardType = await isMainAdmin(userId) ? 'mainAdminKeyboard' : 'adminKeyboard';
        const keyboard = keyboards.getKeyboard(keyboardType, language);
        
        const message = language === 'en' ?
            `✅ Admin added successfully!\n\n👤 Username: ${user.username || 'Unknown'}\n🆔 ID: \`${adminId}\`` :
            `✅ تم إضافة الأدمن بنجاح!\n\n👤 اليوزر نيم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${adminId}\``;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, language === 'en' ? '👑 Admin Panel:' : '👑 لوحة الأدمن:', keyboard);
        
        // Notify the new admin
        const notifyMessage = language === 'en' ?
            '🎉 Congratulations! You have been added as an admin.\n\nUse /start to access the admin panel.' :
            '🎉 تهانينا! تم إضافتك كأدمن.\n\nاستخدم /start للوصول إلى لوحة الأدمن.';
        bot.sendMessage(adminId, notifyMessage).catch(() => {});
        
    } catch (error) {
        console.error('Error adding admin:', error);
        const errorMessage = language === 'en' ?
            '❌ Error adding admin' :
            '❌ حدث خطأ في إضافة الأدمن';
        bot.sendMessage(chatId, errorMessage);
    }
}

async function processRemoveAdmin(chatId, userId, adminIdInput, language) {
    try {
        const adminId = adminIdInput.trim();
        
        // Validate admin ID
        if (!/^\d+$/.test(adminId)) {
            const message = language === 'en' ?
                '❌ Invalid user ID. Please enter numbers only.' :
                '❌ آيدي غير صحيح. أدخل أرقام فقط.';
            return bot.sendMessage(chatId, message);
        }
        
        // Check if user is admin
        if (!(await db.isAdmin(adminId))) {
            const message = language === 'en' ?
                '❌ This user is not an admin' :
                '❌ هذا المستخدم ليس أدمن';
            userStates.delete(userId);
            return bot.sendMessage(chatId, message);
        }
        
        // Check if trying to remove main admin
        if (await db.isMainAdmin(adminId)) {
            const message = language === 'en' ?
                '❌ Cannot remove the main admin' :
                '❌ لا يمكن حذف الأدمن الرئيسي';
            userStates.delete(userId);
            return bot.sendMessage(chatId, message);
        }
        
        // Remove admin
        const result = await db.removeAdmin(adminId);
        
        if (result === 0) {
            const message = language === 'en' ?
                '❌ Failed to remove admin' :
                '❌ فشل حذف الأدمن';
            userStates.delete(userId);
            return bot.sendMessage(chatId, message);
        }
        
        userStates.delete(userId);
        const keyboardType = await isMainAdmin(userId) ? 'mainAdminKeyboard' : 'adminKeyboard';
        const keyboard = keyboards.getKeyboard(keyboardType, language);
        
        const message = language === 'en' ?
            `✅ Admin removed successfully!\n\n🆔 ID: \`${adminId}\`` :
            `✅ تم حذف الأدمن بنجاح!\n\n🆔 الآيدي: \`${adminId}\``;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        bot.sendMessage(chatId, language === 'en' ? '👑 Admin Panel:' : '👑 لوحة الأدمن:', keyboard);
        
        // Notify the removed admin
        const notifyMessage = language === 'en' ?
            '⚠️ You have been removed from admin privileges.' :
            '⚠️ تم إزالتك من صلاحيات الأدمن.';
        bot.sendMessage(adminId, notifyMessage).catch(() => {});
        
    } catch (error) {
        console.error('Error removing admin:', error);
        const errorMessage = language === 'en' ?
            '❌ Error removing admin' :
            '❌ حدث خطأ في حذف الأدمن';
        bot.sendMessage(chatId, errorMessage);
    }
}

// عرض وتبديل صلاحية مراجعة الإيميلات للأدمنز
async function showEmailReviewPermissionMenu(chatId, language) {
    const current = await db.getSetting('admins_email_review') || 'false';
    const isEnabled = current === 'true';

    const statusText = isEnabled
        ? (language === 'en' ? '✅ Enabled' : '✅ مفعّل')
        : (language === 'en' ? '❌ Disabled' : '❌ معطّل');

    const message = language === 'en'
        ? `📧 *Email Review Permission for Admins*\n\nCurrent Status: ${statusText}\n\n✅ Enabled: Admins can review, approve, reject emails and access bulk email management\n❌ Disabled: Only main admin can access these features\n\nChoose:`
        : `📧 *صلاحية مراجعة الإيميلات للأدمنز*\n\nالحالة الحالية: ${statusText}\n\n✅ مفعّل: الأدمنز يقدروا يراجعوا ويوافقوا ويرفضوا الإيميلات ويخشوا على الإدارة الجماعية\n❌ معطّل: بس الأدمن الرئيسي يقدر يخش على هذه الميزات\n\nاختر:`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [[
                {
                    text: isEnabled
                        ? (language === 'en' ? '❌ Disable' : '❌ تعطيل')
                        : (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                    callback_data: isEnabled ? 'email_review_perm_disable' : 'email_review_perm_enable'
                }
            ]]
        }
    };

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
}

// عرض وتبديل صلاحية طلبات السحب للأدمنز
async function showWithdrawalPermissionMenu(chatId, language) {
    const current = await db.getSetting('admins_withdrawal_access') || 'false';
    const isEnabled = current === 'true';

    const statusText = isEnabled
        ? (language === 'en' ? '✅ Enabled' : '✅ مفعّل')
        : (language === 'en' ? '❌ Disabled' : '❌ معطّل');

    const message = language === 'en'
        ? `💳 *Withdrawal Requests Permission for Admins*\n\nCurrent Status: ${statusText}\n\n✅ Enabled: Admins can view and process withdrawal requests\n❌ Disabled: Only main admin can access withdrawal requests\n\nChoose:`
        : `💳 *صلاحية طلبات السحب للأدمنز*\n\nالحالة الحالية: ${statusText}\n\n✅ مفعّل: الأدمنز يقدروا يشوفوا ويعالجوا طلبات السحب\n❌ معطّل: بس الأدمن الرئيسي يقدر يخش على طلبات السحب\n\nاختر:`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [[
                {
                    text: isEnabled
                        ? (language === 'en' ? '❌ Disable' : '❌ تعطيل')
                        : (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                    callback_data: isEnabled ? 'withdrawal_perm_disable' : 'withdrawal_perm_enable'
                }
            ]]
        }
    };

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...keyboard });
}

async function showAdminList(chatId, language) {
    try {
        const admins = await db.getAllAdmins();
        
        if (admins.length === 0) {
            const message = language === 'en' ?
                '👑 No admins found' :
                '👑 لا يوجد أدمنز';
            return bot.sendMessage(chatId, message);
        }
        
        let message = language === 'en' ?
            '👑 Admin List:\n\n' :
            '👑 قائمة الأدمنز:\n\n';
        
        for (const admin of admins) {
            const role = admin.is_main_admin ? 
                (language === 'en' ? '👑 Main Admin' : '👑 أدمن رئيسي') :
                (language === 'en' ? '👤 Admin' : '👤 أدمن');
            
            message += language === 'en' ?
                `${role}\n📝 Username: ${admin.username || 'Unknown'}\n🆔 ID: \`${admin.id}\`\n📅 Added: ${new Date(admin.created_at).toLocaleDateString()}\n\n` :
                `${role}\n📝 اليوزر نيم: ${admin.username || 'غير محدد'}\n🆔 الآيدي: \`${admin.id}\`\n📅 تاريخ الإضافة: ${new Date(admin.created_at).toLocaleDateString()}\n\n`;
        }
        
        message += language === 'en' ?
            `📊 Total: ${admins.length} admin(s)` :
            `📊 الإجمالي: ${admins.length} أدمن`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Error showing admin list:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading admin list' :
            '❌ حدث خطأ في تحميل قائمة الأدمنز';
        bot.sendMessage(chatId, errorMessage);
    }
}

async function processBulkRejection(chatId, messageId, language) {
    try {
        const pendingGmails = await db.getPendingGmailAccounts();
        
        if (pendingGmails.length === 0) {
            const message = language === 'en' ?
                '📭 No pending emails found' :
                '📭 لا توجد إيميلات معلقة';
            return bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Update status message
        const processingMessage = language === 'en' ?
            `⏳ Processing ${pendingGmails.length} emails...\n\nPlease wait...` :
            `⏳ جاري معالجة ${pendingGmails.length} إيميل...\n\nالرجاء الانتظار...`;
        
        await bot.editMessageText(processingMessage, {
            chat_id: chatId,
            message_id: messageId
        });

        let successCount = 0;
        let errorCount = 0;

        // Process each email
        for (const gmail of pendingGmails) {
            try {
                // Only reject pending emails
                if (gmail.status !== 'pending') {
                    continue;
                }

                // Update status to rejected
                await db.updateGmailAccountStatus(gmail.id, 'rejected');

                // Notify user
                const userLanguage = await getUserLanguage(gmail.user_id);
                const rejectionMessage = userLanguage === 'en' ?
                    `❌ Your account has been rejected\n\n📱 Gmail: ${gmail.email}\n\n💡 Make sure you create the account correctly next time\n📞 If there is a problem, contact support\n\n🌟 Don't give up! You can try again` :
                    `❌ تم رفض حسابك\n\n📱 الجيميل: ${gmail.email}\n\n💡 تأكد من أنك أنشأت الحساب بشكل صحيح المرة القادمة\n📞 إذا هناك مشكلة، تواصل مع الدعم\n\n🌟 لا تيأس! يمكنك المحاولة مرة أخرى`;
                await safeSendMessage(gmail.user_id, rejectionMessage);

                successCount++;
            } catch (error) {
                console.error(`Error rejecting email ${gmail.id}:`, error);
                errorCount++;
            }
        }

        // Send final report
        const reportMessage = language === 'en' ?
            `❌ Bulk Rejection Complete!\n\n📊 Results:\n❌ Rejected: ${successCount}\n⚠️ Errors: ${errorCount}\n📧 Total: ${pendingGmails.length}` :
            `❌ اكتمل الرفض الجماعي!\n\n📊 النتائج:\n❌ مرفوض: ${successCount}\n⚠️ أخطاء: ${errorCount}\n📧 الإجمالي: ${pendingGmails.length}`;

        bot.editMessageText(reportMessage, {
            chat_id: chatId,
            message_id: messageId
        });

    } catch (error) {
        console.error('Error in processBulkRejection:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing bulk rejection' :
            '❌ حدث خطأ في معالجة الرفض الجماعي';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Safe bot startup function
async function startBotSafely() {
    try {
        console.log('🚀 Starting Multilingual Telegram Bot...');

        // Verify bot token first
        const botInfo = await bot.getMe();
        console.log(`✅ Bot verified: @${botInfo.username}`);

        // Clear any existing webhooks
        await bot.deleteWebHook();
        console.log('🧹 Cleared existing webhooks');

        // Start polling with retry logic
        await bot.startPolling();
        console.log('🤖 Multilingual Telegram Bot started successfully!');
        console.log('🌍 Supported languages: Arabic (العربية) & English');
        console.log('💰 Supported currencies: EGP & USD');
        console.log('📡 Bot is now listening for messages...');

    } catch (error) {
        console.error('❌ Failed to start bot:', error.message);

        if (error.message.includes('401')) {
            console.error('🔑 Invalid bot token. Please check your BOT_TOKEN in config.js');
        } else if (error.message.includes('timeout')) {
            console.error('🌐 Network timeout. Please check your internet connection');
        } else {
            console.error('💡 Please check your configuration and try again');
        }

        process.exit(1);
    }
}

// Start the bot
startBotSafely();

// Start GitHub auto-backup (every minute)
startAutoBackup();

// Start auto exchange rate update from Binance P2P (every 10 minutes)
startAutoRateUpdate(db);

// Admin functions

// Show statistics
async function showStatistics(chatId, language) {
    try {
        const userCount = await db.getUserCount();
        const availableAccountsCount = await db.getAvailableAccountsCount();
        const totalBalance = await db.getTotalBalance();

        const message = language === 'en' ?
            `📊 Bot Statistics:\n\n👥 Total Users: ${userCount}\n📦 Available Accounts: ${availableAccountsCount}\n💰 Total Balance: ${formatBalance(totalBalance, 'EGP')}\n\n📅 Generated on: ${new Date().toLocaleString()}` :
            `📊 إحصائيات البوت:\n\n👥 إجمالي المستخدمين: ${userCount}\n📦 اليوزرات المتاحة: ${availableAccountsCount}\n💰 إجمالي الأرصدة: ${formatBalance(totalBalance, 'EGP')}\n\n📅 تم الإنشاء في: ${new Date().toLocaleString()}`;

        bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error showing statistics:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading statistics' :
            '❌ حدث خطأ في تحميل الإحصائيات';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Show pending accounts for review
async function showPendingAccounts(chatId, language, page = 1) {
    try {
        const accounts = await db.getPendingAccounts();
        if (accounts.length === 0) {
            const message = language === 'en' ?
                '📧 No pending accounts for review\n\n💡 Completed accounts will appear here for your approval' :
                '📧 لا توجد يوزرات معلقة للمراجعة\n\n💡 ستظهر هنا اليوزرات المكتملة لموافقتك';
            return bot.sendMessage(chatId, message);
        }

        const itemsPerPage = 10;
        const totalPages = Math.ceil(accounts.length / itemsPerPage);
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, accounts.length);
        const pageAccounts = accounts.slice(startIndex, endIndex);

        const headerMessage = language === 'en' ?
            `📧 Pending Email Accounts (${startIndex + 1}-${endIndex} of ${accounts.length})\n📄 Page ${page}/${totalPages}` :
            `📧 اليوزرات المعلقة (${startIndex + 1}-${endIndex} من ${accounts.length})\n📄 صفحة ${page}/${totalPages}`;

        bot.sendMessage(chatId, headerMessage);

        // Send each account with approve/reject buttons
        for (const account of pageAccounts) {
            const user = await db.getUser(account.user_id);
            const username = user ? (user.username || 'غير محدد') : 'غير محدد';

            const message = language === 'en' ?
                `📧 Email Account:\n\n📧 Email: ${account.email}\n🔑 Password: ${account.password}\n👤 User: ${username}\n🆔 User ID: \`${account.user_id}\`\n📅 Date: ${new Date(account.created_at).toLocaleString()}` :
                `📧 حساب إيميل:\n\n📧 الإيميل: ${account.email}\n🔑 كلمة المرور: ${account.password}\n👤 المستخدم: ${username}\n🆔 آيدي المستخدم: \`${account.user_id}\`\n📅 التاريخ: ${new Date(account.created_at).toLocaleString()}`;

            const inlineKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: language === 'en' ? '✅ Approve' : '✅ قبول',
                                callback_data: `approve_email_${account.id}`
                            },
                            {
                                text: language === 'en' ? '❌ Reject' : '❌ رفض',
                                callback_data: `reject_email_${account.id}`
                            }
                        ]
                    ]
                },
                parse_mode: 'Markdown'
            };

            bot.sendMessage(chatId, message, inlineKeyboard);
        }

        // Add pagination buttons if there are multiple pages
        if (totalPages > 1) {
            const paginationButtons = [];
            
            if (page > 1) {
                paginationButtons.push({
                    text: language === 'en' ? '⬅️ Previous' : '⬅️ السابق',
                    callback_data: `email_page_${page - 1}`
                });
            }
            
            if (page < totalPages) {
                paginationButtons.push({
                    text: language === 'en' ? 'Next ➡️' : 'التالي ➡️',
                    callback_data: `email_page_${page + 1}`
                });
            }

            if (paginationButtons.length > 0) {
                const paginationKeyboard = {
                    reply_markup: {
                        inline_keyboard: [paginationButtons]
                    }
                };

                const paginationMessage = language === 'en' ?
                    `📄 Page ${page} of ${totalPages} • ${accounts.length} total accounts` :
                    `📄 صفحة ${page} من ${totalPages} • ${accounts.length} حساب إجمالي`;

                bot.sendMessage(chatId, paginationMessage, paginationKeyboard);
            }
        }
    } catch (error) {
        console.error('Error showing pending accounts:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading pending accounts' :
            '❌ حدث خطأ في تحميل اليوزرات المعلقة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Show pending Gmail accounts
async function showPendingGmailAccounts(chatId, language, page = 1) {
    try {
        const accounts = await db.getPendingGmailAccounts();
        if (accounts.length === 0) {
            const message = language === 'en' ?
                '📱 No pending Gmail accounts for review\n\n💡 Created Gmail accounts will appear here for your approval' :
                '📱 لا توجد حسابات جيميل معلقة للمراجعة\n\n💡 ستظهر هنا الجيميلات التي ينشئها المستخدمون وتحتاج موافقتك';
            return bot.sendMessage(chatId, message);
        }

        const itemsPerPage = 10;
        const totalPages = Math.ceil(accounts.length / itemsPerPage);
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, accounts.length);
        const pageAccounts = accounts.slice(startIndex, endIndex);

        const headerMessage = language === 'en' ?
            `📱 Pending Gmail Accounts (${startIndex + 1}-${endIndex} of ${accounts.length})\n📄 Page ${page}/${totalPages}` :
            `📱 حسابات الجيميل المعلقة (${startIndex + 1}-${endIndex} من ${accounts.length})\n📄 صفحة ${page}/${totalPages}`;

        bot.sendMessage(chatId, headerMessage);

        // Send each account with approve/reject buttons
        for (const account of pageAccounts) {
            const user = await db.getUser(account.user_id);
            const username = user ? (user.username || 'غير محدد') : 'غير محدد';

            const message = language === 'en' ?
                `📱 Gmail Account:\n\n📧 Email: ${account.email}\n👤 User: ${username}\n🆔 User ID: \`${account.user_id}\`\n📅 Date: ${new Date(account.created_at).toLocaleString()}` :
                `📱 حساب جيميل:\n\n📧 الإيميل: ${account.email}\n👤 المستخدم: ${username}\n🆔 آيدي المستخدم: \`${account.user_id}\`\n📅 التاريخ: ${new Date(account.created_at).toLocaleString()}`;

            const inlineKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: language === 'en' ? '✅ Approve' : '✅ قبول',
                                callback_data: `approve_gmail_${account.id}`
                            },
                            {
                                text: language === 'en' ? '❌ Reject' : '❌ رفض',
                                callback_data: `reject_gmail_${account.id}`
                            }
                        ]
                    ]
                },
                parse_mode: 'Markdown'
            };

            bot.sendMessage(chatId, message, inlineKeyboard);
        }

        // Add pagination buttons if there are multiple pages
        if (totalPages > 1) {
            const paginationButtons = [];
            
            if (page > 1) {
                paginationButtons.push({
                    text: language === 'en' ? '⬅️ Previous' : '⬅️ السابق',
                    callback_data: `gmail_page_${page - 1}`
                });
            }
            
            if (page < totalPages) {
                paginationButtons.push({
                    text: language === 'en' ? 'Next ➡️' : 'التالي ➡️',
                    callback_data: `gmail_page_${page + 1}`
                });
            }

            if (paginationButtons.length > 0) {
                const paginationKeyboard = {
                    reply_markup: {
                        inline_keyboard: [paginationButtons]
                    }
                };

                const paginationMessage = language === 'en' ?
                    `📄 Page ${page} of ${totalPages} • ${accounts.length} total accounts` :
                    `📄 صفحة ${page} من ${totalPages} • ${accounts.length} حساب إجمالي`;

                bot.sendMessage(chatId, paginationMessage, paginationKeyboard);
            }
        }
    } catch (error) {
        console.error('Error showing pending Gmail accounts:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading pending Gmail accounts' :
            '❌ حدث خطأ في تحميل حسابات الجيميل المعلقة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Show pending withdrawal requests
async function showPendingWithdrawalRequests(chatId, language, isMainAdminUser = false) {
    try {
        const requests = await db.getPendingWithdrawalRequests();
        if (requests.length === 0) {
            const message = language === 'en' ?
                '💳 No pending withdrawal requests\n\n💡 User withdrawal requests will appear here for your review' :
                '💳 لا توجد طلبات سحب معلقة\n\n💡 ستظهر هنا طلبات السحب من المستخدمين للمراجعة';
            return bot.sendMessage(chatId, message);
        }

        // Send each request as a separate message with payment button
        for (let i = 0; i < Math.min(requests.length, 10); i++) {
            const request = requests[i];
            const user = await db.getUser(request.user_id);

            // علامة التحقق - للأدمن الرئيسي فقط
            let suspiciousFlag = '';
            if (isMainAdminUser) {
                try {
                    const approvedEmails = await db.getUserApprovedEmailsTotal(request.user_id);
                    const totalApproved = approvedEmails.count || 0;
                    const totalEarned = approvedEmails.totalEarned || 0;

                    if (totalApproved === 0) {
                        suspiciousFlag = ' \u{1F534}';
                    } else {
                        const withdrawalTotal = await db.getUserWithdrawalsTotalBeforeRequest(request.user_id, request.id);
                        const netEarned = totalEarned - withdrawalTotal;
                        if (parseFloat(request.amount) > netEarned * 1.1) {
                            suspiciousFlag = ' \u{1F7E1}';
                        }
                    }
                } catch (flagErr) {
                    console.error('Error calculating flag:', flagErr);
                }
            }

            const message = language === 'en' ?
                `\u{1F4B3} Withdrawal Request #${request.id}${suspiciousFlag}\n\n\u{1F464} User: ${user?.username || 'Unknown'}\n\u{1F194} User ID: \`${request.user_id}\`\n\u{1F4B0} Amount: ${formatBalance(request.amount, request.currency)}\n\u{1F4B3} Method: ${request.method}\n\u{1F4CB} Details: \`${extractWalletNumber(request.details)}\`\n\u{1F4C5} Date: ${new Date(request.created_at).toLocaleString()}\n\n\u{23F3} Status: Pending` :
                `\u{1F4B3} طلب سحب رقم #${request.id}${suspiciousFlag}\n\n\u{1F464} المستخدم: ${user?.username || 'غير محدد'}\n\u{1F194} آيدي المستخدم: \`${request.user_id}\`\n\u{1F4B0} المبلغ: ${formatBalance(request.amount, request.currency)}\n\u{1F4B3} الطريقة: ${request.method}\n\u{1F4CB} التفاصيل: \`${extractWalletNumber(request.details)}\`\n\u{1F4C5} التاريخ: ${new Date(request.created_at).toLocaleString()}\n\n\u{23F3} الحالة: معلق`;

            const keyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: language === 'en' ? '✅ Payment Completed' : '✅ تم الدفع',
                                callback_data: `complete_withdrawal_${request.id}`
                            },
                            {
                                text: language === 'en' ? '↩️ Return Request' : '↩️ إرجاع الطلب',
                                callback_data: `return_withdrawal_${request.id}`
                            }
                        ]
                    ]
                },
                parse_mode: 'Markdown'
            };

            bot.sendMessage(chatId, message, {
                reply_markup: keyboard.reply_markup,
                parse_mode: 'Markdown'
            });
        }

        if (requests.length > 10) {
            const moreMessage = language === 'en' ?
                `\n📊 Showing first 10 requests out of ${requests.length} total` :
                `\n📊 عرض أول 10 طلبات من إجمالي ${requests.length} طلب`;
            bot.sendMessage(chatId, moreMessage);
        }

    } catch (error) {
        console.error('Error showing withdrawal requests:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading withdrawal requests' :
            '❌ حدث خطأ في تحميل طلبات السحب';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Show available accounts with pagination
async function showAvailableAccounts(chatId, language, page = 0) {
    try {
        const limit = 20;
        const offset = page * limit;
        const accounts = await db.getAvailableAccountsList(limit, offset);
        const totalCount = await db.getAvailableAccountsCount();
        const totalPages = Math.ceil(totalCount / limit);

        if (totalCount === 0) {
            const message = language === 'en' ?
                '📦 No available accounts found\n\n💡 Add accounts using "➕ Add Accounts" button' :
                '📦 لا توجد يوزرات متاحة\n\n💡 أضف يوزرات باستخدام زر "➕ إضافة يوزرات"';
            return bot.sendMessage(chatId, message);
        }

        if (accounts.length === 0 && page > 0) {
            // If no accounts on this page, show first page
            return showAvailableAccounts(chatId, language, 0);
        }

        const currentPage = page + 1;
        const startIndex = offset + 1;
        const endIndex = Math.min(offset + accounts.length, totalCount);

        const headerMessage = language === 'en' ?
            `📦 Available Accounts (${startIndex}-${endIndex} of ${totalCount})\n📄 Page ${currentPage}/${totalPages}` :
            `📦 اليوزرات المتاحة (${startIndex}-${endIndex} من ${totalCount})\n📄 صفحة ${currentPage}/${totalPages}`;

        bot.sendMessage(chatId, headerMessage);

        // Send each account with delete button
        for (const account of accounts) {
            const nameInfo = account.first_name || account.last_name ? 
                `\n👤 Name: ${account.first_name || ''} ${account.last_name || ''}`.trim() : '';
            
            const message = language === 'en' ?
                `📧 Email Account:\n\n📧 Email: ${account.email}\n🔑 Password: ${account.password}${nameInfo}\n📅 Added: ${new Date(account.created_at).toLocaleString()}\n\n💡 This account is ready to be assigned to users` :
                `📧 حساب إيميل:\n\n📧 الإيميل: ${account.email}\n🔑 كلمة المرور: ${account.password}${nameInfo}\n📅 تاريخ الإضافة: ${new Date(account.created_at).toLocaleString()}\n\n💡 هذا الحساب جاهز لتعيينه للمستخدمين`;

            const inlineKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: language === 'en' ? '🗑️ Delete Account' : '🗑️ حذف الحساب',
                                callback_data: `delete_account_${account.id}`
                            }
                        ]
                    ]
                }
            };

            bot.sendMessage(chatId, message, inlineKeyboard);
        }

        // Add navigation and control buttons
        const controlButtons = [];

        // Navigation buttons (if multiple pages)
        if (totalPages > 1) {
            const navigationButtons = [];

            // Previous button
            if (page > 0) {
                navigationButtons.push({
                    text: language === 'en' ? '⬅️ Previous' : '⬅️ السابق',
                    callback_data: `accounts_page_${page - 1}`
                });
            }

            // Page indicator
            navigationButtons.push({
                text: `${currentPage}/${totalPages}`,
                callback_data: 'page_info'
            });

            // Next button
            if (page < totalPages - 1) {
                navigationButtons.push({
                    text: language === 'en' ? 'Next ➡️' : 'التالي ➡️',
                    callback_data: `accounts_page_${page + 1}`
                });
            }

            controlButtons.push(navigationButtons);
        }

        // Delete all button (always show if there are accounts)
        if (totalCount > 0) {
            controlButtons.push([
                {
                    text: language === 'en' ? '🗑️ Delete All Accounts' : '🗑️ حذف جميع اليوزرات',
                    callback_data: 'delete_all_accounts_confirm'
                }
            ]);
        }

        // Send control buttons if any exist
        if (controlButtons.length > 0) {
            const controlKeyboard = {
                reply_markup: {
                    inline_keyboard: controlButtons
                }
            };

            const controlMessage = language === 'en' ?
                '🎮 Controls:' :
                '🎮 التحكم:';

            bot.sendMessage(chatId, controlMessage, controlKeyboard);
        }

    } catch (error) {
        console.error('Error showing available accounts:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading available accounts' :
            '❌ حدث خطأ في تحميل اليوزرات المتاحة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Show last users
async function showLastUsers(chatId, language) {
    try {
        const users = await db.getLastUsers(10);
        if (users.length === 0) {
            const message = language === 'en' ?
                '👥 No users found' :
                '👥 لا يوجد مستخدمون';
            return bot.sendMessage(chatId, message);
        }

        const headerMessage = language === 'en' ?
            '👥 Last 10 Users:' :
            '👥 آخر 10 مستخدمين:';

        bot.sendMessage(chatId, headerMessage);

        // Send each user with control buttons
        for (const user of users) {
            const status = user.is_banned ? (language === 'en' ? '🚫 Banned' : '🚫 محظور') : (language === 'en' ? '✅ Active' : '✅ نشط');
            const currency = user.preferred_currency || 'EGP';
            const balance = currency === 'USD' ? user.balance_usd || 0 : user.balance || 0;

            const message = language === 'en' ?
                `👤 User Information:\n\n📝 Username: ${user.username || 'Unknown'}\n🆔 ID: \`${user.id}\`\n💰 Balance: ${formatBalance(balance, currency)}\n💱 Currency: ${currency}\n🌍 Language: ${user.preferred_language || 'ar'}\n📊 Status: ${status}\n📅 Joined: ${new Date(user.created_at).toLocaleDateString()}\n⏰ Last Active: ${new Date(user.last_active || user.created_at).toLocaleDateString()}` :
                `👤 معلومات المستخدم:\n\n📝 اليوزر نيم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${user.id}\`\n💰 الرصيد: ${formatBalance(balance, currency)}\n💱 العملة: ${currency}\n🌍 اللغة: ${user.preferred_language || 'ar'}\n📊 الحالة: ${status}\n📅 تاريخ الانضمام: ${new Date(user.created_at).toLocaleDateString()}\n⏰ آخر نشاط: ${new Date(user.last_active || user.created_at).toLocaleDateString()}`;

            // Create control buttons for each user
            const inlineKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: user.is_banned ?
                                    (language === 'en' ? '✅ Unban' : '✅ إلغاء الحظر') :
                                    (language === 'en' ? '🚫 Ban' : '🚫 حظر'),
                                callback_data: user.is_banned ? `unban_user_${user.id}` : `ban_user_${user.id}`
                            },
                            {
                                text: language === 'en' ? '💰 Edit Balance' : '💰 تعديل الرصيد',
                                callback_data: `edit_balance_${user.id}`
                            }
                        ],
                        [
                            {
                                text: language === 'en' ? '📨 Send Message' : '📨 إرسال رسالة',
                                callback_data: `message_user_${user.id}`
                            },
                            {
                                text: language === 'en' ? '📊 Full Details' : '📊 التفاصيل الكاملة',
                                callback_data: `user_details_${user.id}`
                            }
                        ]
                    ]
                },
                parse_mode: 'Markdown'
            };

            bot.sendMessage(chatId, message, inlineKeyboard);
        }
    } catch (error) {
        console.error('Error showing last users:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading users' :
            '❌ حدث خطأ في تحميل المستخدمين';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Search and show user
async function searchAndShowUser(chatId, searchTerm, language) {
    try {
        const trimmedSearch = searchTerm.trim();
        
        // Check if search term is numeric (likely an ID)
        const isNumeric = /^\d+$/.test(trimmedSearch);
        
        if (isNumeric) {
            // Search by ID only
            const user = await db.getUser(trimmedSearch);
            if (!user) {
                const message = language === 'en' ?
                    `❌ User with ID "${trimmedSearch}" not found` :
                    `❌ لم يتم العثور على مستخدم بالآيدي "${trimmedSearch}"`;
                return bot.sendMessage(chatId, message);
            }
            await displayUserInfo(chatId, user, language);
        } else {
            // Search by username - show multiple results if found
            const users = await db.searchUsers(trimmedSearch, 5);
            if (users.length === 0) {
                const message = language === 'en' ?
                    `❌ No users found with username containing "${trimmedSearch}"\n\n💡 Search tips:\n• Use exact User ID (numbers)\n• Use username (partial match works)\n• Example: "john" will find "john123"` :
                    `❌ لم يتم العثور على مستخدمين باليوزر نيم "${trimmedSearch}"\n\n💡 نصائح البحث:\n• استخدم الآيدي الدقيق (أرقام)\n• استخدم اليوزر نيم (البحث الجزئي يعمل)\n• مثال: "أحمد" سيجد "أحمد123"`;
                return bot.sendMessage(chatId, message);
            }
            
            if (users.length === 1) {
                // Only one result, show it directly
                await displayUserInfo(chatId, users[0], language);
            } else {
                // Multiple results, show list for selection
                await displayMultipleUsers(chatId, users, trimmedSearch, language);
            }
        }
    } catch (error) {
        console.error('Error searching user:', error);
        const errorMessage = language === 'en' ?
            '❌ Error searching for user' :
            '❌ حدث خطأ في البحث عن المستخدم';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Display single user information
async function displayUserInfo(chatId, user, language) {
    const status = user.is_banned ? (language === 'en' ? '🚫 Banned' : '🚫 محظور') : (language === 'en' ? '✅ Active' : '✅ نشط');
    const currency = user.preferred_currency || 'EGP';
    const balance = currency === 'USD' ? user.balance_usd || 0 : user.balance || 0;

    const message = language === 'en' ?
        `👤 User Information:\n\n📝 Username: ${user.username || 'Unknown'}\n🆔 ID: \`${user.id}\`\n💰 Balance: ${formatBalance(balance, currency)}\n💱 Currency: ${currency}\n🌍 Language: ${user.preferred_language || 'ar'}\n📊 Status: ${status}\n📅 Joined: ${new Date(user.created_at).toLocaleString()}\n⏰ Last Active: ${new Date(user.last_active || user.created_at).toLocaleString()}` :
        `👤 معلومات المستخدم:\n\n📝 اليوزر نيم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${user.id}\`\n💰 الرصيد: ${formatBalance(balance, currency)}\n💱 العملة: ${currency}\n🌍 اللغة: ${user.preferred_language || 'ar'}\n📊 الحالة: ${status}\n📅 تاريخ الانضمام: ${new Date(user.created_at).toLocaleString()}\n⏰ آخر نشاط: ${new Date(user.last_active || user.created_at).toLocaleString()}`;

    // Create control buttons for the user
    const inlineKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: user.is_banned ?
                            (language === 'en' ? '✅ Unban' : '✅ إلغاء الحظر') :
                            (language === 'en' ? '🚫 Ban' : '🚫 حظر'),
                        callback_data: user.is_banned ? `unban_user_${user.id}` : `ban_user_${user.id}`
                    },
                    {
                        text: `💰 ${language === 'en' ? 'Edit Balance' : 'تعديل الرصيد'}`,
                        callback_data: `edit_balance_${user.id}`
                    }
                ],
                [
                    {
                        text: `📨 ${language === 'en' ? 'Send Message' : 'إرسال رسالة'}`,
                        callback_data: `message_user_${user.id}`
                    },
                    {
                        text: `🔄 ${language === 'en' ? 'Refresh' : 'تحديث'}`,
                        callback_data: `refresh_user_${user.id}`
                    }
                ]
            ]
        }
    };

    bot.sendMessage(chatId, message, { ...inlineKeyboard, parse_mode: 'Markdown' });
}

// Display multiple users for selection
async function displayMultipleUsers(chatId, users, searchTerm, language) {
    const headerMessage = language === 'en' ?
        `🔍 Found ${users.length} users matching "${searchTerm}":\n\nClick on a user to view details:` :
        `🔍 تم العثور على ${users.length} مستخدمين يطابقون "${searchTerm}":\n\nاضغط على مستخدم لعرض التفاصيل:`;

    const inlineKeyboard = {
        reply_markup: {
            inline_keyboard: users.map(user => [
                {
                    text: `👤 ${user.username || 'غير محدد'} (${user.id})`,
                    callback_data: `user_details_${user.id}`
                }
            ])
        }
    };

    bot.sendMessage(chatId, headerMessage, inlineKeyboard);
}

// Show full user report with complete history
async function showFullUserReport(chatId, userIdInput, language) {
    try {
        const userId = userIdInput.trim();
        
        // Validate user ID
        if (!/^\d+$/.test(userId)) {
            const message = language === 'en' ?
                '❌ Invalid user ID. Please enter numbers only.' :
                '❌ آيدي غير صحيح. أدخل أرقام فقط.';
            return bot.sendMessage(chatId, message);
        }
        
        // Get user data
        const user = await db.getUser(userId);
        if (!user) {
            const message = language === 'en' ?
                `❌ User with ID "${userId}" not found` :
                `❌ لم يتم العثور على مستخدم بالآيدي "${userId}"`;
            return bot.sendMessage(chatId, message);
        }
        
        // Get additional data
        const referralStats = await db.getReferralStats(userId);
        const userReferrals = await db.getUserReferrals(userId);
        const referredBy = await db.getReferralByReferredId(userId);
        
        // Calculate statistics
        const status = user.is_banned ? (language === 'en' ? '🚫 Banned' : '🚫 محظور') : (language === 'en' ? '✅ Active' : '✅ نشط');
        const currency = user.preferred_currency || 'EGP';
        const balanceEGP = user.balance || 0;
        const balanceUSD = user.balance_usd || 0;
        const joinDate = new Date(user.created_at).toLocaleString();
        const lastActive = new Date(user.last_active || user.created_at).toLocaleString();
        const accountAge = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));
        
        // Build comprehensive report
        const report = language === 'en' ?
            `📋 FULL USER REPORT\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 BASIC INFORMATION\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 Username: ${user.username || 'Not set'}\n` +
            `🆔 User ID: \`${user.id}\`\n` +
            `📊 Status: ${status}\n` +
            `🌍 Language: ${user.preferred_language === 'en' ? '🇺🇸 English' : '🇸🇦 Arabic'}\n` +
            `💱 Preferred Currency: ${currency}\n\n` +
            `💰 FINANCIAL INFORMATION\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💵 Balance (USD): ${formatBalance(balanceUSD, 'USD')}\n` +
            `💰 Balance (EGP): ${formatBalance(balanceEGP, 'EGP')}\n` +
            `💳 Active Currency: ${currency}\n` +
            `💸 Current Balance: ${formatBalance(currency === 'USD' ? balanceUSD : balanceEGP, currency)}\n\n` +
            `🔗 REFERRAL SYSTEM\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎯 Referral Code: ${user.referral_code || 'Not generated'}\n` +
            `👥 Total Referrals: ${referralStats.totalReferrals}\n` +
            `✅ Completed Referrals: ${referralStats.completedReferrals}\n` +
            `💰 Referral Earnings: ${referralStats.totalEarnings}\n` +
            `👤 Referred By: ${referredBy ? `User ${referredBy.referrer_id}` : 'Direct signup'}\n\n` +
            `📅 ACCOUNT ACTIVITY\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📆 Join Date: ${joinDate}\n` +
            `⏰ Last Active: ${lastActive}\n` +
            `📊 Account Age: ${accountAge} days\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 Report generated: ${new Date().toLocaleString()}`
            :
            `📋 تقرير المستخدم الكامل\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 المعلومات الأساسية\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 اليوزر نيم: ${user.username || 'غير محدد'}\n` +
            `🆔 الآيدي: \`${user.id}\`\n` +
            `📊 الحالة: ${status}\n` +
            `🌍 اللغة: ${user.preferred_language === 'en' ? '🇺🇸 إنجليزي' : '🇸🇦 عربي'}\n` +
            `💱 العملة المفضلة: ${currency}\n\n` +
            `💰 المعلومات المالية\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💵 الرصيد (دولار): ${formatBalance(balanceUSD, 'USD')}\n` +
            `💰 الرصيد (جنيه): ${formatBalance(balanceEGP, 'EGP')}\n` +
            `💳 العملة النشطة: ${currency}\n` +
            `💸 الرصيد الحالي: ${formatBalance(currency === 'USD' ? balanceUSD : balanceEGP, currency)}\n\n` +
            `🔗 نظام الإحالة\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎯 كود الإحالة: ${user.referral_code || 'لم يتم إنشاؤه'}\n` +
            `👥 إجمالي الإحالات: ${referralStats.totalReferrals}\n` +
            `✅ الإحالات المكتملة: ${referralStats.completedReferrals}\n` +
            `💰 أرباح الإحالة: ${referralStats.totalEarnings}\n` +
            `👤 تمت إحالته بواسطة: ${referredBy ? `المستخدم ${referredBy.referrer_id}` : 'تسجيل مباشر'}\n\n` +
            `📅 نشاط الحساب\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📆 تاريخ الانضمام: ${joinDate}\n` +
            `⏰ آخر نشاط: ${lastActive}\n` +
            `📊 عمر الحساب: ${accountAge} يوم\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 تم إنشاء التقرير: ${new Date().toLocaleString()}`;
        
        // Send report
        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        
        // Add control buttons
        const controlKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: language === 'en' ? '✏️ Edit Balance' : '✏️ تعديل الرصيد',
                            callback_data: `edit_balance_${userId}`
                        },
                        {
                            text: language === 'en' ? '📨 Send Message' : '📨 إرسال رسالة',
                            callback_data: `message_user_${userId}`
                        }
                    ],
                    [
                        {
                            text: user.is_banned ? 
                                (language === 'en' ? '✅ Unban User' : '✅ إلغاء الحظر') :
                                (language === 'en' ? '🚫 Ban User' : '🚫 حظر المستخدم'),
                            callback_data: user.is_banned ? `unban_user_${userId}` : `ban_user_${userId}`
                        }
                    ],
                    [
                        {
                            text: language === 'en' ? '🔄 Refresh' : '🔄 تحديث',
                            callback_data: `refresh_report_${userId}`
                        }
                    ]
                ]
            }
        };
        
        bot.sendMessage(chatId, language === 'en' ? '🎮 User Actions:' : '🎮 إجراءات المستخدم:', controlKeyboard);
        
    } catch (error) {
        console.error('Error showing full user report:', error);
        const errorMessage = language === 'en' ?
            '❌ Error generating user report' :
            '❌ حدث خطأ في إنشاء تقرير المستخدم';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Send broadcast message
async function sendBroadcastMessage(chatId, messageText, language) {
    try {
        const users = await db.getLastUsers(1000); // Get all users (limit 1000 for safety)
        let sentCount = 0;
        let failedCount = 0;

        const statusMessage = language === 'en' ?
            '📢 Sending broadcast message...' :
            '📢 جاري إرسال الرسالة الجماعية...';
        bot.sendMessage(chatId, statusMessage);

        for (const user of users) {
            try {
                // Note: For broadcast messages, we send the same message to all users
                // If you want language-specific broadcasts, you would need to:
                // 1. Create separate Arabic and English versions of the message
                // 2. Get each user's language and send appropriate version
                // For now, sending the admin's message as-is to all users
                const result = await safeSendMessage(user.id, messageText);
                if (result === null) {
                    // Message failed to send (user blocked bot, etc.)
                    failedCount++;
                } else {
                    sentCount++;
                }
                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (error) {
                failedCount++;
                console.error(`Failed to send message to user ${user.id}:`, error.message);
            }
        }

        const resultMessage = language === 'en' ?
            `✅ Broadcast completed!\n\n📊 Results:\n✅ Sent: ${sentCount}\n❌ Failed: ${failedCount}\n📝 Message: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"` :
            `✅ تم إرسال الرسالة الجماعية!\n\n📊 النتائج:\n✅ تم الإرسال: ${sentCount}\n❌ فشل: ${failedCount}\n📝 الرسالة: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`;

        bot.sendMessage(chatId, resultMessage);
    } catch (error) {
        console.error('Error sending broadcast message:', error);
        const errorMessage = language === 'en' ?
            '❌ Error sending broadcast message' :
            '❌ حدث خطأ في إرسال الرسالة الجماعية';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Send private message
async function sendPrivateMessage(chatId, targetUserId, messageText, language) {
    try {
        await safeSendMessage(targetUserId, messageText);
        const successMessage = language === 'en' ?
            `✅ Message sent successfully to user ${targetUserId}` :
            `✅ تم إرسال الرسالة بنجاح للمستخدم ${targetUserId}`;
        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error sending private message:', error);
        const errorMessage = language === 'en' ?
            `❌ Failed to send message to user ${targetUserId}` :
            `❌ فشل في إرسال الرسالة للمستخدم ${targetUserId}`;
        bot.sendMessage(chatId, errorMessage);
    }
}

// Add accounts
async function addAccounts(chatId, userId, accountsText, language) {
    try {
        console.log('addAccounts called with userId:', userId);
        // Delete old state first
        userStates.delete(userId);
        console.log('Deleted old userState');
        
        const lines = accountsText.split('\n').filter(line => line.trim());
        let addedCount = 0;
        let failedCount = 0;

        for (const line of lines) {
            const parts = line.trim().split(':');
            if (parts.length >= 2) {
                const email = parts[0].trim();
                const password = parts[1].trim();
                const firstName = parts.length > 2 ? parts[2].trim() : null;
                const lastName = parts.length > 3 ? parts[3].trim() : null;

                try {
                    await db.addAvailableAccount(email, password, firstName, lastName);
                    addedCount++;
                } catch (error) {
                    failedCount++;
                    console.error(`Failed to add account ${email}:`, error.message);
                }
            } else {
                failedCount++;
            }
        }

        const resultMessage = language === 'en' ?
            `✅ Accounts processing completed!\n\n📊 Results:\n✅ Added/Updated: ${addedCount}\n❌ Failed: ${failedCount}\n\n💡 Duplicate accounts were updated with new data\n💡 Failed accounts may have invalid format\n\n📝 Supported formats:\n• email:password\n• email:password:firstname:lastname` :
            `✅ تم معالجة اليوزرات!\n\n📊 النتائج:\n✅ تم الإضافة/التحديث: ${addedCount}\n❌ فشل: ${failedCount}\n\n💡 اليوزرات المكررة تم تحديث بياناتها\n💡 اليوزرات الفاشلة قد تكون بتنسيق خاطئ\n\n📝 التنسيقات المدعومة:\n• email:password\n• email:password:firstname:lastname`;

        bot.sendMessage(chatId, resultMessage);

        // Notify all users about new accounts if any were added successfully
        if (addedCount > 0) {
            const notificationsEnabled = await db.getSetting('notify_users_new_accounts') !== 'false';
            if (notificationsEnabled) {
                // Ask for confirmation before sending notifications
                console.log('Setting userState for userId:', userId, 'with value:', 'notify_new_accounts_confirm:' + addedCount);
                userStates.set(userId, 'notify_new_accounts_confirm:' + addedCount);
                console.log('UserState after setting:', userStates.get(userId));
                
                const userCount = await db.getUserCount();
                const confirmMessage = language === 'en' ?
                    `📢 New Accounts Notification\n\n✅ ${addedCount} accounts added successfully\n👥 ${userCount} users will be notified\n\n⚠️ Do you want to send notification to all users?` :
                    `📢 إشعار الحسابات الجديدة\n\n✅ تم إضافة ${addedCount} حساب بنجاح\n👥 سيتم إشعار ${userCount} مستخدم\n\n⚠️ هل تريد إرسال إشعار لجميع المستخدمين؟`;
                
                const confirmKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: language === 'en' ? '✅ Yes, Notify' : '✅ نعم، أرسل الإشعار',
                                    callback_data: 'confirm_notify_accounts'
                                }
                            ],
                            [
                                {
                                    text: language === 'en' ? '❌ No, Skip' : '❌ لا، تخطي',
                                    callback_data: 'cancel_notify_accounts'
                                }
                            ]
                        ]
                    }
                };
                
                bot.sendMessage(chatId, confirmMessage, confirmKeyboard);
            }
        }
    } catch (error) {
        console.error('Error adding accounts:', error);
        const errorMessage = language === 'en' ?
            '❌ Error adding accounts' :
            '❌ حدث خطأ في إضافة اليوزرات';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Notify all users about new accounts
async function notifyUsersAboutNewAccounts(addedCount) {
    try {
        console.log(`📢 Notifying users about ${addedCount} new accounts...`);
        
        const users = await db.getLastUsers(1000); // Get all users (limit 1000 for safety)
        let notifiedCount = 0;
        let failedCount = 0;

        for (const user of users) {
            try {
                // Get user's preferred language
                const userLanguage = await getUserLanguage(user.id);
                
                const notificationMessage = userLanguage === 'en' ?
                    `🎉 Great News!\n\n📧 New high-value email accounts have been added!\n💰 Higher rewards available now\n\n🚀 Go to Tasks menu to start earning!\n\n⚡ Don't miss out - limited accounts available!` :
                    `🎉 أخبار رائعة!\n\n📧 تم إضافة إيميلات جديدة بسعر مرتفع!\n💰 مكافآت أعلى متاحة الآن\n\n🚀 اذهب لقائمة المهام لتبدأ الربح!\n\n⚡ لا تفوت الفرصة - عدد محدود من الحسابات!`;

                const result = await safeSendMessage(user.id, notificationMessage);
                if (result === null) {
                    failedCount++;
                } else {
                    notifiedCount++;
                }

                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                failedCount++;
                console.error(`Failed to notify user ${user.id}:`, error.message);
            }
        }

        console.log(`📊 Notification results: ✅ Sent: ${notifiedCount}, ❌ Failed: ${failedCount}`);
    } catch (error) {
        console.error('Error notifying users about new accounts:', error);
    }
}

// Toggle new accounts notifications
async function toggleNewAccountsNotifications(chatId, language) {
    try {
        const currentSetting = await db.getSetting('notify_users_new_accounts') || 'true';
        const isEnabled = currentSetting !== 'false';
        const newSetting = isEnabled ? 'false' : 'true';
        
        await db.setSetting('notify_users_new_accounts', newSetting);
        
        const statusText = isEnabled ? 
            (language === 'en' ? '❌ Disabled' : '❌ معطل') : 
            (language === 'en' ? '✅ Enabled' : '✅ مفعل');
            
        const message = language === 'en' ?
            `📢 New Accounts Notifications: ${statusText}\n\n💡 When enabled, all users will be notified when you add new email accounts\n\n📝 Notification message:\n"🎉 New high-value email accounts have been added! Higher rewards available now 🚀"` :
            `📢 إشعارات اليوزرات الجديدة: ${statusText}\n\n💡 عند التفعيل، سيتم إشعار جميع المستخدمين عند إضافة إيميلات جديدة\n\n📝 رسالة الإشعار:\n"🎉 تم إضافة إيميلات جديدة بسعر مرتفع! مكافآت أعلى متاحة الآن 🚀"`;

        const settingsKeyboard = keyboards.getKeyboard('settingsKeyboard', language);
        bot.sendMessage(chatId, message, settingsKeyboard);
    } catch (error) {
        console.error('Error toggling notifications:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating notification settings' :
            '❌ حدث خطأ في تحديث إعدادات الإشعارات';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Clean duplicate accounts
async function cleanDuplicateAccounts(chatId, language) {
    try {
        const beforeCount = await db.getAvailableAccountsCount();
        await db.cleanDuplicateAccounts();
        const afterCount = await db.getAvailableAccountsCount();
        const removedCount = beforeCount - afterCount;

        const message = language === 'en' ?
            `🧹 Duplicate accounts cleanup completed!\n\n📊 Results:\n📦 Before: ${beforeCount} accounts\n📦 After: ${afterCount} accounts\n🗑️ Removed: ${removedCount} duplicates\n\n✅ Database optimized!` :
            `🧹 تم تنظيف اليوزرات المكررة!\n\n📊 النتائج:\n📦 قبل: ${beforeCount} يوزر\n📦 بعد: ${afterCount} يوزر\n🗑️ تم الحذف: ${removedCount} مكرر\n\n✅ تم تحسين قاعدة البيانات!`;

        bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error cleaning duplicate accounts:', error);
        const errorMessage = language === 'en' ?
            '❌ Error cleaning duplicate accounts' :
            '❌ حدث خطأ في تنظيف اليوزرات المكررة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change minimum withdrawal
async function changeMinWithdrawal(chatId, newAmount, language) {
    try {
        const amount = parseFloat(newAmount);
        if (isNaN(amount) || amount <= 0) {
            const errorMessage = language === 'en' ?
                '❌ Invalid amount. Please enter a valid number.' :
                '❌ مبلغ غير صحيح. يرجى إدخال رقم صحيح.';
            return bot.sendMessage(chatId, errorMessage);
        }

        // Save minimum withdrawal in EGP
        await db.setSetting('min_withdrawal', amount.toString());
        
        // Calculate and save USD equivalent
        const usdEquivalent = await convertEGPToUSD(amount);
        await db.setSetting('min_withdrawal_usd', usdEquivalent.toString());

        const successMessage = language === 'en' ?
            `✅ Minimum withdrawal updated successfully!\n\n💳 New minimum:\n💰 EGP: ${formatBalance(amount, 'EGP')}\n💵 USD: $${usdEquivalent.toFixed(3)}\n\n💡 Both currencies updated automatically!` :
            `✅ تم تحديث الحد الأدنى للسحب بنجاح!\n\n💳 الحد الجديد:\n💰 جنيه: ${formatBalance(amount, 'EGP')}\n💵 دولار: $${usdEquivalent.toFixed(3)}\n\n💡 تم تحديث العملتين تلقائياً!`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing minimum withdrawal:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating minimum withdrawal' :
            '❌ حدث خطأ في تحديث الحد الأدنى للسحب';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change exchange rate
async function changeExchangeRate(chatId, newRate, language) {
    try {
        const rate = parseFloat(newRate);
        if (isNaN(rate) || rate <= 0) {
            const errorMessage = language === 'en' ?
                '❌ Invalid rate. Please enter a valid number.' :
                '❌ سعر غير صحيح. يرجى إدخال رقم صحيح.';
            return bot.sendMessage(chatId, errorMessage);
        }

        await db.setSetting('usd_to_egp_rate', rate.toString());

        const successMessage = language === 'en' ?
            `✅ Exchange rate updated successfully!\n\n💱 New rate: 1$ = ${rate} EGP\n\n⚠️ This will affect all future currency conversions` :
            `✅ تم تحديث سعر الصرف بنجاح!\n\n💱 السعر الجديد: 1$ = ${rate} جنيه\n\n⚠️ هذا سيؤثر على جميع تحويلات العملة المستقبلية`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing exchange rate:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating exchange rate' :
            '❌ حدث خطأ في تحديث سعر الصرف';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change support message
async function changeSupportMessage(chatId, newMessage, language) {
    try {
        await db.setSetting('support_message', newMessage);

        const successMessage = language === 'en' ?
            `✅ Support message updated successfully!\n\n💬 New message: "${newMessage.substring(0, 100)}${newMessage.length > 100 ? '...' : ''}"` :
            `✅ تم تحديث رسالة الدعم بنجاح!\n\n💬 الرسالة الجديدة: "${newMessage.substring(0, 100)}${newMessage.length > 100 ? '...' : ''}"`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing support message:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating support message' :
            '❌ حدث خطأ في تحديث رسالة الدعم';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change email task reward
async function changeEmailTaskReward(chatId, newReward, language) {
    try {
        const reward = parseFloat(newReward);
        if (isNaN(reward) || reward <= 0) {
            const errorMessage = language === 'en' ?
                '❌ Invalid reward amount. Please enter a valid number.' :
                '❌ مبلغ مكافأة غير صحيح. يرجى إدخال رقم صحيح.';
            return bot.sendMessage(chatId, errorMessage);
        }

        await db.setSetting('task_reward', reward.toString());

        const successMessage = language === 'en' ?
            `✅ Email task reward updated successfully!\n\n💰 New reward: ${formatBalance(reward, 'EGP')}` :
            `✅ تم تحديث مكافأة مهمة اليوزرات بنجاح!\n\n💰 المكافأة الجديدة: ${formatBalance(reward, 'EGP')}`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing email task reward:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating email task reward' :
            '❌ حدث خطأ في تحديث مكافأة مهمة اليوزرات';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change Gmail task reward
async function changeGmailTaskReward(chatId, newReward, language) {
    try {
        const reward = parseFloat(newReward);
        if (isNaN(reward) || reward <= 0) {
            const errorMessage = language === 'en' ?
                '❌ Invalid reward amount. Please enter a valid number.' :
                '❌ مبلغ مكافأة غير صحيح. يرجى إدخال رقم صحيح.';
            return bot.sendMessage(chatId, errorMessage);
        }

        await db.setSetting('gmail_task_reward', reward.toString());

        const successMessage = language === 'en' ?
            `✅ Gmail task reward updated successfully!\n\n📱 New reward: ${formatBalance(reward, 'EGP')}` :
            `✅ تم تحديث مكافأة مهمة الجيميل بنجاح!\n\n📱 المكافأة الجديدة: ${formatBalance(reward, 'EGP')}`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing Gmail task reward:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating Gmail task reward' :
            '❌ حدث خطأ في تحديث مكافأة مهمة الجيميل';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change Gmail password
async function changeGmailPassword(chatId, newPassword, language) {
    try {
        await db.setSetting('gmail_password', newPassword);

        const successMessage = language === 'en' ?
            `✅ Gmail password updated successfully!\n\n🔑 New password: ${newPassword}\n\n⚠️ This will be used for all future Gmail tasks` :
            `✅ تم تحديث كلمة مرور الجيميل بنجاح!\n\n🔑 كلمة المرور الجديدة: ${newPassword}\n\n⚠️ سيتم استخدامها في جميع مهام الجيميل المستقبلية`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing Gmail password:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating Gmail password' :
            '❌ حدث خطأ في تحديث كلمة مرور الجيميل';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Toggle Email Tasks (Enable/Disable)
async function toggleEmailTasks(chatId, language) {
    try {
        const currentStatus = await db.getSetting('tasks_enabled');
        const isEnabled = currentStatus !== 'false';
        
        // Toggle status
        const newStatus = isEnabled ? 'false' : 'true';
        await db.setSetting('tasks_enabled', newStatus);
        
        const statusText = !isEnabled ? 
            (language === 'en' ? '✅ Enabled' : '✅ مفعلة') : 
            (language === 'en' ? '❌ Disabled' : '❌ معطلة');
        
        const message = language === 'en' ?
            `📧 Email Creation Task Status:\n\n${statusText}\n\n💡 Users ${!isEnabled ? 'can now' : 'cannot'} access email creation tasks` :
            `📧 حالة مهمة إنشاء اليوزرات:\n\n${statusText}\n\n💡 المستخدمون ${!isEnabled ? 'يمكنهم الآن' : 'لا يمكنهم'} الوصول لمهام إنشاء اليوزرات`;
        
        // Create inline keyboard for quick toggle
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: !isEnabled ? 
                                (language === 'en' ? '❌ Disable' : '❌ تعطيل') : 
                                (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                            callback_data: 'toggle_email_tasks'
                        }
                    ]
                ]
            }
        };
        
        bot.sendMessage(chatId, message, keyboard);
    } catch (error) {
        console.error('Error toggling email tasks:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating task status' :
            '❌ حدث خطأ في تحديث حالة المهمة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Toggle Gmail Tasks (Enable/Disable)
async function toggleGmailTasks(chatId, language) {
    try {
        const currentStatus = await db.getSetting('gmail_tasks_enabled');
        const isEnabled = currentStatus !== 'false';
        
        // Toggle status
        const newStatus = isEnabled ? 'false' : 'true';
        await db.setSetting('gmail_tasks_enabled', newStatus);
        
        const statusText = !isEnabled ? 
            (language === 'en' ? '✅ Enabled' : '✅ مفعلة') : 
            (language === 'en' ? '❌ Disabled' : '❌ معطلة');
        
        const message = language === 'en' ?
            `📱 Gmail Creation Task Status:\n\n${statusText}\n\n💡 Users ${!isEnabled ? 'can now' : 'cannot'} access Gmail creation tasks` :
            `📱 حالة مهمة إنشاء الجيميل:\n\n${statusText}\n\n💡 المستخدمون ${!isEnabled ? 'يمكنهم الآن' : 'لا يمكنهم'} الوصول لمهام إنشاء الجيميل`;
        
        // Create inline keyboard for quick toggle
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: !isEnabled ? 
                                (language === 'en' ? '❌ Disable' : '❌ تعطيل') : 
                                (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                            callback_data: 'toggle_gmail_tasks'
                        }
                    ]
                ]
            }
        };
        
        bot.sendMessage(chatId, message, keyboard);
    } catch (error) {
        console.error('Error toggling Gmail tasks:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating task status' :
            '❌ حدث خطأ في تحديث حالة المهمة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Toggle Egyptian IP Check
async function toggleEgyptianIPCheck(chatId, language) {
    try {
        const currentStatus = await db.getSetting('egyptian_ip_only');
        const isEnabled = currentStatus === 'true';
        
        // Toggle status
        const newStatus = isEnabled ? 'false' : 'true';
        await db.setSetting('egyptian_ip_only', newStatus);
        
        const statusText = !isEnabled ? 
            (language === 'en' ? '✅ Enabled' : '✅ مفعل') : 
            (language === 'en' ? '❌ Disabled' : '❌ معطل');
        
        const warningText = !isEnabled ? 
            (language === 'en' ? 
                '\n\n⚠️ Warning Message to Users:\n"We only need Egyptian email addresses. Any non-Egyptian email addresses will be blocked."' : 
                '\n\n⚠️ رسالة التحذير للمستخدمين:\n"نحتاج ايميلات مصرية فقط. اي ايميلات غير مصرية سترسل سيتم حظر المستخدم نهائيا"') : 
            '';
        
        const message = language === 'en' ?
            `🇪🇬 Egyptian IP Verification:\n\n${statusText}\n\n💡 ${!isEnabled ? 'Only Egyptian IPs can submit Gmail accounts' : 'All IPs can submit Gmail accounts'}${warningText}` :
            `🇪🇬 التحقق من IP المصري:\n\n${statusText}\n\n💡 ${!isEnabled ? 'فقط الـ IP المصرية يمكنها إرسال حسابات الجيميل' : 'جميع الـ IP يمكنها إرسال حسابات الجيميل'}${warningText}`;
        
        // Create inline keyboard for quick toggle
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: !isEnabled ? 
                                (language === 'en' ? '❌ Disable' : '❌ تعطيل') : 
                                (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                            callback_data: 'toggle_egyptian_ip'
                        }
                    ]
                ]
            }
        };
        
        bot.sendMessage(chatId, message, keyboard);
        
        // If enabled, send warning message to all users
        if (!isEnabled) {
            const adminConfirmMessage = language === 'en' ?
                '📢 Sending warning message to all users...' :
                '📢 جاري إرسال رسالة التحذير لجميع المستخدمين...';
            bot.sendMessage(chatId, adminConfirmMessage);
            
            // Get all users and send warning
            const users = await db.getAllUsers();
            let sentCount = 0;
            let failedCount = 0;
            
            for (const user of users) {
                try {
                    const userLanguage = user.preferred_language || 'ar';
                    const userWarningMessage = userLanguage === 'en' ?
                        '⚠️ IMPORTANT ANNOUNCEMENT\n\n🇪🇬 Egyptian IP Verification is now ENABLED\n\n📍 From now on, you must share your location to verify you are in Egypt before submitting Gmail accounts.\n\n⚠️ WARNING:\nWe only need Egyptian email addresses. Any non-Egyptian email addresses will be blocked.\n\n🚫 Users outside Egypt will be permanently banned.\n\n💡 Make sure you are in Egypt before starting Gmail tasks.' :
                        '⚠️ إعلان مهم\n\n🇪🇬 تم تفعيل التحقق من IP المصري\n\n📍 من الآن فصاعداً، يجب عليك مشاركة موقعك للتحقق من أنك في مصر قبل إرسال حسابات الجيميل.\n\n⚠️ تحذير:\nنحتاج ايميلات مصرية فقط. اي ايميلات غير مصرية سترسل سيتم حظر المستخدم نهائيا.\n\n🚫 المستخدمون خارج مصر سيتم حظرهم نهائياً.\n\n💡 تأكد من أنك في مصر قبل بدء مهام الجيميل.';
                    
                    await safeSendMessage(user.id, userWarningMessage);
                    sentCount++;
                    
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    console.error(`Failed to send warning to user ${user.id}:`, error);
                    failedCount++;
                }
            }
            
            const summaryMessage = language === 'en' ?
                `✅ Warning message sent!\n\n📊 Statistics:\n✅ Sent: ${sentCount}\n❌ Failed: ${failedCount}\n👥 Total: ${users.length}` :
                `✅ تم إرسال رسالة التحذير!\n\n📊 الإحصائيات:\n✅ تم الإرسال: ${sentCount}\n❌ فشل: ${failedCount}\n👥 الإجمالي: ${users.length}`;
            
            bot.sendMessage(chatId, summaryMessage);
        }
    } catch (error) {
        console.error('Error toggling Egyptian IP check:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating IP verification status' :
            '❌ حدث خطأ في تحديث حالة التحقق من IP';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Handle toggle email tasks button
async function handleToggleEmailTasks(chatId, messageId, language) {
    try {
        const currentStatus = await db.getSetting('tasks_enabled');
        const isEnabled = currentStatus !== 'false';
        
        // Toggle status
        const newStatus = isEnabled ? 'false' : 'true';
        await db.setSetting('tasks_enabled', newStatus);
        
        const statusText = !isEnabled ? 
            (language === 'en' ? '✅ Enabled' : '✅ مفعلة') : 
            (language === 'en' ? '❌ Disabled' : '❌ معطلة');
        
        const message = language === 'en' ?
            `📧 Email Creation Task Status:\n\n${statusText}\n\n💡 Users ${!isEnabled ? 'can now' : 'cannot'} access email creation tasks` :
            `📧 حالة مهمة إنشاء اليوزرات:\n\n${statusText}\n\n💡 المستخدمون ${!isEnabled ? 'يمكنهم الآن' : 'لا يمكنهم'} الوصول لمهام إنشاء اليوزرات`;
        
        // Create inline keyboard for quick toggle
        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: !isEnabled ? 
                            (language === 'en' ? '❌ Disable' : '❌ تعطيل') : 
                            (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                        callback_data: 'toggle_email_tasks'
                    }
                ]
            ]
        };
        
        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboard
        });
    } catch (error) {
        console.error('Error handling toggle email tasks:', error);
    }
}

// Handle toggle Gmail tasks button
async function handleToggleGmailTasks(chatId, messageId, language) {
    try {
        const currentStatus = await db.getSetting('gmail_tasks_enabled');
        const isEnabled = currentStatus !== 'false';
        
        // Toggle status
        const newStatus = isEnabled ? 'false' : 'true';
        await db.setSetting('gmail_tasks_enabled', newStatus);
        
        const statusText = !isEnabled ? 
            (language === 'en' ? '✅ Enabled' : '✅ مفعلة') : 
            (language === 'en' ? '❌ Disabled' : '❌ معطلة');
        
        const message = language === 'en' ?
            `📱 Gmail Creation Task Status:\n\n${statusText}\n\n💡 Users ${!isEnabled ? 'can now' : 'cannot'} access Gmail creation tasks` :
            `📱 حالة مهمة إنشاء الجيميل:\n\n${statusText}\n\n💡 المستخدمون ${!isEnabled ? 'يمكنهم الآن' : 'لا يمكنهم'} الوصول لمهام إنشاء الجيميل`;
        
        // Create inline keyboard for quick toggle
        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: !isEnabled ? 
                            (language === 'en' ? '❌ Disable' : '❌ تعطيل') : 
                            (language === 'en' ? '✅ Enable' : '✅ تفعيل'),
                        callback_data: 'toggle_gmail_tasks'
                    }
                ]
            ]
        };
        
        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboard
        });
    } catch (error) {
        console.error('Error handling toggle Gmail tasks:', error);
    }
}

// Change referral reward EGP
async function changeReferralRewardEGP(chatId, newReward, language) {
    try {
        const reward = parseFloat(newReward);
        if (isNaN(reward) || reward < 0) {
            const errorMessage = language === 'en' ?
                '❌ Please enter a valid positive number' :
                '❌ يرجى إدخال رقم صحيح موجب';
            bot.sendMessage(chatId, errorMessage);
            return;
        }

        await db.setSetting('referral_reward_egp', reward.toString());

        const successMessage = language === 'en' ?
            `✅ Referral reward (EGP) updated successfully!\n\n💰 New reward: ${formatBalance(reward, 'EGP')}` :
            `✅ تم تحديث مكافأة الإحالة (جنيه) بنجاح!\n\n💰 المكافأة الجديدة: ${formatBalance(reward, 'EGP')}`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing referral reward EGP:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating referral reward (EGP)' :
            '❌ حدث خطأ في تحديث مكافأة الإحالة (جنيه)';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Change referral reward USD
async function changeReferralRewardUSD(chatId, newReward, language) {
    try {
        const reward = parseFloat(newReward);
        if (isNaN(reward) || reward < 0) {
            const errorMessage = language === 'en' ?
                '❌ Please enter a valid positive number' :
                '❌ يرجى إدخال رقم صحيح موجب';
            bot.sendMessage(chatId, errorMessage);
            return;
        }

        await db.setSetting('referral_reward_usd', reward.toString());

        const successMessage = language === 'en' ?
            `✅ Referral reward (USD) updated successfully!\n\n💵 New reward: ${formatBalance(reward, 'USD')}` :
            `✅ تم تحديث مكافأة الإحالة (دولار) بنجاح!\n\n💵 المكافأة الجديدة: ${formatBalance(reward, 'USD')}`;

        bot.sendMessage(chatId, successMessage);
    } catch (error) {
        console.error('Error changing referral reward USD:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating referral reward (USD)' :
            '❌ حدث خطأ في تحديث مكافأة الإحالة (دولار)';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Add reward to user balance
async function addRewardToUser(userId, taskType) {
    try {
        const user = await db.getUser(userId);
        if (!user) return false;

        // Get reward amount from database or config
        let rewardAmount;
        if (taskType === 'gmail') {
            rewardAmount = parseFloat(await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD);
        } else {
            rewardAmount = parseFloat(await db.getSetting('task_reward') || config.TASK_REWARD);
        }

        // Add reward based on user's preferred currency
        if (user.preferred_currency === 'USD') {
            const usdReward = await convertEGPToUSD(rewardAmount);
            const newBalance = (user.balance_usd || 0) + usdReward;
            await db.setUserUSDBalance(userId, newBalance);
        } else {
            const newBalance = (user.balance || 0) + rewardAmount;
            await db.setUserBalance(userId, newBalance);
        }

        return true;
    } catch (error) {
        console.error('Error adding reward to user:', error);
        return false;
    }
}

// Approve user task (for inline buttons - can be added later)
async function approveUserTask(accountId, taskType = 'email') {
    try {
        // This function can be expanded to handle inline button approvals
        // For now, it's a placeholder for future inline keyboard implementation
        console.log(`Task approved: Account ID ${accountId}, Type: ${taskType}`);
        return true;
    } catch (error) {
        console.error('Error approving task:', error);
        return false;
    }
}

// Reject user task (for inline buttons - can be added later)
async function rejectUserTask(accountId, taskType = 'email') {
    try {
        // This function can be expanded to handle inline button rejections
        // For now, it's a placeholder for future inline keyboard implementation
        console.log(`Task rejected: Account ID ${accountId}, Type: ${taskType}`);
        return true;
    } catch (error) {
        console.error('Error rejecting task:', error);
        return false;
    }
}

// Handle email account approval/rejection
async function handleEmailApproval(chatId, accountId, messageId, language, isApproved) {
    try {
        // Get account directly by ID (faster than fetching all pending)
        const account = await db.getPendingAccountById(accountId);

        if (!account || (account.status !== 'pending' && account.status !== null)) {
            const errorMessage = language === 'en' ?
                '❌ Account not found or already processed' :
                '❌ الحساب غير موجود أو تم معالجته بالفعل';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Mark as processing FIRST to prevent duplicate processing (keep record for history)
        await db.updatePendingAccountStatus(account.id, 'processing');

        if (isApproved) {
            // Add reward to user
            const rewardAdded = await addRewardToUser(account.user_id, 'email');

            if (rewardAdded) {
                // Get reward amount for display
                const rewardAmount = parseFloat(await db.getSetting('task_reward') || config.TASK_REWARD);
                const user = await db.getUser(account.user_id);
                const currency = user?.preferred_currency || 'EGP';
                const displayReward = currency === 'USD' ?
                    `$${(await convertEGPToUSD(rewardAmount)).toFixed(3)}` :
                    formatBalance(rewardAmount, 'EGP');

                // Get user's preferred language for notification
                const userLanguage = await getUserLanguage(account.user_id);

                // Notify user in their preferred language
                const approvalDate = new Date().toISOString().replace('T', ' ').substring(0, 16);
                const userMessage = userLanguage === 'en' ?
                    `✅ Your email account has been approved!\n\n💰 Reward added: ${displayReward}\n📧 Account: ${account.email}\n📅 Approval Date: ${approvalDate}` :
                    `✅ تم قبول حساب الإيميل الخاص بك!\n\n💰 تم إضافة المكافأة: ${displayReward}\n📧 الحساب: ${account.email}\n📅 تاريخ القبول: ${approvalDate}`;

                await safeSendMessage(account.user_id, userMessage);

                // First task = big one-time referral reward, subsequent tasks = per-email reward
                const referralEmail = await db.getReferralByReferredId(account.user_id);
                if (referralEmail && referralEmail.status === 'pending') {
                    await processReferralReward(account.user_id);
                } else {
                    await processPerEmailReferralReward(account.user_id);
                }

                // Update admin message
                const adminMessage = language === 'en' ?
                    `✅ APPROVED\n\n📧 Email: ${account.email}\n👤 User: ${account.user_id}\n💰 Reward: ${displayReward}\n📅 Approved: ${new Date().toLocaleString()}` :
                    `✅ تم القبول\n\n📧 الإيميل: ${account.email}\n👤 المستخدم: ${account.user_id}\n💰 المكافأة: ${displayReward}\n📅 تاريخ القبول: ${new Date().toLocaleString()}`;

                bot.editMessageText(adminMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });

                // Update status to approved (final status)
                await db.updatePendingAccountStatus(account.id, 'approved');
            } else {
                const errorMessage = language === 'en' ?
                    '❌ Error adding reward to user' :
                    '❌ حدث خطأ في إضافة المكافأة للمستخدم';
                bot.editMessageText(errorMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });
                
                // Return account to pending if reward failed
                await db.updatePendingAccountStatus(account.id, 'pending');
            }
        } else {
            // Rejected - return account to available accounts WITH all fields
            try {
                await db.addAvailableAccount(account.email, account.password, account.first_name || null, account.last_name || null);
            } catch (error) {
                console.error('Error returning rejected account to pool:', error.message);
            }

            // Update status to rejected with timestamp
            await db.updatePendingAccountStatus(account.id, 'rejected');

            // Get user's preferred language for notification
            const userLanguage = await getUserLanguage(account.user_id);

            // Notify user in their preferred language
            const userMessage = userLanguage === 'en' ?
                `❌ Your email account was rejected.\n\n📧 Account: ${account.email}\n\n💡 Make sure you create the account correctly next time\n📞 If there is a problem, contact support\n\n🔄 You can try again with a new task` :
                `❌ تم رفض حساب الإيميل الخاص بك.\n\n📧 الحساب: ${account.email}\n\n💡 تأكد من أنك أنشأت الحساب بشكل صحيح المرة القادمة\n📞 إذا هناك مشكلة، تواصل مع الدعم\n\n🔄 يمكنك المحاولة مرة أخرى بمهمة جديدة`;

            try {
                await bot.sendMessage(account.user_id, userMessage);
            } catch (error) {
                console.error('Failed to notify user:', error);
            }

            // Update admin message
            const adminMessage = language === 'en' ?
                `❌ REJECTED\n\n📧 Email: ${account.email}\n👤 User: ${account.user_id}\n📅 Rejected: ${new Date().toLocaleString()}\n\n💡 Account returned to available pool` :
                `❌ تم الرفض\n\n📧 الإيميل: ${account.email}\n👤 المستخدم: ${account.user_id}\n📅 تاريخ الرفض: ${new Date().toLocaleString()}\n\n💡 تم إرجاع الحساب للمجموعة المتاحة`;

            bot.editMessageText(adminMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Account already removed from pending at the start of function

    } catch (error) {
        console.error('Error handling email approval:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing approval' :
            '❌ حدث خطأ في معالجة الموافقة';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle Gmail account approval/rejection
async function handleGmailApproval(chatId, accountId, messageId, language, isApproved) {
    try {
        // Get account details from Gmail accounts
        const accounts = await db.getPendingGmailAccounts();
        const account = accounts.find(acc => acc.id.toString() === accountId);

        if (!account) {
            const errorMessage = language === 'en' ?
                '❌ Gmail account not found or already processed' :
                '❌ حساب الجيميل غير موجود أو تم معالجته بالفعل';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Check if already processed (status is not 'pending')
        if (account.status !== 'pending') {
            const errorMessage = language === 'en' ?
                '❌ Gmail account already processed' :
                '❌ تم معالجة حساب الجيميل بالفعل';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        if (isApproved) {
            // ✅ CRITICAL FIX: Update status to 'processing' FIRST to prevent double-click exploit
            await db.updateGmailAccountStatus(account.id, 'processing');
            
            // Add reward to user
            const rewardAdded = await addRewardToUser(account.user_id, 'gmail');

            if (rewardAdded) {
                // Get reward amount for display
                const rewardAmount = parseFloat(await db.getSetting('gmail_task_reward') || config.GMAIL_TASK_REWARD);
                const user = await db.getUser(account.user_id);
                const currency = user?.preferred_currency || 'EGP';
                const displayReward = currency === 'USD' ?
                    `$${(await convertEGPToUSD(rewardAmount)).toFixed(3)}` :
                    formatBalance(rewardAmount, 'EGP');

                // Get user's preferred language for notification
                const userLanguage = await getUserLanguage(account.user_id);

                // Notify user in their preferred language
                const approvalDate = new Date().toISOString().replace('T', ' ').substring(0, 16);
                const userMessage = userLanguage === 'en' ?
                    `✅ Your Gmail account has been approved!\n\n💰 Reward added: ${displayReward}\n📱 Gmail: ${account.email}\n📅 Approval Date: ${approvalDate}` :
                    `✅ تم قبول حساب الجيميل الخاص بك!\n\n💰 تم إضافة المكافأة: ${displayReward}\n📱 الجيميل: ${account.email}\n📅 تاريخ القبول: ${approvalDate}`;

                try {
                    await bot.sendMessage(account.user_id, userMessage);
                } catch (error) {
                    console.error('Failed to notify user:', error);
                }

                // First task = big one-time referral reward, subsequent tasks = per-email reward
                const referralGmail = await db.getReferralByReferredId(account.user_id);
                if (referralGmail && referralGmail.status === 'pending') {
                    await processReferralReward(account.user_id);
                } else {
                    await processPerEmailReferralReward(account.user_id);
                }

                // Update admin message
                const adminMessage = language === 'en' ?
                    `✅ APPROVED\n\n📱 Gmail: ${account.email}\n👤 User: ${account.user_id}\n💰 Reward: ${displayReward}\n📅 Approved: ${new Date().toLocaleString()}` :
                    `✅ تم القبول\n\n📱 الجيميل: ${account.email}\n👤 المستخدم: ${account.user_id}\n💰 المكافأة: ${displayReward}\n📅 تاريخ القبول: ${new Date().toLocaleString()}`;

                bot.editMessageText(adminMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });

                // Update Gmail account status to approved (final status)
                await db.updateGmailAccountStatus(account.id, 'approved');
            } else {
                // Reward failed - revert status back to pending
                await db.updateGmailAccountStatus(account.id, 'pending');
                
                const errorMessage = language === 'en' ?
                    '❌ Error adding reward to user' :
                    '❌ حدث خطأ في إضافة المكافأة للمستخدم';
                bot.editMessageText(errorMessage, {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
        } else {
            // Rejected
            // Get user's preferred language for notification
            const userLanguage = await getUserLanguage(account.user_id);

            // Notify user in their preferred language
            const userMessage = userLanguage === 'en' ?
                `❌ Your Gmail account was rejected.\n\n📱 Gmail: ${account.email}\n\n💡 Make sure you create the account correctly next time:\n• Use the provided password\n• Create from mobile phone only\n\n📞 If there is a problem, contact support\n🔄 You can try again with a new Gmail task` :
                `❌ تم رفض حساب الجيميل الخاص بك.\n\n📱 الجيميل: ${account.email}\n\n💡 تأكد من أنك أنشأت الحساب بشكل صحيح المرة القادمة:\n• استخدم كلمة المرور المعطاة\n• أنشئ الحساب من الهاتف فقط\n\n📞 إذا هناك مشكلة، تواصل مع الدعم\n🔄 يمكنك المحاولة مرة أخرى بمهمة جيميل جديدة`;

            try {
                await bot.sendMessage(account.user_id, userMessage);
            } catch (error) {
                console.error('Failed to notify user:', error);
            }

            // Update admin message
            const adminMessage = language === 'en' ?
                `❌ REJECTED\n\n📱 Gmail: ${account.email}\n👤 User: ${account.user_id}\n📅 Rejected: ${new Date().toLocaleString()}` :
                `❌ تم الرفض\n\n📱 الجيميل: ${account.email}\n👤 المستخدم: ${account.user_id}\n📅 تاريخ الرفض: ${new Date().toLocaleString()}`;

            bot.editMessageText(adminMessage, {
                chat_id: chatId,
                message_id: messageId
            });

            // Update Gmail account status to rejected
            await db.updateGmailAccountStatus(account.id, 'rejected');
        }

    } catch (error) {
        console.error('Error handling Gmail approval:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing approval' :
            '❌ حدث خطأ في معالجة الموافقة';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle user ban/unban
async function handleUserBan(chatId, targetUserId, messageId, language, isBan) {
    try {
        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        if (isBan) {
            await db.banUser(targetUserId);
            const successMessage = language === 'en' ?
                `🚫 User Banned Successfully!\n\n👤 User: ${user.username || 'Unknown'}\n🆔 ID: ${targetUserId}\n📅 Banned: ${new Date().toLocaleString()}\n\n⚠️ User can no longer use the bot` :
                `🚫 تم حظر المستخدم بنجاح!\n\n👤 المستخدم: ${user.username || 'غير محدد'}\n🆔 الآيدي: ${targetUserId}\n📅 تاريخ الحظر: ${new Date().toLocaleString()}\n\n⚠️ لا يمكن للمستخدم استخدام البوت الآن`;

            // Notify user
            try {
                // Get user's preferred language for notification
                const userLanguage = await getUserLanguage(targetUserId);

                const userMessage = userLanguage === 'en' ?
                    '🚫 You have been banned from using this bot.\n\nIf you believe this is a mistake, please contact support.' :
                    '🚫 تم حظرك من استخدام هذا البوت.\n\nإذا كنت تعتقد أن هذا خطأ، يرجى التواصل مع الدعم.';
                await bot.sendMessage(targetUserId, userMessage);
            } catch (error) {
                console.error('Failed to notify banned user:', error);
            }

            bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else {
            await db.unbanUser(targetUserId);
            const successMessage = language === 'en' ?
                `✅ User Unbanned Successfully!\n\n👤 User: ${user.username || 'Unknown'}\n🆔 ID: ${targetUserId}\n📅 Unbanned: ${new Date().toLocaleString()}\n\n✅ User can now use the bot again` :
                `✅ تم إلغاء حظر المستخدم بنجاح!\n\n👤 المستخدم: ${user.username || 'غير محدد'}\n🆔 الآيدي: ${targetUserId}\n📅 تاريخ إلغاء الحظر: ${new Date().toLocaleString()}\n\n✅ يمكن للمستخدم استخدام البوت الآن`;

            // Notify user
            try {
                // Get user's preferred language for notification
                const userLanguage = await getUserLanguage(targetUserId);

                const userMessage = userLanguage === 'en' ?
                    '✅ Your ban has been lifted! You can now use the bot again.\n\nWelcome back!' :
                    '✅ تم إلغاء حظرك! يمكنك الآن استخدام البوت مرة أخرى.\n\nأهلاً بعودتك!';
                await bot.sendMessage(targetUserId, userMessage);
            } catch (error) {
                console.error('Failed to notify unbanned user:', error);
            }

            bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }
    } catch (error) {
        console.error('Error handling user ban:', error);
        const errorMessage = language === 'en' ?
            '❌ Error processing ban/unban' :
            '❌ حدث خطأ في معالجة الحظر/إلغاء الحظر';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle balance edit
async function handleBalanceEdit(chatId, targetUserId, language) {
    try {
        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.sendMessage(chatId, errorMessage);
        }

        const currency = user.preferred_currency || 'EGP';
        const currentBalance = currency === 'USD' ? user.balance_usd || 0 : user.balance || 0;

        userStates.set(chatId.toString(), `edit_balance_${targetUserId}`);

        const message = language === 'en' ?
            `💰 Edit Balance for ${user.username || 'Unknown'}\n\n🆔 User ID: \`${targetUserId}\`\n💱 Currency: ${currency}\n💰 Current Balance: ${formatBalance(currentBalance, currency)}\n\n💡 Send amount to add/subtract:\n\n✅ Positive number (+10): Adds to balance\n❌ Negative number (-5): Subtracts from balance\n\n📝 Examples:\n• +50 → Adds 50 to current balance\n• -20 → Subtracts 20 from current balance\n• 30 → Adds 30 to current balance` :
            `💰 تعديل رصيد ${user.username || 'غير محدد'}\n\n🆔 آيدي المستخدم: \`${targetUserId}\`\n💱 العملة: ${currency}\n💰 الرصيد الحالي: ${formatBalance(currentBalance, currency)}\n\n💡 أرسل المبلغ للإضافة/الخصم:\n\n✅ رقم موجب (+10): يضيف للرصيد\n❌ رقم سالب (-5): يخصم من الرصيد\n\n📝 أمثلة:\n• +50 ← يضيف 50 للرصيد الحالي\n• -20 ← يخصم 20 من الرصيد الحالي\n• 30 ← يضيف 30 للرصيد الحالي`;

        const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
        bot.sendMessage(chatId, message, cancelKeyboard);
    } catch (error) {
        console.error('Error handling balance edit:', error);
        const errorMessage = language === 'en' ?
            '❌ Error initiating balance edit' :
            '❌ حدث خطأ في بدء تعديل الرصيد';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Handle user message
async function handleUserMessage(chatId, targetUserId, language) {
    try {
        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.sendMessage(chatId, errorMessage);
        }

        userStates.set(chatId.toString(), `send_message_${targetUserId}`);

        const message = language === 'en' ?
            `📨 Send Message to ${user.username || 'Unknown'}\n\n🆔 User ID: ${targetUserId}\n\n💡 Write your message:` :
            `📨 إرسال رسالة إلى ${user.username || 'غير محدد'}\n\n🆔 آيدي المستخدم: ${targetUserId}\n\n💡 اكتب رسالتك:`;

        const cancelKeyboard = keyboards.getKeyboard('cancelAdmin', language);
        bot.sendMessage(chatId, message, cancelKeyboard);
    } catch (error) {
        console.error('Error handling user message:', error);
        const errorMessage = language === 'en' ?
            '❌ Error initiating message send' :
            '❌ حدث خطأ في بدء إرسال الرسالة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Handle user details
async function handleUserDetails(chatId, targetUserId, messageId, language) {
    try {
        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Delete the old message and send new detailed info
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (deleteError) {
            console.log('Could not delete message:', deleteError.message);
        }
        
        await displayUserInfo(chatId, user, language);

        const status = user.is_banned ? (language === 'en' ? '🚫 Banned' : '🚫 محظور') : (language === 'en' ? '✅ Active' : '✅ نشط');
        const currency = user.preferred_currency || 'EGP';
        const egpBalance = user.balance || 0;
        const usdBalance = user.balance_usd || 0;

        const detailedMessage = language === 'en' ?
            `👤 Detailed User Information:\n\n📝 Username: ${user.username || 'Unknown'}\n🆔 ID: ${targetUserId}\n💰 EGP Balance: ${formatBalance(egpBalance, 'EGP')}\n💵 USD Balance: $${usdBalance.toFixed(2)}\n💱 Preferred Currency: ${currency}\n🌍 Language: ${user.preferred_language || 'ar'}\n📊 Status: ${status}\n📅 Joined: ${new Date(user.created_at).toLocaleString()}\n⏰ Last Active: ${new Date(user.last_active || user.created_at).toLocaleString()}\n\n📊 Account Statistics:\n• Total Tasks: N/A\n• Completed Tasks: N/A\n• Success Rate: N/A` :
            `👤 معلومات المستخدم المفصلة:\n\n📝 اليوزر نيم: ${user.username || 'غير محدد'}\n🆔 الآيدي: ${targetUserId}\n💰 رصيد الجنيه: ${formatBalance(egpBalance, 'EGP')}\n💵 رصيد الدولار: $${usdBalance.toFixed(2)}\n💱 العملة المفضلة: ${currency}\n🌍 اللغة: ${user.preferred_language || 'ar'}\n📊 الحالة: ${status}\n📅 تاريخ الانضمام: ${new Date(user.created_at).toLocaleString()}\n⏰ آخر نشاط: ${new Date(user.last_active || user.created_at).toLocaleString()}\n\n📊 إحصائيات الحساب:\n• إجمالي المهام: غير متاح\n• المهام المكتملة: غير متاح\n• معدل النجاح: غير متاح`;

        bot.editMessageText(detailedMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    } catch (error) {
        console.error('Error showing user details:', error);
        const errorMessage = language === 'en' ?
            '❌ Error loading user details' :
            '❌ حدث خطأ في تحميل تفاصيل المستخدم';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Handle user refresh
async function handleUserRefresh(chatId, targetUserId, messageId, language) {
    try {
        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        const status = user.is_banned ? (language === 'en' ? '🚫 Banned' : '🚫 محظور') : (language === 'en' ? '✅ Active' : '✅ نشط');
        const currency = user.preferred_currency || 'EGP';
        const balance = currency === 'USD' ? user.balance_usd || 0 : user.balance || 0;

        const message = language === 'en' ?
            `👤 User Information (Updated):\n\n📝 Username: ${user.username || 'Unknown'}\n🆔 ID: \`${user.id}\`\n💰 Balance: ${formatBalance(balance, currency)}\n💱 Currency: ${currency}\n🌍 Language: ${user.preferred_language || 'ar'}\n📊 Status: ${status}\n📅 Joined: ${new Date(user.created_at).toLocaleDateString()}\n⏰ Last Active: ${new Date(user.last_active || user.created_at).toLocaleDateString()}\n\n🔄 Updated: ${new Date().toLocaleString()}` :
            `👤 معلومات المستخدم (محدثة):\n\n📝 اليوزر نيم: ${user.username || 'غير محدد'}\n🆔 الآيدي: \`${user.id}\`\n💰 الرصيد: ${formatBalance(balance, currency)}\n💱 العملة: ${currency}\n🌍 اللغة: ${user.preferred_language || 'ar'}\n📊 الحالة: ${status}\n📅 تاريخ الانضمام: ${new Date(user.created_at).toLocaleDateString()}\n⏰ آخر نشاط: ${new Date(user.last_active || user.created_at).toLocaleDateString()}\n\n🔄 تم التحديث: ${new Date().toLocaleString()}`;

        // Recreate control buttons
        const inlineKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: user.is_banned ?
                                (language === 'en' ? '✅ Unban' : '✅ إلغاء الحظر') :
                                (language === 'en' ? '🚫 Ban' : '🚫 حظر'),
                            callback_data: user.is_banned ? `unban_user_${user.id}` : `ban_user_${user.id}`
                        },
                        {
                            text: language === 'en' ? '💰 Edit Balance' : '💰 تعديل الرصيد',
                            callback_data: `edit_balance_${user.id}`
                        }
                    ],
                    [
                        {
                            text: language === 'en' ? '📨 Send Message' : '📨 إرسال رسالة',
                            callback_data: `message_user_${user.id}`
                        },
                        {
                            text: language === 'en' ? '📊 Full Details' : '📊 التفاصيل الكاملة',
                            callback_data: `user_details_${user.id}`
                        }
                    ]
                ]
            }
        };

        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard.reply_markup
        });
    } catch (error) {
        console.error('Error refreshing user info:', error);
        const errorMessage = language === 'en' ?
            '❌ Error refreshing user information' :
            '❌ حدث خطأ في تحديث معلومات المستخدم';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

// Process balance edit
async function processBalanceEdit(chatId, targetUserId, amountInput, language) {
    try {
        // Parse the input amount (can be positive or negative)
        const amount = parseFloat(amountInput);
        if (isNaN(amount)) {
            const errorMessage = language === 'en' ?
                '❌ Invalid amount. Please enter a valid number.\n\n📝 Examples:\n• +50 (adds 50)\n• -20 (subtracts 20)\n• 30 (adds 30)' :
                '❌ مبلغ غير صحيح. يرجى إدخال رقم صحيح.\n\n📝 أمثلة:\n• +50 (يضيف 50)\n• -20 (يخصم 20)\n• 30 (يضيف 30)';
            return bot.sendMessage(chatId, errorMessage);
        }

        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.sendMessage(chatId, errorMessage);
        }

        const currency = user.preferred_currency || 'EGP';
        const currentBalance = currency === 'USD' ? (user.balance_usd || 0) : (user.balance || 0);

        // Calculate new balance by adding the amount (can be positive or negative)
        const newBalance = currentBalance + amount;

        // Prevent negative balance
        if (newBalance < 0) {
            const errorMessage = language === 'en' ?
                `❌ Cannot subtract ${Math.abs(amount)} from current balance!\n\n💰 Current Balance: ${formatBalance(currentBalance, currency)}\n💰 Amount to subtract: ${formatBalance(Math.abs(amount), currency)}\n💰 Result would be: ${formatBalance(newBalance, currency)}\n\n⚠️ Balance cannot be negative!` :
                `❌ لا يمكن خصم ${Math.abs(amount)} من الرصيد الحالي!\n\n💰 الرصيد الحالي: ${formatBalance(currentBalance, currency)}\n💰 المبلغ المراد خصمه: ${formatBalance(Math.abs(amount), currency)}\n💰 النتيجة ستكون: ${formatBalance(newBalance, currency)}\n\n⚠️ الرصيد لا يمكن أن يكون سالباً!`;
            return bot.sendMessage(chatId, errorMessage);
        }

        // Update the balance
        if (currency === 'USD') {
            await db.setUserUSDBalance(targetUserId, newBalance);
        } else {
            await db.setUserBalance(targetUserId, newBalance);
        }

        // Determine operation type for display
        const operationType = amount >= 0 ?
            (language === 'en' ? 'Added' : 'تم إضافة') :
            (language === 'en' ? 'Subtracted' : 'تم خصم');

        const operationSymbol = amount >= 0 ? '+' : '';

        const successMessage = language === 'en' ?
            `✅ Balance updated successfully!\n\n👤 User: ${user.username || 'Unknown'}\n🆔 ID: ${targetUserId}\n💱 Currency: ${currency}\n\n💰 Previous Balance: ${formatBalance(currentBalance, currency)}\n${operationSymbol}${formatBalance(amount, currency)} (${operationType})\n💰 New Balance: ${formatBalance(newBalance, currency)}\n\n📅 Updated: ${new Date().toLocaleString()}` :
            `✅ تم تحديث الرصيد بنجاح!\n\n👤 المستخدم: ${user.username || 'غير محدد'}\n🆔 الآيدي: ${targetUserId}\n💱 العملة: ${currency}\n\n💰 الرصيد السابق: ${formatBalance(currentBalance, currency)}\n${operationSymbol}${formatBalance(amount, currency)} (${operationType})\n💰 الرصيد الجديد: ${formatBalance(newBalance, currency)}\n\n📅 تاريخ التحديث: ${new Date().toLocaleString()}`;

        bot.sendMessage(chatId, successMessage);

        // Notify user about balance change
        try {
            const changeDescription = amount >= 0 ?
                (language === 'en' ? `+${formatBalance(amount, currency)} added` : `+${formatBalance(amount, currency)} تم إضافة`) :
                (language === 'en' ? `${formatBalance(amount, currency)} deducted` : `${formatBalance(Math.abs(amount), currency)} تم خصم`);

            // Get user's preferred language for notification
            const userLanguage = await getUserLanguage(targetUserId);

            const userMessage = userLanguage === 'en' ?
                `💰 Your balance has been updated by admin!\n\n💰 Previous Balance: ${formatBalance(currentBalance, currency)}\n💰 Change: ${changeDescription}\n💰 New Balance: ${formatBalance(newBalance, currency)}\n\n📅 Updated: ${new Date().toLocaleString()}` :
                `💰 تم تحديث رصيدك من قبل الأدمن!\n\n💰 الرصيد السابق: ${formatBalance(currentBalance, currency)}\n💰 التغيير: ${changeDescription}\n💰 الرصيد الجديد: ${formatBalance(newBalance, currency)}\n\n📅 تاريخ التحديث: ${new Date().toLocaleString()}`;
            await bot.sendMessage(targetUserId, userMessage);
        } catch (error) {
            console.error('Failed to notify user about balance change:', error);
        }

    } catch (error) {
        console.error('Error processing balance edit:', error);
        const errorMessage = language === 'en' ?
            '❌ Error updating balance' :
            '❌ حدث خطأ في تحديث الرصيد';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Send direct message to user
async function sendDirectMessage(chatId, targetUserId, messageText, language) {
    try {
        const user = await db.getUser(targetUserId);
        if (!user) {
            const errorMessage = language === 'en' ?
                '❌ User not found' :
                '❌ المستخدم غير موجود';
            return bot.sendMessage(chatId, errorMessage);
        }

        try {
            await bot.sendMessage(targetUserId, messageText);
            const successMessage = language === 'en' ?
                `✅ Message sent successfully!\n\n👤 To: ${user.username || 'Unknown'}\n🆔 ID: ${targetUserId}\n📨 Message: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"\n📅 Sent: ${new Date().toLocaleString()}` :
                `✅ تم إرسال الرسالة بنجاح!\n\n👤 إلى: ${user.username || 'غير محدد'}\n🆔 الآيدي: ${targetUserId}\n📨 الرسالة: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"\n📅 تاريخ الإرسال: ${new Date().toLocaleString()}`;
            bot.sendMessage(chatId, successMessage);
        } catch (error) {
            const errorMessage = language === 'en' ?
                `❌ Failed to send message to user ${targetUserId}\n\nPossible reasons:\n• User blocked the bot\n• User deleted their account\n• Network error` :
                `❌ فشل في إرسال الرسالة للمستخدم ${targetUserId}\n\nالأسباب المحتملة:\n• المستخدم حظر البوت\n• المستخدم حذف حسابه\n• خطأ في الشبكة`;
            bot.sendMessage(chatId, errorMessage);
        }

    } catch (error) {
        console.error('Error sending direct message:', error);
        const errorMessage = language === 'en' ?
            '❌ Error sending message' :
            '❌ حدث خطأ في إرسال الرسالة';
        bot.sendMessage(chatId, errorMessage);
    }
}

// Handle copy ID
// Handle delete account
async function handleDeleteAccount(chatId, accountId, messageId, language) {
    try {
        // Get account details before deletion
        const accounts = await db.getAvailableAccountsList(1000);
        const account = accounts.find(acc => acc.id.toString() === accountId);

        if (!account) {
            const errorMessage = language === 'en' ?
                '❌ Account not found or already deleted' :
                '❌ الحساب غير موجود أو تم حذفه بالفعل';
            return bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

        // Delete the account
        const deleted = await db.removeAvailableAccountById(accountId);

        if (deleted > 0) {
            const successMessage = language === 'en' ?
                `🗑️ Account Deleted Successfully!\n\n📧 Email: ${account.email}\n🔑 Password: ${account.password}\n📅 Deleted: ${new Date().toLocaleString()}\n\n⚠️ This account has been permanently removed from the available pool` :
                `🗑️ تم حذف الحساب بنجاح!\n\n📧 الإيميل: ${account.email}\n🔑 كلمة المرور: ${account.password}\n📅 تاريخ الحذف: ${new Date().toLocaleString()}\n\n⚠️ تم حذف هذا الحساب نهائياً من المجموعة المتاحة`;

            bot.editMessageText(successMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        } else {
            const errorMessage = language === 'en' ?
                '❌ Failed to delete account' :
                '❌ فشل في حذف الحساب';
            bot.editMessageText(errorMessage, {
                chat_id: chatId,
                message_id: messageId
            });
        }

    } catch (error) {
        console.error('Error deleting account:', error);
        const errorMessage = language === 'en' ?
            '❌ Error deleting account' :
            '❌ حدث خطأ في حذف الحساب';
        bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: messageId
        });
    }
}
