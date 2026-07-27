// تشغيل البوت مع معالجة أفضل للأخطاء
const TelegramBot = require('node-telegram-bot-api');

// معالجة الأخطاء العامة
process.on('uncaughtException', (error) => {
    console.error('❌ خطأ غير متوقع:', error.message);
    // لا نوقف البوت، فقط نسجل الخطأ
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ رفض غير معالج:', reason);
    // لا نوقف البوت، فقط نسجل الخطأ
});

// تشغيل البوت
console.log('🚀 بدء تشغيل البوت...');

try {
    require('./bot.js');
} catch (error) {
    console.error('❌ خطأ في تشغيل البوت:', error.message);
    console.log('💡 تأكد من أن جميع الملفات موجودة وأن التوكن صحيح');
}