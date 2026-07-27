require('dotenv').config();
// Reset bot with automatic backup
// Updated to match latest database schema (v3.2 - referrals + github backup)
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

// Helper: run a single SQL command as a promise
function run(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, (err) => {
            if (err && !err.message.includes('no such table') && !err.message.includes('no such column')) reject(err);
            else resolve();
        });
    });
}

// Helper: get a single row as a promise
function get(db, sql) {
    return new Promise((resolve, reject) => {
        db.get(sql, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Ask user for confirmation
function confirm(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

// Upload backup to GitHub
async function uploadToGitHub(filePath) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO || 'ma76111/egypt-easy-cash-bot';
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!token) {
        console.log('   ⚠️  GITHUB_TOKEN غير محدد - تم تخطي رفع GitHub');
        return;
    }

    try {
        const fileContent = fs.readFileSync(filePath);
        const base64Content = fileContent.toString('base64');
        const now = new Date().toISOString();
        const remotePath = 'backups/bot_database.db';

        // Get current SHA if file exists
        let sha = null;
        await new Promise((resolve) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${repo}/contents/${remotePath}?ref=${branch}`,
                method: 'GET',
                headers: { Authorization: `token ${token}`, 'User-Agent': 'egypt-easy-cash-bot', Accept: 'application/vnd.github.v3+json' }
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { sha = JSON.parse(data).sha; } catch {}
                    resolve();
                });
            });
            req.on('error', () => resolve());
            req.end();
        });

        const body = JSON.stringify({
            message: `🔄 Manual backup before reset - ${now}`,
            content: base64Content,
            branch,
            ...(sha && { sha })
        });

        await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${repo}/contents/${remotePath}`,
                method: 'PUT',
                headers: {
                    Authorization: `token ${token}`,
                    'User-Agent': 'egypt-easy-cash-bot',
                    'Content-Type': 'application/json',
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Length': Buffer.byteLength(body)
                }
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const result = JSON.parse(data);
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        console.log(`   ✅ تم رفع النسخة الاحتياطية على GitHub`);
                    } else {
                        console.log(`   ⚠️  فشل الرفع على GitHub: ${result.message}`);
                    }
                    resolve();
                });
            });
            req.on('error', (err) => { console.log(`   ⚠️  خطأ GitHub: ${err.message}`); resolve(); });
            req.write(body);
            req.end();
        });
    } catch (err) {
        console.log(`   ⚠️  خطأ في رفع GitHub: ${err.message}`);
    }
}

async function resetWithBackup() {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║   🔄 إعادة تعيين البوت مع نسخة احتياطية  ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    if (!fs.existsSync('bot_database.db')) {
        console.log('⚠️  لا توجد قاعدة بيانات للإعادة تعيين.');
        console.log('   سيتم إنشاء قاعدة بيانات جديدة عند تشغيل البوت.');
        process.exit(0);
    }

    const db = new sqlite3.Database('bot_database.db');

    try {
        // Show current stats
        console.log('📊 البيانات الحالية في قاعدة البيانات:');

        const tables = [
            { sql: "SELECT COUNT(*) as c FROM users",               label: '👥 المستخدمين' },
            { sql: "SELECT COUNT(*) as c FROM available_accounts",  label: '📦 الحسابات المتاحة' },
            { sql: "SELECT COUNT(*) as c FROM pending_accounts",    label: '� الحسابات المعلقة' },
            { sql: "SELECT COUNT(*) as c FROM gmail_accounts",      label: '📱 حسابات الجيميل' },
            { sql: "SELECT COUNT(*) as c FROM withdrawal_requests", label: '� طلبات السحب' },
            { sql: "SELECT COUNT(*) as c FROM referrals",           label: '🔗 الإحالات' },
            { sql: "SELECT COUNT(*) as c FROM admins",              label: '👑 الأدمنز' },
            { sql: "SELECT COUNT(*) as c FROM active_tasks",        label: '⚙️  المهام النشطة' },
            { sql: "SELECT COUNT(*) as c FROM settings",            label: '⚙️  الإعدادات' },
        ];

        for (const t of tables) {
            try {
                const row = await get(db, t.sql);
                console.log(`   ${t.label}: ${row?.c ?? 0}`);
            } catch {
                console.log(`   ${t.label}: 0`);
            }
        }

        console.log('');
        console.log('⚠️  تحذير: هذا الإجراء سيحذف جميع البيانات بشكل نهائي!');
        console.log('');

        const answer = await confirm('هل أنت متأكد؟ اكتب "نعم" للمتابعة: ');
        if (answer !== 'نعم' && answer !== 'yes' && answer !== 'y') {
            console.log('');
            console.log('❌ تم إلغاء العملية.');
            db.close();
            process.exit(0);
        }

        console.log('');

        // Create local backup
        const timestamp = Date.now();
        const backupFile = `backup_${timestamp}_bot_database.db`;

        console.log('📦 جاري إنشاء نسخة احتياطية محلية...');
        db.close();

        fs.copyFileSync('bot_database.db', backupFile);
        console.log(`   ✅ نسخة محلية: ${backupFile}`);

        // Upload backup to GitHub
        console.log('☁️  جاري رفع النسخة الاحتياطية على GitHub...');
        await uploadToGitHub(backupFile);
        console.log('');

        // Reopen for deletion
        const newDb = new sqlite3.Database('bot_database.db');

        console.log('🗑️  جاري حذف جميع البيانات...');

        // Delete in correct order (foreign keys)
        const deleteOrder = [
            'DELETE FROM active_tasks',
            'DELETE FROM pending_accounts',
            'DELETE FROM gmail_accounts',
            'DELETE FROM withdrawal_requests',
            'DELETE FROM referrals',
            'DELETE FROM available_accounts',
            'DELETE FROM admins',
            'DELETE FROM settings',
            'DELETE FROM users',
        ];

        for (const sql of deleteOrder) {
            await run(newDb, sql);
            console.log(`   ✅ ${sql.replace('DELETE FROM ', '')}`);
        }

        // Reset auto-increment counters
        await run(newDb, 'DELETE FROM sqlite_sequence');
        console.log('   ✅ sqlite_sequence (auto-increment reset)');

        // Compact database
        await run(newDb, 'VACUUM');
        console.log('   ✅ VACUUM (تنظيف وضغط قاعدة البيانات)');

        newDb.close();

        console.log('');
        console.log('╔══════════════════════════════════════╗');
        console.log('║   🎉 تمت إعادة التعيين بنجاح!          ║');
        console.log('╚══════════════════════════════════════╝');
        console.log('');
        console.log('📝 ملاحظات:');
        console.log(`   💾 النسخة الاحتياطية المحلية: ${backupFile}`);
        console.log('   🔄 لاستعادة البيانات:');
        console.log(`      cp ${backupFile} bot_database.db`);
        console.log('   ▶️  لتشغيل البوت:');
        console.log('      node bot.js');
        console.log('      أو: pm2 restart egypt-bot');
        console.log('');

    } catch (error) {
        console.error('❌ حدث خطأ:', error.message);
        try { db.close(); } catch {}
        process.exit(1);
    }
}

resetWithBackup();
