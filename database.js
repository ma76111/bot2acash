const sqlite3 = require('sqlite3').verbose();

class Database {
    constructor() {
        // High-performance database configuration for millions of users
        this.db = new sqlite3.Database('bot_database.db', (err) => {
            if (err) {
                console.error('Database connection error:', err);
            } else {
                console.log('Connected to SQLite database');
            }
        });

        // Performance optimizations
        this.db.run('PRAGMA journal_mode = WAL'); // Write-Ahead Logging for better concurrency
        this.db.run('PRAGMA synchronous = NORMAL'); // Balance between safety and performance
        this.db.run('PRAGMA cache_size = 10000'); // Increase cache size
        this.db.run('PRAGMA temp_store = MEMORY'); // Store temp tables in memory
        this.db.run('PRAGMA mmap_size = 268435456'); // 256MB memory-mapped I/O

        // Connection pooling simulation
        this.connectionPool = [];
        this.maxConnections = 10;

        this.initTables();
        this.updateTables(); // Add this for future updates
        this.createIndexes();
    }

    initTables() {
        // Users table with language support
        this.db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT,
                balance REAL DEFAULT 0,
                balance_usd REAL DEFAULT 0,
                preferred_currency TEXT DEFAULT 'EGP',
                preferred_language TEXT DEFAULT NULL,
                is_banned INTEGER DEFAULT 0,
                referral_code TEXT UNIQUE,
                referred_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (referred_by) REFERENCES users (id)
            )
        `);

        // Available accounts table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS available_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE,
                password TEXT,
                first_name TEXT,
                last_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Active tasks table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS active_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                email TEXT,
                password TEXT,
                first_name TEXT,
                last_name TEXT,
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        // Pending accounts table (for admin review)
        this.db.run(`
            CREATE TABLE IF NOT EXISTS pending_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                email TEXT,
                password TEXT,
                task_type TEXT DEFAULT 'email',
                exported INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                processed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        // Withdrawal requests table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS withdrawal_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                amount REAL,
                currency TEXT DEFAULT 'EGP',
                method TEXT,
                details TEXT,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                processed_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        // Admins table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS admins (
                id TEXT PRIMARY KEY,
                username TEXT,
                added_by TEXT,
                is_main_admin INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (added_by) REFERENCES admins (id)
            )
        `);

        // Settings table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Gmail accounts table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS gmail_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                email TEXT,
                exported INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                processed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);

        // Referrals table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS referrals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                referrer_id TEXT,
                referred_id TEXT,
                referral_code TEXT,
                reward_earned REAL DEFAULT 0,
                reward_currency TEXT DEFAULT 'EGP',
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                rewarded_at DATETIME,
                FOREIGN KEY (referrer_id) REFERENCES users (id),
                FOREIGN KEY (referred_id) REFERENCES users (id)
            )
        `);
    }

    // Clean duplicate accounts (keep the latest one)
    cleanDuplicateAccounts() {
        return new Promise((resolve, reject) => {
            this.db.run(`
                DELETE FROM available_accounts 
                WHERE id NOT IN (
                    SELECT MAX(id) 
                    FROM available_accounts 
                    GROUP BY email
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // Update existing tables with new columns (for database migrations)
    updateTables() {
        // Add first_name and last_name columns to available_accounts if they don't exist
        this.db.run('ALTER TABLE available_accounts ADD COLUMN first_name TEXT', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding first_name column to available_accounts:', err.message);
            }
        });

        this.db.run('ALTER TABLE available_accounts ADD COLUMN last_name TEXT', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding last_name column to available_accounts:', err.message);
            }
        });

        // Add first_name and last_name columns to active_tasks if they don't exist
        this.db.run('ALTER TABLE active_tasks ADD COLUMN first_name TEXT', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding first_name column to active_tasks:', err.message);
            }
        });

        this.db.run('ALTER TABLE active_tasks ADD COLUMN last_name TEXT', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding last_name column to active_tasks:', err.message);
            }
        });

        // Add processed_at to pending_accounts for tracking approval/rejection time
        this.db.run('ALTER TABLE pending_accounts ADD COLUMN processed_at DATETIME', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding processed_at column to pending_accounts:', err.message);
            }
        });

        // Add status column to pending_accounts for tracking state
        this.db.run("ALTER TABLE pending_accounts ADD COLUMN status TEXT DEFAULT 'pending'", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding status column to pending_accounts:', err.message);
            }
        });

        // Add exported column to pending_accounts for tracking export state
        this.db.run("ALTER TABLE pending_accounts ADD COLUMN exported INTEGER DEFAULT 0", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding exported column to pending_accounts:', err.message);
            }
        });

        // Add exported column to gmail_accounts for tracking export state
        this.db.run("ALTER TABLE gmail_accounts ADD COLUMN exported INTEGER DEFAULT 0", (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding exported column to gmail_accounts:', err.message);
            }
        });

        // Add processed_at to gmail_accounts for tracking approval/rejection time
        this.db.run('ALTER TABLE gmail_accounts ADD COLUMN processed_at DATETIME', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding processed_at column to gmail_accounts:', err.message);
            }
        });

        // Add country_code column to users if not exists
        this.db.run('ALTER TABLE users ADD COLUMN country_code TEXT DEFAULT NULL', (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('Error adding country_code column:', err.message);
            }
        });

        // Check and add referral columns to users table
        this.db.all("PRAGMA table_info(users)", (err, columns) => {
            if (err) {
                console.error('Error checking users table structure:', err.message);
                return;
            }

            const columnNames = columns.map(col => col.name);

            // Add referral_code column if it doesn't exist
            if (!columnNames.includes('referral_code')) {
                this.db.run('ALTER TABLE users ADD COLUMN referral_code TEXT', (alterErr) => {
                    if (alterErr) {
                        console.error('Error adding referral_code column:', alterErr.message);
                    } else {
                        console.log('✅ Added referral_code column to users table');
                    }
                });
            }

            // Add referred_by column if it doesn't exist
            if (!columnNames.includes('referred_by')) {
                this.db.run('ALTER TABLE users ADD COLUMN referred_by TEXT', (alterErr) => {
                    if (alterErr) {
                        console.error('Error adding referred_by column:', alterErr.message);
                    } else {
                        console.log('✅ Added referred_by column to users table');
                    }
                });
            }
        });

        // Check if referrals table exists, if not create it
        this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'", (err, row) => {
            if (err) {
                console.error('Error checking referrals table:', err.message);
                return;
            }

            if (!row) {
                console.log('🔄 Creating referrals table...');
                this.db.run(`
                    CREATE TABLE referrals (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        referrer_id TEXT,
                        referred_id TEXT,
                        referral_code TEXT,
                        reward_earned REAL DEFAULT 0,
                        reward_currency TEXT DEFAULT 'EGP',
                        status TEXT DEFAULT 'pending',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        rewarded_at DATETIME,
                        FOREIGN KEY (referrer_id) REFERENCES users (id),
                        FOREIGN KEY (referred_id) REFERENCES users (id)
                    )
                `, (createErr) => {
                    if (createErr) {
                        console.error('Error creating referrals table:', createErr.message);
                    } else {
                        console.log('✅ Referrals table created successfully');

                        // Create indexes for referrals table
                        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id)');
                        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id)');
                        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code)');
                        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status)');
                        console.log('✅ Referrals table indexes created');
                    }
                });
            } else {
                console.log('✅ Referrals table already exists');
            }
        });
    }

    // Create database indexes for high performance
    createIndexes() {
        // User table indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_id ON users(id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_language ON users(preferred_language)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_currency ON users(preferred_currency)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)');

        // Active tasks indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_active_tasks_user_id ON active_tasks(user_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_active_tasks_expires_at ON active_tasks(expires_at)');

        // Pending accounts indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_accounts_user_id ON pending_accounts(user_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_accounts_task_type ON pending_accounts(task_type)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_accounts_created_at ON pending_accounts(created_at)');

        // Withdrawal requests indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON withdrawal_requests(user_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_created_at ON withdrawal_requests(created_at)');

        // Available accounts indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_available_accounts_email ON available_accounts(email)');

        // Gmail accounts indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_gmail_accounts_user_id ON gmail_accounts(user_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_gmail_accounts_status ON gmail_accounts(status)');

        // Referrals indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)');

        console.log('Database indexes created for optimal performance');
    }

    // User management
    addUser(userId, username) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR IGNORE INTO users (id, username, preferred_language) VALUES (?, ?, NULL)',
                [userId, username],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM users WHERE id = ?',
                [userId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    // Search user by ID or username
    searchUser(searchTerm) {
        return new Promise((resolve, reject) => {
            // First try to find by ID (exact match)
            this.db.get(
                'SELECT * FROM users WHERE id = ?',
                [searchTerm],
                (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (row) {
                        resolve(row);
                        return;
                    }

                    // If not found by ID, search by username (case insensitive, partial match)
                    this.db.get(
                        'SELECT * FROM users WHERE username LIKE ? COLLATE NOCASE ORDER BY username LIMIT 1',
                        [`%${searchTerm}%`],
                        (err2, row2) => {
                            if (err2) reject(err2);
                            else resolve(row2);
                        }
                    );
                }
            );
        });
    }

    // Search multiple users by username (for showing multiple results)
    searchUsers(searchTerm, limit = 5) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM users WHERE username LIKE ? COLLATE NOCASE ORDER BY username LIMIT ?',
                [`%${searchTerm}%`, limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    updateUserLanguage(userId, language) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET preferred_language = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
                [language, userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    setUserPreferredCurrency(userId, currency) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET preferred_currency = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
                [currency, userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    setUserBalance(userId, balance) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET balance = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
                [balance, userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    setUserUSDBalance(userId, balance) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET balance_usd = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
                [balance, userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    banUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET is_banned = 1 WHERE id = ?',
                [userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    unbanUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET is_banned = 0 WHERE id = ?',
                [userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Account management
    addAvailableAccount(email, password, firstName = null, lastName = null) {
        return new Promise((resolve, reject) => {
            // First check if account already exists
            this.db.get(
                'SELECT id FROM available_accounts WHERE email = ?',
                [email],
                (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (row) {
                        // Account already exists, update password and names
                        this.db.run(
                            'UPDATE available_accounts SET password = ?, first_name = ?, last_name = ? WHERE email = ?',
                            [password, firstName, lastName, email],
                            function (updateErr) {
                                if (updateErr) reject(updateErr);
                                else resolve(row.id);
                            }
                        );
                    } else {
                        // Account doesn't exist, insert new one
                        this.db.run(
                            'INSERT INTO available_accounts (email, password, first_name, last_name) VALUES (?, ?, ?, ?)',
                            [email, password, firstName, lastName],
                            function (insertErr) {
                                if (insertErr) reject(insertErr);
                                else resolve(this.lastID);
                            }
                        );
                    }
                }
            );
        });
    }

    getRandomAvailableAccount() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM available_accounts ORDER BY RANDOM() LIMIT 1',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    removeAvailableAccount(accountId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM available_accounts WHERE id = ?',
                [accountId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Task management
    addActiveTask(userId, email, password, expiresAt, firstName = null, lastName = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO active_tasks (user_id, email, password, expires_at, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)',
                [userId, email, password, expiresAt, firstName, lastName],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getActiveTask(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM active_tasks WHERE user_id = ?',
                [userId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    removeActiveTask(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM active_tasks WHERE user_id = ?',
                [userId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Pending accounts for admin review
    addPendingAccount(userId, email, password, taskType = 'email') {
        return new Promise((resolve, reject) => {
            // Check if this email already exists in pending or processing state
            this.db.get(
                "SELECT * FROM pending_accounts WHERE email = ? AND task_type = ? AND (status = 'pending' OR status = 'processing' OR status IS NULL)",
                [email, taskType],
                (err, existingAccount) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    if (existingAccount) {
                        // Email already in pending, reject to prevent duplicate
                        reject(new Error('Email already in pending accounts'));
                        return;
                    }
                    
                    // Email not in pending, safe to add
                    this.db.run(
                        "INSERT INTO pending_accounts (user_id, email, password, task_type, status) VALUES (?, ?, ?, ?, 'pending')",
                        [userId, email, password, taskType],
                        function (err) {
                            if (err) reject(err);
                            else resolve(this.lastID);
                        }
                    );
                }
            );
        });
    }

    getPendingAccounts() {
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT * FROM pending_accounts WHERE status = 'pending' OR status IS NULL ORDER BY created_at DESC",
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    removePendingAccount(accountId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM pending_accounts WHERE id = ?',
                [accountId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Gmail accounts
    addGmailAccount(userId, email) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO gmail_accounts (user_id, email) VALUES (?, ?)',
                [userId, email],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getPendingGmailAccounts() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE status = "pending" ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    updateGmailAccountStatus(accountId, status) {
        return new Promise((resolve, reject) => {
            const now = new Date().toISOString();
            this.db.run(
                'UPDATE gmail_accounts SET status = ?, processed_at = ? WHERE id = ?',
                [status, now, accountId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Check if Gmail email already exists (excluding rejected ones)
    // Check if Gmail email exists (excluding rejected emails)
    // Returns true if email is:
    // - pending (waiting for approval) -> Cannot submit again
    // - approved (already approved) -> Cannot submit again
    // Returns false if email is:
    // - rejected (was rejected) -> Can submit again
    // - not found (never submitted) -> Can submit
    checkGmailEmailExists(email) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM gmail_accounts WHERE email = ? AND status != "rejected"',
                [email],
                (err, row) => {
                    if (err) {
                        console.error('Error checking Gmail email:', err.message);
                        resolve(false);
                    } else {
                        resolve(!!row);
                    }
                }
            );
        });
    }

    // Withdrawal requests
    addWithdrawalRequest(userId, amount, currency, method, details) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO withdrawal_requests (user_id, amount, currency, method, details) VALUES (?, ?, ?, ?, ?)',
                [userId, amount, currency, method, details],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getPendingWithdrawalRequests() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM withdrawal_requests WHERE status = "pending" ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    // Settings
    setSetting(key, value) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                [key, value],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    getSetting(key) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT value FROM settings WHERE key = ?',
                [key],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.value : null);
                }
            );
        });
    }

    // Statistics
    getUserCount() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT COUNT(*) as count FROM users',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row.count);
                }
            );
        });
    }

    getAvailableAccountsCount() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT COUNT(*) as count FROM available_accounts',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row.count);
                }
            );
        });
    }

    getAvailableAccountsList(limit = 50, offset = 0) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM available_accounts ORDER BY created_at DESC LIMIT ? OFFSET ?',
                [limit, offset],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    removeAvailableAccountById(accountId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM available_accounts WHERE id = ?',
                [accountId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    deleteAllAvailableAccounts() {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM available_accounts',
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    getTotalBalance() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT SUM(balance) as total FROM users',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row.total || 0);
                }
            );
        });
    }

    getLastUsers(limit = 10) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM users ORDER BY created_at DESC LIMIT ?',
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    getAllUsers() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM users WHERE is_banned = 0',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    close() {
        this.db.close();
    }

    // Delete withdrawal request and refund balance
    deleteWithdrawalRequest(requestId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM withdrawal_requests WHERE id = ? AND status = "pending"',
                [requestId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Complete withdrawal request
    completeWithdrawalRequest(requestId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE withdrawal_requests SET status = "completed", processed_at = datetime("now") WHERE id = ?',
                [requestId],
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Get withdrawal request by ID
    getWithdrawalRequest(requestId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM withdrawal_requests WHERE id = ?',
                [requestId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    // Referral system methods
    generateReferralCode(userId) {
        return new Promise((resolve, reject) => {
            // Generate a unique referral code based on user ID
            const code = `REF${userId.slice(-6)}${Date.now().toString().slice(-4)}`;

            // First check if referrals table exists
            this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'", (checkErr, row) => {
                if (checkErr) {
                    console.error('Error checking referrals table:', checkErr.message);
                    resolve(code); // Return code even if table check fails
                    return;
                }

                // Update user with referral code
                this.db.run(
                    'UPDATE users SET referral_code = ? WHERE id = ?',
                    [code, userId],
                    function (err) {
                        if (err) {
                            console.error('Error updating referral code:', err.message);
                            resolve(code); // Return code even if update fails
                        } else {
                            resolve(code);
                        }
                    }
                );
            });
        });
    }

    getUserByReferralCode(referralCode) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM users WHERE referral_code = ?',
                [referralCode],
                (err, row) => {
                    if (err) {
                        console.error('Error getting user by referral code:', err.message);
                        resolve(null);
                    } else {
                        resolve(row);
                    }
                }
            );
        });
    }

    setUserReferredBy(userId, referrerId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET referred_by = ? WHERE id = ?',
                [referrerId, userId],
                function (err) {
                    if (err) {
                        console.error('Error setting user referred by:', err.message);
                        resolve(0);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    addReferral(referrerId, referredId, referralCode) {
        return new Promise((resolve, reject) => {
            // Check if referrals table exists first
            this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'", (checkErr, row) => {
                if (checkErr || !row) {
                    console.error('Referrals table does not exist, skipping referral addition');
                    resolve(null);
                    return;
                }

                this.db.run(
                    'INSERT INTO referrals (referrer_id, referred_id, referral_code) VALUES (?, ?, ?)',
                    [referrerId, referredId, referralCode],
                    function (err) {
                        if (err) {
                            console.error('Error adding referral:', err.message);
                            resolve(null);
                        } else {
                            resolve(this.lastID);
                        }
                    }
                );
            });
        });
    }

    getReferralByReferredId(referredId) {
        return new Promise((resolve, reject) => {
            // Check if referrals table exists first
            this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'", (checkErr, tableRow) => {
                if (checkErr || !tableRow) {
                    console.log('Referrals table does not exist, returning null');
                    resolve(null);
                    return;
                }

                this.db.get(
                    'SELECT * FROM referrals WHERE referred_id = ?',
                    [referredId],
                    (err, row) => {
                        if (err) {
                            console.error('Error getting referral by referred ID:', err.message);
                            resolve(null);
                        } else {
                            resolve(row);
                        }
                    }
                );
            });
        });
    }

    updateReferralReward(referralId, reward, currency) {
        return new Promise((resolve, reject) => {
            if (!referralId) {
                resolve(0);
                return;
            }

            this.db.run(
                'UPDATE referrals SET reward_earned = ?, reward_currency = ?, status = "completed", rewarded_at = CURRENT_TIMESTAMP WHERE id = ?',
                [reward, currency, referralId],
                function (err) {
                    if (err) {
                        console.error('Error updating referral reward:', err.message);
                        resolve(0);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    getUserReferrals(userId) {
        return new Promise((resolve, reject) => {
            // Check if referrals table exists first
            this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'", (checkErr, tableRow) => {
                if (checkErr || !tableRow) {
                    console.log('Referrals table does not exist, returning empty array');
                    resolve([]);
                    return;
                }

                this.db.all(
                    `SELECT r.*, u.username as referred_username 
                     FROM referrals r 
                     LEFT JOIN users u ON r.referred_id = u.id 
                     WHERE r.referrer_id = ? 
                     ORDER BY r.created_at DESC`,
                    [userId],
                    (err, rows) => {
                        if (err) {
                            console.error('Error getting user referrals:', err.message);
                            resolve([]);
                        } else {
                            resolve(rows || []);
                        }
                    }
                );
            });
        });
    }

    getReferralStats(userId) {
        return new Promise((resolve, reject) => {
            // Check if referrals table exists first
            this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='referrals'", (checkErr, tableRow) => {
                if (checkErr || !tableRow) {
                    console.log('Referrals table does not exist, returning default stats');
                    resolve({ total_referrals: 0, completed_referrals: 0, total_earned: 0 });
                    return;
                }

                this.db.get(
                    `SELECT 
                        COUNT(*) as total_referrals,
                        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_referrals,
                        SUM(CASE WHEN status = 'completed' THEN reward_earned ELSE 0 END) as total_earned
                     FROM referrals 
                     WHERE referrer_id = ?`,
                    [userId],
                    (err, row) => {
                        if (err) {
                            console.error('Error getting referral stats:', err.message);
                            resolve({ total_referrals: 0, completed_referrals: 0, total_earned: 0 });
                        } else {
                            resolve(row || { total_referrals: 0, completed_referrals: 0, total_earned: 0 });
                        }
                    }
                );
            });
        });
    }

    // Bulk email management functions
    getAllPendingEmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM pending_accounts WHERE task_type = "email" ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    // Get only non-exported pending emails for export
    getNonExportedPendingEmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM pending_accounts WHERE task_type = "email" AND exported = 0 ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    getPendingGmailAccounts() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE status = "pending" ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    // Get only non-exported pending gmails for export
    getNonExportedPendingGmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE status = "pending" AND exported = 0 ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    markEmailsAsExported(emailIds, gmailIds) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                if (emailIds && emailIds.length > 0) {
                    const placeholders = emailIds.map(() => '?').join(',');
                    this.db.run(
                        `UPDATE pending_accounts SET exported = 1 WHERE id IN (${placeholders})`,
                        emailIds,
                        (err) => {
                            if (err) console.error('Error marking emails as exported:', err);
                        }
                    );
                }
                
                if (gmailIds && gmailIds.length > 0) {
                    const placeholders = gmailIds.map(() => '?').join(',');
                    this.db.run(
                        `UPDATE gmail_accounts SET exported = 1 WHERE id IN (${placeholders})`,
                        gmailIds,
                        (err) => {
                            if (err) console.error('Error marking gmails as exported:', err);
                        }
                    );
                }
                
                resolve();
            });
        });
    }

    getExportedEmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM pending_accounts WHERE task_type = "email" AND exported = 1 ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    getExportedGmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE exported = 1 ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    unmarkEmailsAsExported(emailIds, gmailIds) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                if (emailIds && emailIds.length > 0) {
                    const placeholders = emailIds.map(() => '?').join(',');
                    this.db.run(
                        `UPDATE pending_accounts SET exported = 0 WHERE id IN (${placeholders})`,
                        emailIds,
                        (err) => {
                            if (err) console.error('Error unmarking emails:', err);
                        }
                    );
                }
                
                if (gmailIds && gmailIds.length > 0) {
                    const placeholders = gmailIds.map(() => '?').join(',');
                    this.db.run(
                        `UPDATE gmail_accounts SET exported = 0 WHERE id IN (${placeholders})`,
                        gmailIds,
                        (err) => {
                            if (err) console.error('Error unmarking gmails:', err);
                        }
                    );
                }
                
                resolve();
            });
        });
    }

    getAllApprovedEmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE status = "approved" ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    getAllRejectedEmails() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE status = "rejected" ORDER BY created_at DESC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    bulkApproveEmails(emailIds) {
        return new Promise((resolve, reject) => {
            const placeholders = emailIds.map(() => '?').join(',');
            this.db.run(
                `UPDATE gmail_accounts SET status = "approved" WHERE id IN (${placeholders})`,
                emailIds,
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    bulkRejectEmails(emailIds) {
        return new Promise((resolve, reject) => {
            const placeholders = emailIds.map(() => '?').join(',');
            this.db.run(
                `UPDATE gmail_accounts SET status = "rejected" WHERE id IN (${placeholders})`,
                emailIds,
                function (err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Get Gmail account by ID
    getGmailAccountById(id) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM gmail_accounts WHERE id = ?',
                [id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    // Get pending account by ID
    getPendingAccountById(id) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM pending_accounts WHERE id = ?',
                [id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    // Update pending account status with timestamp
    updatePendingAccountStatus(id, status) {
        return new Promise((resolve, reject) => {
            const processedAt = (status === 'approved' || status === 'rejected')
                ? new Date().toISOString() : null;
            this.db.run(
                'UPDATE pending_accounts SET status = ?, processed_at = ? WHERE id = ?',
                [status, processedAt, id],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    // Get all pending/approved/rejected email accounts for a specific user
    getUserPendingAccounts(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM pending_accounts WHERE user_id = ? ORDER BY created_at DESC',
                [userId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    // Get all gmail accounts for a specific user (all statuses)
    getUserGmailAccounts(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gmail_accounts WHERE user_id = ? ORDER BY created_at DESC',
                [userId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    // Admin management methods
    addAdmin(adminId, username, addedBy) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO admins (id, username, added_by, is_main_admin) VALUES (?, ?, ?, 0)',
                [adminId, username, addedBy],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    removeAdmin(adminId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM admins WHERE id = ? AND is_main_admin = 0',
                [adminId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    isAdmin(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM admins WHERE id = ?',
                [userId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                }
            );
        });
    }

    isMainAdmin(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM admins WHERE id = ? AND is_main_admin = 1',
                [userId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                }
            );
        });
    }

    getAllAdmins() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM admins ORDER BY is_main_admin DESC, created_at ASC',
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    // جيب عدد ومجموع قيمة الإيميلات المقبولة لمستخدم معين
    getUserApprovedEmailsTotal(userId) {
        return new Promise((resolve, reject) => {
            const taskReward = this.db; // سنجيب الـ reward من settings
            this.db.get(
                `SELECT 
                    COUNT(*) as count
                 FROM (
                    SELECT id FROM pending_accounts 
                    WHERE user_id = ? AND status = 'approved'
                    UNION ALL
                    SELECT id FROM gmail_accounts 
                    WHERE user_id = ? AND status = 'approved'
                 )`,
                [userId, userId],
                async (err, row) => {
                    if (err) { resolve({ count: 0, totalEarned: 0 }); return; }
                    
                    // جيب الـ rewards من الـ settings
                    this.db.get("SELECT value FROM settings WHERE key = 'task_reward'", (e1, r1) => {
                        this.db.get("SELECT value FROM settings WHERE key = 'gmail_task_reward'", (e2, r2) => {
                            const emailReward = parseFloat(r1?.value || 5);
                            const gmailReward = parseFloat(r2?.value || 5);

                            this.db.get(
                                `SELECT COUNT(*) as emailCount FROM pending_accounts WHERE user_id = ? AND status = 'approved'`,
                                [userId],
                                (e3, emailRow) => {
                                    this.db.get(
                                        `SELECT COUNT(*) as gmailCount FROM gmail_accounts WHERE user_id = ? AND status = 'approved'`,
                                        [userId],
                                        (e4, gmailRow) => {
                                            const emailCount = emailRow?.emailCount || 0;
                                            const gmailCount = gmailRow?.gmailCount || 0;
                                            const totalEarned = (emailCount * emailReward) + (gmailCount * gmailReward);
                                            resolve({ count: row?.count || 0, totalEarned });
                                        }
                                    );
                                }
                            );
                        });
                    });
                }
            );
        });
    }

    // جيب مجموع السحوبات المكتملة لمستخدم قبل طلب معين
    getUserWithdrawalsTotalBeforeRequest(userId, requestId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT COALESCE(SUM(amount), 0) as total
                 FROM withdrawal_requests
                 WHERE user_id = ? 
                   AND id < ?
                   AND status = 'completed'`,
                [userId, requestId],
                (err, row) => {
                    if (err) resolve(0);
                    else resolve(parseFloat(row?.total) || 0);
                }
            );
        });
    }

    // Country management
    setUserCountry(userId, countryCode) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET country_code = ? WHERE id = ?',
                [countryCode, userId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    getAllowedCountries() {
        return new Promise((resolve, reject) => {
            this.db.get(
                "SELECT value FROM settings WHERE key = 'allowed_countries'",
                (err, row) => {
                    if (err) reject(err);
                    else {
                        try {
                            resolve(row ? JSON.parse(row.value) : []);
                        } catch {
                            resolve([]);
                        }
                    }
                }
            );
        });
    }

    setAllowedCountries(countryCodes) {
        return new Promise((resolve, reject) => {
            this.db.run(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('allowed_countries', ?, CURRENT_TIMESTAMP)",
                [JSON.stringify(countryCodes)],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    initMainAdmin(adminId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR IGNORE INTO admins (id, username, is_main_admin) VALUES (?, ?, 1)',
                [adminId, 'Main Admin'],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }
}

module.exports = Database;