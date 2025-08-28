
const MinecraftBot = require('./bot');
const StatusServer = require('./server');

// Configuration - Replace with your Aternos server details
const config = {
  host: process.env.MC_HOST || 'SAMEER05404.aternos.me',
  port: parseInt(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'DARK_WORLD_1'.replace(/[^a-zA-Z0-9_]/g, '_')
};

console.log('🚀 Starting Minecraft AFK Bot...');
console.log('📋 Configuration:', {
  host: config.host,
  port: config.port,
  username: config.username
});

// Create bot instance
const bot = new MinecraftBot(config);

// Create and start web server
const server = new StatusServer(bot);

async function start() {
  try {
    // Start the web server first
    await server.start(5000);

    // Then start the bot
    bot.connect();

    console.log('✅ Application started successfully!');
    console.log('🤖 Bot will automatically connect and reconnect as needed');
    console.log('🌐 Visit the status page to monitor the bot');

  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown - but prevent actual shutdown for 24/7 operation
process.on('SIGINT', () => {
  console.log('\n🔄 Received shutdown signal but bot must continue running 24/7');
  console.log('🤖 Restarting bot connection...');
  // Don't actually shutdown, just restart the bot
  setTimeout(() => {
    if (bot) {
      bot.connect();
    }
  }, 2000);
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Received termination signal but bot must continue running 24/7');
  console.log('🤖 Restarting bot connection...');
  // Don't actually shutdown, just restart the bot
  setTimeout(() => {
    if (bot) {
      bot.connect();
    }
  }, 2000);
});

// Handle uncaught errors - restart instead of crashing
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.log('🚀 Auto-restarting application after uncaught exception...');
  
  // Restart the bot instead of crashing
  setTimeout(() => {
    try {
      if (bot) {
        bot.connect();
      }
    } catch (err) {
      console.log('⚠ Error restarting after exception:', err.message);
    }
  }, 3000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('🚀 Auto-restarting after unhandled rejection...');
  
  // Restart the bot instead of crashing
  setTimeout(() => {
    try {
      if (bot) {
        bot.connect();
      }
    } catch (err) {
      console.log('⚠ Error restarting after rejection:', err.message);
    }
  }, 3000);
});

// Add periodic health check to ensure bot stays alive
setInterval(() => {
  if (!bot || !bot.connected) {
    console.log('💓 Health check: Bot not connected, attempting reconnection...');
    try {
      if (bot) {
        bot.connect();
      }
    } catch (error) {
      console.log('⚠ Health check reconnection error:', error.message);
    }
  } else {
    console.log('💓 Health check: Bot is running normally');
  }
}, 300000); // Check every 5 minutes

start();
