const cluster = require('cluster');
const os = require('os');
const config = require('./config');

// High-performance clustering for millions of users
if (cluster.isMaster) {
    const numWorkers = config.PERFORMANCE.MAX_WORKERS || os.cpus().length;
    
    console.log(`🚀 Starting ${numWorkers} worker processes for high-performance bot...`);
    console.log(`💪 Optimized for millions of concurrent users`);
    
    // Fork workers
    for (let i = 0; i < numWorkers; i++) {
        const worker = cluster.fork();
        console.log(`✅ Worker ${worker.process.pid} started`);
    }
    
    // Handle worker crashes
    cluster.on('exit', (worker, code, signal) => {
        console.log(`❌ Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
        console.log('🔄 Starting a new worker...');
        const newWorker = cluster.fork();
        console.log(`✅ New worker ${newWorker.process.pid} started`);
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('🛑 Master received SIGTERM, shutting down workers...');
        for (const id in cluster.workers) {
            cluster.workers[id].kill();
        }
    });
    
    // Performance monitoring
    setInterval(() => {
        const workers = Object.keys(cluster.workers).length;
        const memUsage = process.memoryUsage();
        console.log(`📊 Performance Stats:`);
        console.log(`   Active Workers: ${workers}`);
        console.log(`   Memory Usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
        console.log(`   Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    }, 60000); // Every minute
    
} else {
    // Worker process - run the actual bot
    console.log(`🤖 Bot worker ${process.pid} starting...`);
    
    // Add worker-specific error handling
    process.on('uncaughtException', (error) => {
        console.error(`Worker ${process.pid} uncaught exception:`, error);
        // Don't exit immediately, let cluster manager handle it
        setTimeout(() => process.exit(1), 1000);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error(`Worker ${process.pid} unhandled rejection:`, reason);
    });
    
    // Start the bot
    require('./bot.js');
    
    console.log(`✅ Bot worker ${process.pid} ready for millions of users!`);
}

// Memory usage monitoring for all processes
setInterval(() => {
    if (process.memoryUsage().heapUsed > 500 * 1024 * 1024) { // 500MB threshold
        console.warn(`⚠️ High memory usage detected in process ${process.pid}`);
        if (global.gc) {
            global.gc();
            console.log(`🧹 Garbage collection triggered in process ${process.pid}`);
        }
    }
}, 30000); // Check every 30 seconds