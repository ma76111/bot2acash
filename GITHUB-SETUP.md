# 🔗 دليل ربط المشروع بـ GitHub وتشغيله على الهاتف

## 📋 المتطلبات

### على الكمبيوتر:
- Git مثبت على جهازك
- حساب GitHub

### على الهاتف:
- تطبيق Termux (للأندرويد)
- أو iSH Shell (للآيفون)

---

## 🚀 الجزء الأول: رفع المشروع على GitHub

### 1. إنشاء Repository جديد على GitHub

1. افتح [github.com](https://github.com)
2. اضغط على زر "+" في الأعلى
3. اختر "New repository"
4. املأ البيانات:
   - **Repository name:** `egypt-easy-cash-bot`
   - **Description:** `Telegram bot for earning money`
   - **Visibility:** Private (موصى به لحماية التوكن)
   - **لا تضف** README أو .gitignore (موجودين بالفعل)
5. اضغط "Create repository"

### 2. ربط المشروع المحلي بـ GitHub

افتح Terminal/CMD في مجلد المشروع وقم بتنفيذ:

```bash
# تهيئة Git (إذا لم يكن مهيأ)
git init

# إضافة جميع الملفات
git add .

# أول Commit
git commit -m "Initial commit - Version 3.0"

# ربط بـ GitHub (استبدل USERNAME باسم المستخدم)
git remote add origin https://github.com/USERNAME/egypt-easy-cash-bot.git

# رفع الملفات
git branch -M main
git push -u origin main
```

### 3. حماية البيانات الحساسة

**مهم جداً:** لا ترفع ملف config.js الأصلي!

قم بإنشاء ملف `config.example.js`:

```bash
# انسخ config.js إلى config.example.js
cp config.js config.example.js
```

ثم عدّل `config.example.js` واستبدل البيانات الحساسة:

```javascript
BOT_TOKEN: 'YOUR_BOT_TOKEN_HERE',
ADMIN_ID: 'YOUR_TELEGRAM_ID_HERE',
BOT_USERNAME: 'your_bot_username',
```

ثم:

```bash
# أضف config.js إلى .gitignore
echo "config.js" >> .gitignore
echo "bot_database.db*" >> .gitignore
echo ".env" >> .gitignore

# احفظ التغييرات
git add .
git commit -m "Add config.example.js and update .gitignore"
git push
```

---

## 📱 الجزء الثاني: تشغيل البوت على الهاتف

### للأندرويد (باستخدام Termux)

#### 1. تثبيت Termux

1. حمّل Termux من [F-Droid](https://f-droid.org/packages/com.termux/)
   - **لا تحمله من Google Play** (نسخة قديمة)
2. افتح Termux

#### 2. تحديث النظام وتثبيت الأدوات

```bash
# تحديث الحزم
pkg update && pkg upgrade -y

# تثبيت Git
pkg install git -y

# تثبيت Node.js
pkg install nodejs -y

# التحقق من التثبيت
node --version
npm --version
git --version
```

#### 3. استنساخ المشروع من GitHub

```bash
# الانتقال إلى المجلد الرئيسي
cd ~

# استنساخ المشروع (استبدل USERNAME)
git clone https://github.com/USERNAME/egypt-easy-cash-bot.git

# الدخول إلى المجلد
cd egypt-easy-cash-bot

# عرض الملفات
ls -la
```

#### 4. إعداد المشروع

```bash
# تثبيت الاعتماديات
npm install

# نسخ ملف الإعدادات
cp config.example.js config.js

# تعديل الإعدادات
nano config.js
```

في محرر nano:
- عدّل `BOT_TOKEN` و `ADMIN_ID` و `BOT_USERNAME`
- اضغط `Ctrl + X` ثم `Y` ثم `Enter` للحفظ

#### 5. تشغيل البوت

```bash
# تشغيل البوت
node bot.js
```

#### 6. تشغيل البوت في الخلفية (مهم!)

لتشغيل البوت حتى بعد إغلاق Termux:

```bash
# تثبيت PM2
npm install -g pm2

# تشغيل البوت بـ PM2
pm2 start bot.js --name egypt-bot

# حفظ القائمة
pm2 save

# تفعيل التشغيل التلقائي
pm2 startup
```

**أوامر PM2 المفيدة:**
```bash
pm2 status              # حالة البوت
pm2 logs egypt-bot      # عرض السجلات
pm2 restart egypt-bot   # إعادة تشغيل
pm2 stop egypt-bot      # إيقاف
pm2 delete egypt-bot    # حذف من PM2
```

#### 7. منع Termux من النوم

1. افتح إعدادات الهاتف
2. اذهب إلى "البطارية" أو "Battery"
3. ابحث عن Termux
4. عطّل "تحسين البطارية" أو "Battery optimization"
5. اسمح بالعمل في الخلفية

---

### للآيفون (باستخدام iSH Shell)

#### 1. تثبيت iSH

1. حمّل iSH من [App Store](https://apps.apple.com/app/ish-shell/id1436902243)
2. افتح التطبيق

#### 2. تحديث النظام وتثبيت الأدوات

```bash
# تحديث الحزم
apk update
apk upgrade

# تثبيت Git
apk add git

# تثبيت Node.js و npm
apk add nodejs npm

# التحقق من التثبيت
node --version
npm --version
```

#### 3. استنساخ المشروع

```bash
# استنساخ المشروع
git clone https://github.com/USERNAME/egypt-easy-cash-bot.git

# الدخول إلى المجلد
cd egypt-easy-cash-bot

# تثبيت الاعتماديات
npm install
```

#### 4. إعداد وتشغيل

```bash
# نسخ ملف الإعدادات
cp config.example.js config.js

# تعديل الإعدادات
vi config.js
# (اضغط i للتعديل، ثم ESC ثم :wq للحفظ)

# تشغيل البوت
node bot.js
```

**ملاحظة:** iSH أبطأ من Termux وقد لا يعمل بشكل مثالي.

---

## 🔄 تحديث البوت من GitHub

عندما تقوم بتحديث الكود على GitHub:

```bash
# على الهاتف، في مجلد المشروع:
cd ~/egypt-easy-cash-bot

# إيقاف البوت
pm2 stop egypt-bot

# سحب التحديثات
git pull origin main

# تثبيت أي اعتماديات جديدة
npm install

# إعادة تشغيل البوت
pm2 restart egypt-bot
```

---

## 🔐 نصائح الأمان

### 1. حماية config.js
```bash
# تأكد أن config.js في .gitignore
cat .gitignore | grep config.js
```

### 2. استخدام Environment Variables (اختياري)
بدلاً من config.js، يمكنك استخدام ملف .env:

```bash
# إنشاء ملف .env
nano .env
```

أضف:
```
BOT_TOKEN=your_token_here
ADMIN_ID=your_id_here
BOT_USERNAME=your_bot_username
```

ثم عدّل config.js ليقرأ من .env:
```javascript
require('dotenv').config();

module.exports = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    ADMIN_ID: process.env.ADMIN_ID,
    // ...
}
```

### 3. Repository خاص
احرص على أن يكون Repository خاصاً (Private) لحماية الكود.

---

## 📊 مراقبة البوت

### على الهاتف:

```bash
# حالة البوت
pm2 status

# السجلات المباشرة
pm2 logs egypt-bot --lines 50

# استخدام الذاكرة
pm2 monit

# معلومات مفصلة
pm2 show egypt-bot
```

### إشعارات Telegram:
البوت يرسل إشعارات للأدمن عند:
- بدء التشغيل
- حدوث أخطاء
- طلبات جديدة

---

## 🔧 حل المشاكل

### البوت لا يعمل:
```bash
# تحقق من السجلات
pm2 logs egypt-bot --err

# تحقق من الأخطاء
cat logs/errors.log
```

### نفاد الذاكرة:
```bash
# زيادة حد الذاكرة
pm2 start bot.js --name egypt-bot --max-memory-restart 200M
```

### البوت يتوقف بعد إغلاق Termux:
```bash
# تأكد من تشغيل PM2
pm2 list

# إعادة حفظ
pm2 save

# تفعيل التشغيل التلقائي
pm2 startup
```

### تحديث Node.js:
```bash
# Termux
pkg upgrade nodejs

# iSH
apk upgrade nodejs
```

---

## 📱 نصائح للتشغيل على الهاتف

### 1. استهلاك البطارية:
- استخدم شاحن أثناء التشغيل المستمر
- أو استخدم خدمة استضافة سحابية (VPS)

### 2. الاتصال بالإنترنت:
- تأكد من اتصال مستقر
- استخدم WiFi بدلاً من البيانات الخلوية

### 3. مساحة التخزين:
- احذف السجلات القديمة بانتظام:
```bash
rm logs/errors.log
rm logs/activity.log
```

### 4. النسخ الاحتياطي:
```bash
# نسخ احتياطي لقاعدة البيانات
cp bot_database.db backup_$(date +%Y%m%d).db

# رفع النسخة الاحتياطية (اختياري)
# يمكنك رفعها على Google Drive أو Dropbox
```

---

## 🌐 البديل: استضافة سحابية (موصى به)

بدلاً من الهاتف، يمكنك استخدام:

### 1. Heroku (مجاني)
- سهل الاستخدام
- يدعم GitHub مباشرة
- [دليل Heroku](https://devcenter.heroku.com/articles/deploying-nodejs)

### 2. Railway (مجاني)
- أسهل من Heroku
- يدعم GitHub
- [railway.app](https://railway.app)

### 3. VPS رخيص
- DigitalOcean ($5/شهر)
- Vultr ($3.5/شهر)
- Contabo (€4/شهر)

---

## ✅ الخلاصة

### على الكمبيوتر:
1. ✅ إنشاء Repository على GitHub
2. ✅ رفع المشروع
3. ✅ حماية البيانات الحساسة

### على الهاتف:
1. ✅ تثبيت Termux/iSH
2. ✅ تثبيت Node.js و Git
3. ✅ استنساخ المشروع
4. ✅ إعداد config.js
5. ✅ تشغيل البوت بـ PM2

### للتحديثات:
```bash
git pull && npm install && pm2 restart egypt-bot
```

---

**آخر تحديث:** 2026-04-26  
**الإصدار:** 3.0

🎉 **البوت الآن يعمل على هاتفك!**
