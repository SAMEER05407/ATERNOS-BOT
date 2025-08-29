
const MinecraftBot = require('./bot');
const StatusServer = require('./server');

// Configuration - Replace with your Aternos server details
const config = {
  host: process.env.MC_HOST || 'SAMEER05404.aternos.me',
  port: parseInt(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'VISITOR_BOT'.replace(/[^a-zA-Z0-9_]/g, '_')
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

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.disconnect();
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  bot.disconnect();
  server.stop();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

start();
