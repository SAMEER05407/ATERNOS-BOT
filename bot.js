
const mineflayer = require('mineflayer');

class MinecraftBot {
  constructor(config) {
    this.config = config;
    this.bot = null;
    this.connected = false;
    this.lastError = null;
    this.reconnectTimeout = null;
    this.status = 'disconnected';
    this.baseUsername = 'DARK_WORLD';
    this.usernameCounter = 1;
    this.currentUsername = `${this.baseUsername}_${this.usernameCounter}`;
    this.isShuttingDown = false;
    this.bannedUsernames = new Set();
    this.autoExitTimeout = null;
  }

  connect() {
    if (this.status === 'connecting' || this.isShuttingDown) return;

    // Disconnect any existing bot first
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit();
      } catch (error) {
        console.log('⚠ Error quitting bot:', error.message);
      }
      this.bot = null;
    }

    this.status = 'connecting';
    this.connected = false;

    console.log(`⏳ Connecting to server with username: ${this.currentUsername}...`);

    try {
      this.bot = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.currentUsername,
        auth: 'offline',
        skipValidation: true,
        checkTimeoutInterval: 30000,
        hideErrors: false
      });

      this.setupEventHandlers();
    } catch (error) {
      this.handleError('Connection creation failed', error);
    }
  }

  setupEventHandlers() {
    this.bot.on('login', () => {
      console.log('🔐 Logged in to server...');
    });

    this.bot.on('spawn', () => {
      console.log('✅ Connected and spawned successfully!');
      this.connected = true;
      this.status = 'connected';
      this.lastError = null;
      
      // Exit immediately after connecting (within 1-2 seconds)
      this.autoExitTimeout = setTimeout(() => {
        console.log('🚪 Auto-exiting after brief connection...');
        this.disconnect();
        this.scheduleReconnect();
      }, 1500); // Exit after 1.5 seconds
    });

    this.bot.on('kicked', (reason) => {
      console.log('❌ Kicked from server:', reason);

      const reasonStr = typeof reason === 'object' ? JSON.stringify(reason) : reason.toString();
      const isBanned = reasonStr.includes('banned') || reasonStr.includes('ban') || 
                      reasonStr.includes('multiplayer.disconnect.banned');

      if (isBanned) {
        console.log('🚫 Bot was banned! Switching to next username...');
        this.bannedUsernames.add(this.currentUsername);
        this.switchToNextUsername();

        this.connected = false;
        this.status = 'disconnected';
        this.lastError = 'Banned: ' + reasonStr;

        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        console.log('🚀 Immediately connecting with new username...');
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.connect();
          }
        }, 1000);

        return;
      }

      this.handleDisconnect('Kicked: ' + reasonStr);
    });

    this.bot.on('end', (reason) => {
      console.log('❌ Connection ended:', reason);
      this.handleDisconnect('Connection ended: ' + reason);
    });

    this.bot.on('error', (err) => {
      console.log('⚠ Bot error:', err.message);
      this.handleError('Bot error', err);
    });
  }

  handleDisconnect(reason) {
    this.connected = false;
    this.status = 'disconnected';
    this.lastError = reason;
    this.clearAutoExit();
    this.scheduleReconnect();
  }

  handleError(message, error) {
    this.connected = false;
    this.status = 'disconnected';
    this.lastError = `${message}: ${error.message}`;
    console.log('⚠ Error:', this.lastError);
    this.clearAutoExit();
    
    // For connection errors, immediately try with next username
    if (message.includes('Connection creation failed') || error.message.includes('ECONNREFUSED')) {
      console.log('🔄 Connection failed - trying next username immediately...');
      this.switchToNextUsername();
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.connect();
        }
      }, 2000);
    } else {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout || this.isShuttingDown) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    const delay = 40000; // 40 seconds

    console.log(`🔄 Reconnecting in ${delay/1000} seconds...`);
    this.reconnectTimeout = setTimeout(() => {
      if (!this.isShuttingDown) {
        this.connect();
      }
    }, delay);
  }

  clearAutoExit() {
    if (this.autoExitTimeout) {
      clearTimeout(this.autoExitTimeout);
      this.autoExitTimeout = null;
    }
  }

  switchToNextUsername() {
    do {
      this.usernameCounter++;
      this.currentUsername = `${this.baseUsername}_${this.usernameCounter}`;
    } while (this.bannedUsernames.has(this.currentUsername));

    console.log(`🔄 Switched to new username: ${this.currentUsername}`);
  }

  getStatus() {
    return {
      connected: this.connected,
      status: this.status,
      lastError: this.lastError,
      username: this.currentUsername,
      server: `${this.config.host}:${this.config.port}`,
      bannedUsernames: Array.from(this.bannedUsernames),
      usernameCounter: this.usernameCounter
    };
  }

  disconnect() {
    this.isShuttingDown = true;
    this.clearAutoExit();
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit();
      } catch (error) {
        console.log('⚠ Error quitting bot:', error.message);
      }
      this.bot = null;
    }
    
    this.connected = false;
    this.status = 'disconnected';
  }
}

module.exports = MinecraftBot;
