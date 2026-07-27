/**
 * GitHub Auto-Backup System
 * يرفع ملف قاعدة البيانات على GitHub كل دقيقة
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DB_PATH = path.join(__dirname, 'bot_database.db');
const BACKUP_INTERVAL = 60 * 1000;
const BACKUP_FILE_PATH = 'backups/bot_database.db';

let lastBackupSHA = null;

// بيقرأ المتغيرات وقت التنفيذ مش وقت التحميل
function getConfig() {
    return {
        token: process.env.GITHUB_TOKEN,
        repo: process.env.GITHUB_REPO || 'ma76111/egypt-easy-cash-bot',
        branch: process.env.GITHUB_BRANCH || 'main'
    };
}

function githubRequest(method, endpoint, body) {
    const { token, repo } = getConfig();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${repo}${endpoint}`,
            method,
            headers: {
                'Authorization': `token ${token}`,
                'User-Agent': 'egypt-easy-cash-bot',
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json',
                ...(data && { 'Content-Length': Buffer.byteLength(data) })
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(responseData) });
                } catch {
                    resolve({ status: res.statusCode, body: responseData });
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function getFileSHA() {
    const { branch } = getConfig();
    try {
        const res = await githubRequest('GET', `/contents/${BACKUP_FILE_PATH}?ref=${branch}`);
        if (res.status === 200) return res.body.sha;
        return null;
    } catch {
        return null;
    }
}

async function uploadDatabase() {
    const { token, branch } = getConfig();

    if (!token) {
        console.error('[Backup] ❌ GITHUB_TOKEN غير محدد في متغيرات البيئة');
        return;
    }

    if (!fs.existsSync(DB_PATH)) {
        console.error('[Backup] ❌ ملف قاعدة البيانات غير موجود');
        return;
    }

    try {
        const fileContent = fs.readFileSync(DB_PATH);
        const base64Content = fileContent.toString('base64');
        const now = new Date().toISOString();

        if (!lastBackupSHA) {
            lastBackupSHA = await getFileSHA();
        }

        const body = {
            message: `🔄 Auto backup - ${now}`,
            content: base64Content,
            branch: branch,
            ...(lastBackupSHA && { sha: lastBackupSHA })
        };

        const res = await githubRequest('PUT', `/contents/${BACKUP_FILE_PATH}`, body);

        if (res.status === 200 || res.status === 201) {
            lastBackupSHA = res.body.content?.sha;
            console.log(`[Backup] ✅ تم رفع قاعدة البيانات بنجاح - ${now}`);
        } else {
            if (res.status === 409 || res.status === 422) {
                console.warn('[Backup] ⚠️ SHA قديم، يتم التحديث...');
                lastBackupSHA = await getFileSHA();
            } else {
                console.error(`[Backup] ❌ فشل الرفع - Status: ${res.status}`, res.body.message);
            }
        }
    } catch (err) {
        console.error('[Backup] ❌ خطأ:', err.message);
    }
}

function startAutoBackup() {
    const { token, repo, branch } = getConfig();

    if (!token) {
        console.warn('[Backup] ⚠️ GITHUB_TOKEN غير محدد - النسخ الاحتياطي التلقائي معطل');
        return;
    }

    console.log(`[Backup] 🚀 بدء النسخ الاحتياطي التلقائي على GitHub كل دقيقة`);
    console.log(`[Backup] 📁 الريبوستري: ${repo} | Branch: ${branch}`);

    uploadDatabase();
    setInterval(uploadDatabase, BACKUP_INTERVAL);
}

module.exports = { startAutoBackup, uploadDatabase };
