// Multilingual keyboard layouts

const keyboards = {
    // Language selection keyboard
    languageSelection: {
        reply_markup: {
            keyboard: [
                [{ text: '🇸🇦 العربية' }, { text: '🇺🇸 English' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Currency selection keyboards
    currencySelectionAr: {
        reply_markup: {
            keyboard: [
                [{ text: '💵 الدولار الأمريكي' }],
                [{ text: '💰 الجنيه المصري' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    currencySelectionEn: {
        reply_markup: {
            keyboard: [
                [{ text: '💵 US Dollar' }],
                [{ text: '💰 Egyptian Pound' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Main user keyboards
    userKeyboardAr: {
        reply_markup: {
            keyboard: [
                [{ text: '📋 المهام' }],
                [{ text: '💰 المحفظة' }, { text: '💳 السحب' }],
                [{ text: '🔗 نظام الإحالة' }, { text: '🆔 عرض الآيدي' }],
                [{ text: '⏳ الأموال المعلقة' }, { text: '🎲 احصل على اسم' }],
                [{ text: '💱 تغيير العملة' }, { text: '🌍 تغيير اللغة' }],
                [{ text: '💬 الدعم' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    userKeyboardEn: {
        reply_markup: {
            keyboard: [
                [{ text: '📋 Tasks' }],
                [{ text: '💰 Wallet' }, { text: '💳 Withdraw' }],
                [{ text: '🔗 Referral System' }, { text: '🆔 Show ID' }],
                [{ text: '⏳ Pending Funds' }, { text: '🎲 Get a Name' }],
                [{ text: '💱 Change Currency' }, { text: '🌍 Change Language' }],
                [{ text: '💬 Support' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Admin keyboards
    adminKeyboardAr: {
        reply_markup: {
            keyboard: [
                [{ text: '👥 إدارة المستخدمين' }, { text: '📊 الإحصائيات' }],
                [{ text: '📧 اليوزرات المنشأة' }, { text: '📱 مراجعة الجيميلات' }],
                [{ text: '💳 طلبات السحب' }, { text: '📨 إرسال رسالة' }],
                [{ text: '⚙️ إعدادات النظام' }, { text: '🎮 التحكم في المهام' }],
                [{ text: '➕ إضافة يوزرات' }, { text: '📦 اليوزرات المتاحة' }],
                [{ text: '📥 إدارة الإيميلات الجماعية' }],
                [{ text: '🧹 تنظيف اليوزرات المكررة' }],
                [{ text: '🌍 تغيير اللغة' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    adminKeyboardEn: {
        reply_markup: {
            keyboard: [
                [{ text: '👥 User Management' }, { text: '📊 Statistics' }],
                [{ text: '📧 Created Accounts' }, { text: '📱 Review Gmail' }],
                [{ text: '💳 Withdrawal Requests' }, { text: '📨 Send Message' }],
                [{ text: '⚙️ System Settings' }, { text: '🎮 Task Control' }],
                [{ text: '➕ Add Accounts' }, { text: '📦 Available Accounts' }],
                [{ text: '📥 Bulk Email Management' }],
                [{ text: '🧹 Clean Duplicate Accounts' }],
                [{ text: '🌍 Change Language' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Main admin keyboards (with admin management)
    mainAdminKeyboardAr: {
        reply_markup: {
            keyboard: [
                [{ text: '👥 إدارة المستخدمين' }, { text: '📊 الإحصائيات' }],
                [{ text: '📧 اليوزرات المنشأة' }, { text: '📱 مراجعة الجيميلات' }],
                [{ text: '💳 طلبات السحب' }, { text: '📨 إرسال رسالة' }],
                [{ text: '⚙️ إعدادات النظام' }, { text: '🎮 التحكم في المهام' }],
                [{ text: '➕ إضافة يوزرات' }, { text: '📦 اليوزرات المتاحة' }],
                [{ text: '📥 إدارة الإيميلات الجماعية' }],
                [{ text: '🧹 تنظيف اليوزرات المكررة' }],
                [{ text: '👑 إدارة الأدمنز' }],
                [{ text: '🌍 تغيير اللغة' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    mainAdminKeyboardEn: {
        reply_markup: {
            keyboard: [
                [{ text: '👥 User Management' }, { text: '📊 Statistics' }],
                [{ text: '📧 Created Accounts' }, { text: '📱 Review Gmail' }],
                [{ text: '💳 Withdrawal Requests' }, { text: '📨 Send Message' }],
                [{ text: '⚙️ System Settings' }, { text: '🎮 Task Control' }],
                [{ text: '➕ Add Accounts' }, { text: '📦 Available Accounts' }],
                [{ text: '📥 Bulk Email Management' }],
                [{ text: '🧹 Clean Duplicate Accounts' }],
                [{ text: '👑 Admin Management' }],
                [{ text: '🌍 Change Language' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Admin management keyboards
    adminManagementAr: {
        reply_markup: {
            keyboard: [
                [{ text: '➕ إضافة أدمن' }],
                [{ text: '📋 قائمة الأدمنز' }],
                [{ text: '❌ حذف أدمن' }],
                [{ text: '📧 صلاحية مراجعة الإيميلات' }],
                [{ text: '💳 صلاحية طلبات السحب' }],
                [{ text: '🔙 العودة لقائمة الأدمن' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    adminManagementEn: {
        reply_markup: {
            keyboard: [
                [{ text: '➕ Add Admin' }],
                [{ text: '📋 Admin List' }],
                [{ text: '❌ Remove Admin' }],
                [{ text: '📧 Email Review Permission' }],
                [{ text: '💳 Withdrawal Access Permission' }],
                [{ text: '🔙 Back to Admin Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Task menus
    tasksMenuAr: {
        reply_markup: {
            keyboard: [
                [{ text: '📱 مهمة إنشاء جيميل' }],
                [{ text: '📧 مهمة إنشاء يوزرات' }],
                [{ text: '🔙 العودة للقائمة الرئيسية' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    tasksMenuEn: {
        reply_markup: {
            keyboard: [
                [{ text: '📱 Gmail Creation Task' }],
                [{ text: '📧 Email Creation Task' }],
                [{ text: '🔙 Back to Main Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Task confirmation keyboards
    taskConfirmAr: {
        reply_markup: {
            keyboard: [
                [{ text: '✅ تم إنشاء اليوزر' }],
                [{ text: '❌ إلغاء المهمة' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    taskConfirmEn: {
        reply_markup: {
            keyboard: [
                [{ text: '✅ Account Created' }],
                [{ text: '❌ Cancel Task' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Gmail task keyboards
    gmailTaskAr: {
        reply_markup: {
            keyboard: [
                [{ text: '✅ متابعة' }],
                [{ text: '❌ إلغاء المهمة' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    gmailTaskEn: {
        reply_markup: {
            keyboard: [
                [{ text: '✅ Continue' }],
                [{ text: '❌ Cancel Task' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Cancel keyboards
    cancelUserAr: {
        reply_markup: {
            keyboard: [
                [{ text: '❌ إلغاء' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    cancelUserEn: {
        reply_markup: {
            keyboard: [
                [{ text: '❌ Cancel' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    cancelAdminAr: {
        reply_markup: {
            keyboard: [
                [{ text: '❌ إلغاء' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    cancelAdminEn: {
        reply_markup: {
            keyboard: [
                [{ text: '❌ Cancel' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Currency change keyboards
    currencyChangeAr: {
        reply_markup: {
            keyboard: [
                [{ text: '💵 تغيير إلى الدولار' }],
                [{ text: '💰 تغيير إلى الجنيه' }],
                [{ text: '🔙 العودة للقائمة الرئيسية' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    currencyChangeEn: {
        reply_markup: {
            keyboard: [
                [{ text: '💵 Change to USD' }],
                [{ text: '💰 Change to EGP' }],
                [{ text: '🔙 Back to Main Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // User management keyboards (Admin)
    userManagementAr: {
        reply_markup: {
            keyboard: [
                [{ text: '🔍 البحث عن مستخدم' }],
                [{ text: '📊 آخر 10 مستخدمين' }],
                [{ text: '📋 تقرير مستخدم كامل' }],
                [{ text: '🔙 العودة لقائمة الأدمن' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    userManagementEn: {
        reply_markup: {
            keyboard: [
                [{ text: '🔍 Search User' }],
                [{ text: '📊 Last 10 Users' }],
                [{ text: '📋 Full User Report' }],
                [{ text: '🔙 Back to Admin Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Message keyboards (Admin)
    messageKeyboardAr: {
        reply_markup: {
            keyboard: [
                [{ text: '📢 رسالة جماعية' }],
                [{ text: '👤 رسالة لشخص معين' }],
                [{ text: '🔙 العودة لقائمة الأدمن' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    messageKeyboardEn: {
        reply_markup: {
            keyboard: [
                [{ text: '📢 Broadcast Message' }],
                [{ text: '👤 Private Message' }],
                [{ text: '🔙 Back to Admin Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Settings keyboards (Admin)
    settingsKeyboardAr: {
        reply_markup: {
            keyboard: [
                [{ text: '💰 إعدادات المكافآت' }],
                [{ text: '💳 تغيير الحد الأدنى للسحب' }],
                [{ text: '💱 معرفة سعر الصرف' }],
                [{ text: '💬 تعديل رسالة الدعم' }],
                [{ text: '📢 إشعارات اليوزرات الجديدة' }],
                [{ text: '🔙 العودة لقائمة الأدمن' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    settingsKeyboardEn: {
        reply_markup: {
            keyboard: [
                [{ text: '💰 Reward Settings' }],
                [{ text: '💳 Change Min Withdrawal' }],
                [{ text: '💱 Check Exchange Rate' }],
                [{ text: '💬 Edit Support Message' }],
                [{ text: '📢 New Accounts Notifications' }],
                [{ text: '🔙 Back to Admin Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Task control keyboards (Admin)
    taskControlAr: {
        reply_markup: {
            keyboard: [
                [{ text: '📧 مهمة إنشاء اليوزرات' }],
                [{ text: '📱 مهمة إنشاء الجيميل' }],
                [{ text: '🌍 الدول المطلوبة' }],
                [{ text: '🔄 طريقة التحقق من الدولة' }],
                [{ text: '🔙 العودة لقائمة الأدمن' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    taskControlEn: {
        reply_markup: {
            keyboard: [
                [{ text: '📧 Email Creation Task' }],
                [{ text: '📱 Gmail Creation Task' }],
                [{ text: '🌍 Allowed Countries' }],
                [{ text: '🔄 Country Verification Method' }],
                [{ text: '🔙 Back to Admin Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Reward settings keyboards (Admin)
    rewardsSettingsAr: {
        reply_markup: {
            keyboard: [
                [{ text: '💰 مكافأة مهمة اليوزرات' }],
                [{ text: '📱 مكافأة مهمة الجيميل' }],
                [{ text: '🔗 مكافأة الإحالة' }],
                [{ text: '🔑 كلمة مرور الجيميل الموحدة' }],
                [{ text: '📝 تعديل نص مهمة الجيميل' }],
                [{ text: '🔙 العودة للإعدادات' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    rewardsSettingsEn: {
        reply_markup: {
            keyboard: [
                [{ text: '💰 Email Task Reward' }],
                [{ text: '📱 Gmail Task Reward' }],
                [{ text: '🔗 Referral Reward' }],
                [{ text: '🔑 Universal Gmail Password' }],
                [{ text: '📝 Edit Gmail Task Text' }],
                [{ text: '🔙 Back to Settings' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Referral system keyboards
    referralMenuAr: {
        reply_markup: {
            keyboard: [
                [{ text: '🔗 كود الإحالة' }],
                [{ text: '📊 إحصائيات الإحالة' }],
                [{ text: '👥 قائمة الإحالات' }],
                [{ text: '🔙 العودة للقائمة الرئيسية' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    referralMenuEn: {
        reply_markup: {
            keyboard: [
                [{ text: '🔗 Referral Code' }],
                [{ text: '📊 Referral Stats' }],
                [{ text: '👥 Referral List' }],
                [{ text: '🔙 Back to Main Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Referral reward settings keyboards (Admin)
    referralRewardSettingsAr: {
        reply_markup: {
            keyboard: [
                [{ text: '💰 مكافأة الإحالة بالجنيه' }],
                [{ text: '💵 مكافأة الإحالة بالدولار' }],
                [{ text: '🔙 العودة لإعدادات المكافآت' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    referralRewardSettingsEn: {
        reply_markup: {
            keyboard: [
                [{ text: '💰 Referral Reward EGP' }],
                [{ text: '💵 Referral Reward USD' }],
                [{ text: '🔙 Back to Reward Settings' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    // Bulk email management keyboards (Admin)
    bulkEmailManagementAr: {
        reply_markup: {
            keyboard: [
                [{ text: '📤 تصدير كل الإيميلات' }],
                [{ text: '📤 تصدير عدد محدد من الإيميلات' }],
                [{ text: '↩️ إرجاع من التصدير' }],
                [{ text: '✅ إرسال المقبولة وقبولها' }],
                [{ text: '❌ إرسال المرفوضة ورفضها' }],
                [{ text: '⏳ الإيميلات غير الموافق عليها' }],
                [{ text: '📦 الإيميلات غير المصدرة' }],
                [{ text: '🔙 العودة لقائمة الأدمن' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    },

    bulkEmailManagementEn: {
        reply_markup: {
            keyboard: [
                [{ text: '📤 Export All Emails' }],
                [{ text: '📤 Export Limited Emails' }],
                [{ text: '↩️ Restore from Export' }],
                [{ text: '✅ Send Approved & Approve' }],
                [{ text: '❌ Send Rejected & Reject' }],
                [{ text: '⏳ Pending Unapproved Emails' }],
                [{ text: '📦 Non-Exported Emails' }],
                [{ text: '🔙 Back to Admin Menu' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    }
};

// Helper function to get keyboard based on language
function getKeyboard(keyboardName, language = 'ar') {
    const suffix = language === 'en' ? 'En' : 'Ar';
    const fullKeyboardName = keyboardName + suffix;
    return keyboards[fullKeyboardName] || keyboards[keyboardName + 'Ar'];
}

// Dynamic function to create tasks menu with rewards
function createTasksMenuWithRewards(language = 'ar', emailReward = '', gmailReward = '') {
    const backButton = language === 'en' ? '🔙 Back to Main Menu' : '🔙 العودة للقائمة الرئيسية';

    if (emailReward && gmailReward) {
        const gmailButton = language === 'en' ?
            `📱 Gmail Creation Task - ${gmailReward}` :
            `📱 مهمة إنشاء جيميل - ${gmailReward}`;

        const emailButton = language === 'en' ?
            `📧 Email Creation Task - ${emailReward}` :
            `📧 مهمة إنشاء يوزرات - ${emailReward}`;

        return {
            reply_markup: {
                keyboard: [
                    [{ text: gmailButton }],
                    [{ text: emailButton }],
                    [{ text: backButton }]
                ],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        };
    } else {
        const gmailButton = language === 'en' ? '📱 Gmail Creation Task' : '📱 مهمة إنشاء جيميل';
        const emailButton = language === 'en' ? '📧 Email Creation Task' : '📧 مهمة إنشاء يوزرات';

        return {
            reply_markup: {
                keyboard: [
                    [{ text: gmailButton }],
                    [{ text: emailButton }],
                    [{ text: backButton }]
                ],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        };
    }
}

module.exports = {
    ...keyboards,
    getKeyboard,
    createTasksMenuWithRewards
};