const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./bot_database.db');

console.log('Checking database schema...\n');

// Check pending_accounts table
db.all("PRAGMA table_info(pending_accounts)", (err, rows) => {
    if (err) {
        console.error('Error checking pending_accounts:', err);
        return;
    }
    
    console.log('pending_accounts columns:');
    rows.forEach(col => {
        console.log(`  - ${col.name} (${col.type})`);
    });
    
    const hasExported = rows.some(col => col.name === 'exported');
    console.log(`\n✓ exported column exists: ${hasExported ? 'YES ✅' : 'NO ❌'}\n`);
});

// Check gmail_accounts table
db.all("PRAGMA table_info(gmail_accounts)", (err, rows) => {
    if (err) {
        console.error('Error checking gmail_accounts:', err);
        return;
    }
    
    console.log('gmail_accounts columns:');
    rows.forEach(col => {
        console.log(`  - ${col.name} (${col.type})`);
    });
    
    const hasExported = rows.some(col => col.name === 'exported');
    console.log(`\n✓ exported column exists: ${hasExported ? 'YES ✅' : 'NO ❌'}\n`);
    
    db.close();
});
