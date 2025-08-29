
const mineflayer = require('mineflayer');
const net = require('net');

class MinecraftBot {
  constructor(config) {
    this.config = config;
    this.bot = null;
    this.connected = false;
    this.lastError = null;
    this.reconnectTimeout = null;
    this.activityInterval = null;
    this.status = 'disconnected'; // disconnected, connecting, connected
    this.baseUsername = 'DARK_WORLD';
    this.usernameCounter = 1;
    this.currentUsername = `${this.baseUsername}_${this.usernameCounter}`;
    this.isShuttingDown = false;
    this.bannedUsernames = new Set(); // Track banned usernames
    this.realPlayersOnline = new Set(); // Track real players (non-bot players)
    this.playerCheckInterval = null;
    this.isHidingFromPlayers = false; // Flag to track if bot is hiding from real players
    
    // Connection management improvements
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 10;
    this.baseDelay = 30000; // 30 seconds base delay
    this.maxDelay = 300000; // 5 minutes max delay
    this.lastConnectionTime = 0;
    this.minTimeBetweenConnections = 10000; // 10 seconds minimum between attempts
    this.throttleCount = 0;
    this.maxThrottleCount = 5;
  }

  async connect() {
    if (this.status === 'connecting' || this.isShuttingDown) return;

    // Check minimum time between connections
    const now = Date.now();
    const timeSinceLastConnection = now - this.lastConnectionTime;
    if (timeSinceLastConnection < this.minTimeBetweenConnections) {
      const waitTime = this.minTimeBetweenConnections - timeSinceLastConnection;
      console.log(`⏰ Rate limiting: waiting ${Math.round(waitTime/1000)}s before next connection attempt`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastConnectionTime = Date.now();
    this.connectionAttempts++;

    // Check if we've hit too many throttling events
    if (this.throttleCount >= this.maxThrottleCount) {
      console.log(`🚫 Too many throttling events (${this.throttleCount}), taking extended break...`);
      await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minute break
      this.throttleCount = 0; // Reset throttle count
    }

    // Check if server is online first
    const isServerOnline = await this.checkServerStatus();
    if (!isServerOnline) {
      console.log('📴 Server appears to be offline, will retry later...');
      this.handleError('Server offline', new Error('Server is not responding'));
      return;
    }

    // Disconnect any existing bot first
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit();
        // Wait a moment for clean disconnect
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.log('⚠ Error quitting bot:', error.message);
      }
      this.bot = null;
    }

    this.status = 'connecting';
    this.connected = false;

    console.log(`⏳ Connecting to server with username: ${this.currentUsername}... (Attempt ${this.connectionAttempts})`);

    try {
      this.bot = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.currentUsername,
        // version will be auto-detected
        auth: 'offline', // For cracked servers
        skipValidation: true, // Skip username validation
        checkTimeoutInterval: 30000, // Reduced timeout for faster detection
        hideErrors: true, // Hide minor protocol errors
        connectTimeout: 20000, // 20 second connection timeout
        // Additional options for better error handling
        keepAlive: true,
        // Prevent chunk errors
        viewDistance: 'tiny',
        // More robust packet handling
        packetWhitelist: null, // Allow all packets but handle errors gracefully
        // Better error recovery
        errorHandler: (err) => {
          if (err.message && (
            err.message.includes('Chunk size mismatch') ||
            err.message.includes('explosion packet') ||
            err.message.includes('Invalid packet')
          )) {
            console.log('⚠ Suppressed packet error:', err.message);
            return; // Don't throw
          }
          throw err; // Re-throw other errors
        }
      });

      this.setupEventHandlers();
    } catch (error) {
      this.handleError('Connection creation failed', error);
    }
  }

  async checkServerStatus() {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5000); // 5 second timeout
      
      socket.connect(this.config.port, this.config.host, () => {
        clearTimeout(timeout);
        socket.destroy();
        console.log('✅ Server is online and reachable');
        resolve(true);
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        console.log('❌ Server is offline or unreachable');
        resolve(false);
      });
    });
  }

  setupEventHandlers() {
    // Add packet error handlers to prevent crashes
    this.bot.on('packet', (data, name, direction) => {
      // Silently handle problematic packets
      if (name === 'explosion' || name === 'chunk_data' || name === 'map_chunk') {
        // Just ignore these packets if they cause issues
      }
    });

    // Handle protocol errors gracefully
    this.bot._client.on('error', (err) => {
      if (err.message && (
        err.message.includes('Chunk size mismatch') ||
        err.message.includes('explosion packet') ||
        err.message.includes('Invalid packet') ||
        err.message.includes('Protocol error') ||
        err.message.includes('parse') ||
        err.message.includes('chunk')
      )) {
        console.log('⚠ Ignoring protocol/packet error:', err.message);
        return; // Don't crash, just ignore
      }
      
      // Re-emit other errors to be handled by main error handler
      this.bot.emit('error', err);
    });

    // Handle raw socket errors
    if (this.bot._client && this.bot._client.socket) {
      this.bot._client.socket.on('error', (err) => {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
          console.log('🔌 Socket error, will reconnect:', err.code);
          this.handleError('Socket error', err);
        }
      });
    }

    this.bot.on('login', () => {
      console.log('🔐 Logged in to server...');
    });

    this.bot.on('spawn', () => {
      console.log('✅ Connected and spawned successfully!');
      this.connected = true;
      this.status = 'connected';
      this.lastError = null;
      
      // Reset connection tracking on successful connection
      this.connectionAttempts = 0;
      this.throttleCount = 0;
      
      this.startPlayerMonitoring();
      this.startFastPlayerDetection(); // Fast detection for immediate exit
      this.startActivity();
    });

    this.bot.on('kicked', (reason) => {
      console.log('❌ Kicked from server:', reason);

      // Check if it's a ban
      const reasonStr = typeof reason === 'object' ? JSON.stringify(reason) : reason.toString();
      const isBanned = reasonStr.includes('banned') || reasonStr.includes('ban') || 
                      reasonStr.includes('multiplayer.disconnect.banned');
      const isThrottled = reasonStr.includes('throttled') || reasonStr.includes('wait before reconnecting');
      const isDuplicateLogin = reasonStr.includes('duplicate_login') || reasonStr.includes('duplicate login');

      if (isDuplicateLogin) {
        console.log('🔄 Duplicate login detected! Another instance may be running. Switching username...');
        this.bannedUsernames.add(this.currentUsername);
        this.switchToNextUsername();

        this.connected = false;
        this.status = 'switching_username';
        this.lastError = `Duplicate login - switched to ${this.currentUsername}`;
        this.stopActivity();

        // Cancel any existing reconnect timeout
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Immediate reconnect with new username after short delay
        console.log(`🚀 Immediately connecting with new username: ${this.currentUsername}`);
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.connect();
          }
        }, 3000); // Only 3 second delay for quick username switch

        return;
      }

      if (isBanned) {
        console.log('🚫 Bot was banned! Switching to next username...');
        this.bannedUsernames.add(this.currentUsername);
        this.switchToNextUsername();

        // Connect immediately with new username instead of waiting
        this.connected = false;
        this.status = 'disconnected';
        this.lastError = 'Banned: ' + reasonStr;
        this.stopActivity();

        // Cancel any existing reconnect timeout
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        // Connect immediately with new username
        console.log('🚀 Immediately connecting with new username...');
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.connect();
          }
        }, 1000); // Small 1 second delay to ensure clean disconnect

        return; // Don't call handleDisconnect as we're handling reconnection here
      }

      if (isThrottled) {
        console.log('⏰ Connection throttled! Will wait longer before reconnecting...');
      }

      this.handleDisconnect('Kicked: ' + reasonStr);
    });

    this.bot.on('end', (reason) => {
      console.log('❌ Connection ended:', reason);
      this.handleDisconnect('Connection ended: ' + reason);
    });

    this.bot.on('error', (err) => {
      console.log('⚠ Bot error:', err.message);
      
      // Ignore packet/protocol errors that shouldn't cause reconnection
      if (err.message && (
        err.message.includes('Chunk size mismatch') ||
        err.message.includes('explosion packet') ||
        err.message.includes('Invalid packet') ||
        err.message.includes('Protocol error') ||
        err.message.includes('parse error') ||
        err.message.includes('packet') ||
        err.message.includes('chunk') ||
        err.message.includes('Unknown packet')
      )) {
        console.log('⚠ Ignoring packet/protocol error - continuing operation');
        return; // Don't reconnect for these errors
      }
      
      // Handle specific network errors that require reconnection
      if (err.code === 'ECONNRESET') {
        console.log('🔌 Connection reset by server - network issue or server restart');
        this.handleError('Connection reset (ECONNRESET)', err);
      } else if (err.code === 'ECONNREFUSED') {
        console.log('🚫 Connection refused - server may be offline');
        this.handleError('Connection refused (ECONNREFUSED)', err);
      } else if (err.code === 'ETIMEDOUT') {
        console.log('⏰ Connection timeout - server may be slow or offline');
        this.handleError('Connection timeout (ETIMEDOUT)', err);
      } else if (err.message && err.message.includes('read ECONNRESET')) {
        console.log('📡 Read connection reset - server disconnected unexpectedly');
        this.handleError('Read connection reset', err);
      } else if (err.message && err.message.includes('socket hang up')) {
        console.log('🔌 Socket hang up - server disconnected');
        this.handleError('Socket hang up', err);
      } else {
        console.log('🔧 General bot error:', err.code || 'Unknown');
        this.handleError('Bot error', err);
      }
    });

    this.bot.on('death', () => {
      console.log('💀 Bot died, respawning...');
    });

    // Immediate player join detection
    this.bot.on('playerJoined', (player) => {
      console.log(`👤 Player joined: ${player.username}`);

      // Allow DARK bots to join without triggering exit
      const isDarkBot = player.username.startsWith('DARK');

      // Check if it's a real player (not our bot or other DARK bots)
      const isBotPattern = 
        player.username.startsWith('DARK_WORLD') || 
        player.username.startsWith('AFK') ||
        player.username.startsWith('BOT') ||
        player.username.includes('_BOT') ||
        player.username.includes('BOT_') ||
        /^[A-Z_]+_\d+$/.test(player.username) ||
        /^[A-Z]+\d+$/.test(player.username) ||
        player.username.toLowerCase().includes('afk') ||
        player.username.toLowerCase().includes('bot') ||
        isDarkBot; // DARK bots are friendly

      if (!isBotPattern && player.username !== this.currentUsername) {
        console.log('🚨🚨🚨 REAL PLAYER JOINED EVENT! 🚨🚨🚨');
        console.log(`Real player: ${player.username}`);
        console.log('⚡ INSTANT EXIT TRIGGERED BY EVENT');
        this.forceExitForRealPlayers([player.username]);
      } else if (isDarkBot && player.username !== this.currentUsername) {
        console.log(`🤖 DARK bot joined: ${player.username} - Welcome fellow DARK bot!`);
      }
    });

    // Player leave detection
    this.bot.on('playerLeft', (player) => {
      console.log(`👋 Player left: ${player.username}`);

      if (this.realPlayersOnline.has(player.username)) {
        this.realPlayersOnline.delete(player.username);
        console.log(`📊 Real players remaining: ${this.realPlayersOnline.size}`);

        if (this.realPlayersOnline.size === 0 && this.isHidingFromPlayers) {
          console.log('✅ All real players left - preparing to return');
        }
      }
    });
  }

  handleDisconnect(reason) {
    this.connected = false;
    this.status = 'disconnected';
    this.lastError = reason;
    this.stopActivity();
    this.stopFastPlayerDetection();

    // Keep player monitoring active if hiding from real players
    if (!this.isHidingFromPlayers) {
      this.stopPlayerMonitoring();
      this.scheduleReconnect();
    } else {
      // Keep monitoring active to detect when to return
      console.log('👀 Keeping player monitoring active while hiding...');
    }
  }

  handleError(message, error) {
    this.connected = false;
    this.status = 'disconnected';
    this.lastError = `${message}: ${error.message}`;
    console.log('⚠ Error:', this.lastError);
    this.stopActivity();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    // Remove isShuttingDown check to ensure 24/7 operation
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Check error type for appropriate delay
    const isThrottled = this.lastError && this.lastError.includes('throttled');
    const isNetworkError = this.lastError && (
      this.lastError.includes('ECONNRESET') || 
      this.lastError.includes('ECONNREFUSED') || 
      this.lastError.includes('ETIMEDOUT') ||
      this.lastError.includes('Network connection failed') ||
      this.lastError.includes('Server offline')
    );
    const isDuplicateLogin = this.lastError && this.lastError.includes('Duplicate login');

    let delay;
    
    if (isDuplicateLogin) {
      delay = 5000; // 5 seconds for duplicate login
      this.connectionAttempts = 0; // Reset on duplicate login
    } else if (isThrottled) {
      this.throttleCount++;
      // Exponential backoff for throttling with longer delays
      const exponentialDelay = Math.min(this.baseDelay * Math.pow(2, this.throttleCount - 1), this.maxDelay);
      delay = exponentialDelay;
      console.log(`⏰ Connection throttled! Throttle event #${this.throttleCount}, using exponential backoff...`);
    } else if (isNetworkError) {
      // Exponential backoff for network errors
      const exponentialDelay = Math.min(this.baseDelay * Math.pow(1.5, this.connectionAttempts - 1), 120000);
      delay = exponentialDelay;
    } else {
      // Progressive delay for normal errors
      delay = Math.min(10000 + (this.connectionAttempts * 5000), 60000); // 10s, 15s, 20s... up to 60s
    }

    // Reset connection attempts on successful patterns
    if (this.connectionAttempts > this.maxConnectionAttempts) {
      console.log(`🔄 Resetting connection attempts after ${this.connectionAttempts} tries`);
      this.connectionAttempts = 0;
      delay = Math.max(delay, 60000); // Minimum 1 minute after max attempts
    }

    console.log(`❌ Disconnected, retrying in ${Math.round(delay/1000)} seconds... (24/7 MODE - Never giving up!)`);
    console.log(`🔍 Error type: ${isNetworkError ? 'Network/Server' : isThrottled ? 'Throttled' : isDuplicateLogin ? 'Duplicate Login' : 'Normal'} | Attempt: ${this.connectionAttempts} | Throttle: ${this.throttleCount}`);
    
    this.reconnectTimeout = setTimeout(async () => {
      // Always reconnect - no shutdown checks for 24/7 operation
      console.log('🚀 24/7 Auto-reconnect triggered!');
      
      // For network errors, continuously check server status
      if (isNetworkError) {
        await this.waitForServerOnline();
      }
      
      this.connect();
    }, delay);
  }

  async waitForServerOnline() {
    console.log('🔍 Continuously monitoring server status...');
    let attempts = 0;
    const maxAttempts = 40; // Maximum 40 attempts (about 20 minutes)
    
    while (!this.isShuttingDown && attempts < maxAttempts) {
      attempts++;
      console.log(`🔍 Server check ${attempts}/${maxAttempts}...`);
      
      const isOnline = await this.checkServerStatus();
      if (isOnline) {
        console.log('🎉 Server is back online! Connecting immediately...');
        break;
      }
      
      // Progressive delay - start with 20 seconds, increase to 45 seconds
      const delay = attempts < 10 ? 20000 : attempts < 20 ? 30000 : 45000;
      console.log(`📴 Server still offline, checking again in ${delay/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    if (attempts >= maxAttempts) {
      console.log('⏰ Maximum server monitoring attempts reached, will try connection anyway');
    }
  }

  startActivity() {
    if (this.activityInterval) return;

    console.log('🎮 Starting realistic player activities...');

    // Keep the bot active with realistic player behaviors
    this.activityInterval = setInterval(() => {
      if (!this.connected || !this.bot) return;

      try {
        // Realistic player activities
        const activities = [
          () => {
            // Explore and walk with random jumping
            this.bot.setControlState('forward', true);
            if (Math.random() < 0.4) {
              this.bot.setControlState('jump', true);
              console.log('🦘 Bot jumping while exploring');
            }
          },
          () => {
            // Sprint and explore
            this.bot.setControlState('forward', true);
            this.bot.setControlState('sprint', true);
            console.log('🏃 Bot sprinting');
          },
          () => {
            // Turn left and move
            this.bot.setControlState('left', true);
            this.bot.setControlState('forward', true);
            if (Math.random() < 0.3) this.bot.setControlState('jump', true);
            console.log('↪️ Bot turning left and moving');
          },
          () => {
            // Turn right and move
            this.bot.setControlState('right', true);
            this.bot.setControlState('forward', true);
            if (Math.random() < 0.3) this.bot.setControlState('jump', true);
            console.log('↩️ Bot turning right and moving');
          },
          () => {
            // Random jumping in place (like a real player would)
            for (let i = 0; i < 3; i++) {
              setTimeout(() => {
                if (this.bot && this.connected) {
                  this.bot.setControlState('jump', true);
                  setTimeout(() => {
                    if (this.bot && this.connected) {
                      this.bot.setControlState('jump', false);
                    }
                  }, 200);
                }
              }, i * 400);
            }
            console.log('🦘 Bot doing random jumps');
          },
          () => {
            // Look around while standing (realistic behavior)
            const directions = [
              { yaw: 0, pitch: 0 },
              { yaw: Math.PI / 2, pitch: 0 },
              { yaw: Math.PI, pitch: 0 },
              { yaw: -Math.PI / 2, pitch: 0 },
              { yaw: Math.random() * Math.PI * 2, pitch: (Math.random() - 0.5) * 0.8 }
            ];
            
            const direction = directions[Math.floor(Math.random() * directions.length)];
            this.bot.look(direction.yaw, direction.pitch);
            console.log('👀 Bot looking around');
          }
        ];

        // Clear previous states
        if (this.bot && typeof this.bot.clearControlStates === 'function') {
          this.bot.clearControlStates();
        }

        // Perform random activity
        const activity = activities[Math.floor(Math.random() * activities.length)];
        activity();

        // Try realistic activities (eating, hunting, crafting, etc.)
        if (Math.random() < 0.4) { // 40% chance for more activity
          this.performBlockActivity();
        }

        // Chat occasionally like a real player
        if (Math.random() < 0.05) { // 5% chance to chat
          this.sendRealisticChat();
        }

        // Check hunger and health
        if (Math.random() < 0.3) { // 30% chance to check status
          this.monitorBotStats();
        }

        // Continue activity for realistic duration
        const activityDuration = 1500 + Math.random() * 4000; // 1.5-5.5 seconds
        setTimeout(() => {
          if (this.bot && typeof this.bot.clearControlStates === 'function') {
            this.bot.clearControlStates();

            // Pause and look around (realistic player behavior)
            setTimeout(() => {
              if (this.bot && this.connected && typeof this.bot.look === 'function') {
                const randomYaw = Math.random() * Math.PI * 2;
                const randomPitch = (Math.random() - 0.5) * 0.6;
                this.bot.look(randomYaw, randomPitch);
              }
            }, 300 + Math.random() * 500);
          }
        }, activityDuration);

      } catch (error) {
        console.log('⚠ Activity error:', error.message);
      }
    }, 2000 + Math.random() * 3000); // Every 2-5 seconds
  }

  performBlockActivity() {
    if (!this.bot || !this.connected) return;

    try {
      // Decide what activity to perform
      const activities = [
        'mining', 'eating', 'hunting', 'crafting', 'exploring_roads', 'building'
      ];
      
      const activity = activities[Math.floor(Math.random() * activities.length)];
      
      switch (activity) {
        case 'eating':
          this.eatFood();
          break;
        case 'hunting':
          this.huntAnimals();
          break;
        case 'crafting':
          this.craftWeapons();
          break;
        case 'exploring_roads':
          this.followRoads();
          break;
        case 'building':
          this.buildStructures();
          break;
        default:
          this.performMining();
      }

    } catch (error) {
      console.log('⚠ Activity error:', error.message);
    }
  }

  // Realistic food eating behavior
  eatFood() {
    if (!this.bot || !this.connected) return;

    try {
      // Look for food items in inventory
      const foodItems = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name.includes('bread') ||
          item.name.includes('apple') ||
          item.name.includes('carrot') ||
          item.name.includes('potato') ||
          item.name.includes('beef') ||
          item.name.includes('pork') ||
          item.name.includes('chicken') ||
          item.name.includes('fish') ||
          item.name.includes('cookie') ||
          item.name.includes('cake') ||
          item.name.includes('melon') ||
          item.name.includes('berry')
        );
      });

      if (foodItems.length > 0 && this.bot.food < 18) {
        const food = foodItems[Math.floor(Math.random() * foodItems.length)];
        
        console.log(`🍎 Bot is hungry (${this.bot.food}/20) - eating ${food.name}...`);
        
        this.bot.equip(food, 'hand')
          .then(() => {
            // Simulate realistic eating - hold right click
            this.bot.activateItem();
            
            setTimeout(() => {
              if (this.bot && this.connected) {
                this.bot.deactivateItem();
                console.log(`😋 Bot finished eating ${food.name}! Health: ${this.bot.health}/20, Food: ${this.bot.food}/20`);
              }
            }, 1500 + Math.random() * 1000); // Eat for 1.5-2.5 seconds
          })
          .catch(err => console.log('⚠ Eating failed:', err.message));
          
      } else if (foodItems.length === 0) {
        console.log('🔍 Bot looking for food sources...');
        this.searchForFood();
      } else {
        console.log(`😌 Bot is satisfied (Food: ${this.bot.food}/20)`);
      }

    } catch (error) {
      console.log('⚠ Eating error:', error.message);
    }
  }

  // Hunt animals like a real player
  huntAnimals() {
    if (!this.bot || !this.connected) return;

    try {
      // Look for animals within range
      const animals = Object.values(this.bot.entities).filter(entity => {
        return entity && entity.name && (
          entity.name === 'cow' ||
          entity.name === 'pig' ||
          entity.name === 'chicken' ||
          entity.name === 'sheep' ||
          entity.name === 'rabbit' ||
          entity.name === 'horse'
        ) && entity.position.distanceTo(this.bot.entity.position) < 16;
      });

      if (animals.length > 0) {
        const target = animals[Math.floor(Math.random() * animals.length)];
        console.log(`🏹 Bot spotted a ${target.name}! Starting hunt...`);

        // Equip weapon first
        const weapon = this.bot.inventory.items().find(item => 
          item && item.name && (
            item.name.includes('sword') || 
            item.name.includes('axe') ||
            item.name.includes('bow')
          )
        );

        if (weapon) {
          this.bot.equip(weapon, 'hand')
            .then(() => {
              console.log(`⚔️ Bot equipped ${weapon.name} for hunting`);
              return this.bot.lookAt(target.position);
            })
            .then(() => {
              // Move towards animal stealthily
              const path = this.bot.pathfinder?.getPathTo(target.position);
              if (path) {
                this.bot.pathfinder.setGoal(new this.bot.pathfinder.goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
                
                setTimeout(() => {
                  if (this.bot && this.connected && target.isValid) {
                    console.log(`💥 Bot attacking ${target.name}!`);
                    this.bot.attack(target);
                  }
                }, 2000 + Math.random() * 1500);
              }
            })
            .catch(err => console.log('⚠ Hunting failed:', err.message));
        } else {
          console.log('⚠ Bot has no weapon for hunting, using hands...');
          this.bot.lookAt(target.position);
          
          setTimeout(() => {
            if (this.bot && this.connected && target.isValid) {
              console.log(`👊 Bot attacking ${target.name} with bare hands!`);
              this.bot.attack(target);
            }
          }, 1000);
        }
      } else {
        console.log('🔍 Bot searching for animals to hunt...');
        // Look around for animals
        const randomYaw = Math.random() * Math.PI * 2;
        this.bot.look(randomYaw, -0.3); // Look slightly downward
      }

    } catch (error) {
      console.log('⚠ Hunting error:', error.message);
    }
  }

  // Comprehensive survival crafting system
  craftWeapons() {
    if (!this.bot || !this.connected) return;

    try {
      console.log('🛠️ Starting comprehensive survival crafting process...');
      
      // Step 1: Check if we have a crafting table
      const craftingTable = this.bot.findBlock({
        matching: this.bot.registry.blocksByName.crafting_table?.id,
        maxDistance: 10
      });

      if (craftingTable) {
        console.log('✅ Found crafting table! Proceeding with advanced crafting...');
        this.advancedCrafting(craftingTable);
      } else {
        console.log('❌ No crafting table found! Starting simplified survival sequence...');
        this.simplifiedSurvivalCrafting();
      }

    } catch (error) {
      console.log('⚠ Crafting system error:', error.message);
    }
  }

  // Simplified survival crafting that actually works
  async simplifiedSurvivalCrafting() {
    console.log('🌲 SIMPLIFIED SURVIVAL: Following correct Minecraft sequence...');
    
    try {
      // Step 1: Ensure we have logs
      let logs = this.bot.inventory.items().filter(item => 
        item && item.name && item.name.includes('log')
      );
      
      if (logs.length === 0 || logs.reduce((sum, log) => sum + log.count, 0) < 4) {
        console.log('🪓 Need more logs for crafting table. Collecting logs first...');
        await this.collectLogsForCrafting();
        
        // Recheck logs
        logs = this.bot.inventory.items().filter(item => 
          item && item.name && item.name.includes('log')
        );
      }
      
      if (logs.length > 0 && logs.reduce((sum, log) => sum + log.count, 0) >= 1) {
        console.log('✅ Have logs! Converting to planks using inventory crafting...');
        await this.inventoryCraftPlanks();
        
        // Wait and check planks
        setTimeout(async () => {
          const planks = this.bot.inventory.items().filter(item => 
            item && item.name && item.name.includes('planks')
          );
          const totalPlanks = planks.reduce((sum, plank) => sum + plank.count, 0);
          
          if (totalPlanks >= 4) {
            console.log(`✅ Have ${totalPlanks} planks! Making crafting table...`);
            await this.inventoryCraftCraftingTable();
            
            // Wait and then make sword
            setTimeout(() => {
              this.makeSwordSequence();
            }, 3000);
          } else {
            console.log(`❌ Only have ${totalPlanks} planks, need 4. Collecting more logs...`);
            this.collectLogsForCrafting();
          }
        }, 2000);
      }
      
    } catch (error) {
      console.log('⚠ Simplified crafting error:', error.message);
    }
  }

  // Focused log collection for crafting
  async collectLogsForCrafting() {
    console.log('🪓 FOCUSED LOG COLLECTION: Getting wood for crafting table...');
    
    try {
      // Find nearby trees - prioritize closer ones
      const trees = this.findNearbyTrees();
      
      if (trees.length > 0) {
        console.log(`🌳 Found ${trees.length} trees! Cutting systematically...`);
        
        // Cut trees one by one with better error handling
        for (let i = 0; i < Math.min(trees.length, 2); i++) {
          const treePos = trees[i];
          const treeBlock = this.bot.blockAt(treePos);
          
          if (treeBlock && treeBlock.name.includes('log')) {
            console.log(`🪓 Cutting tree ${i + 1}: ${treeBlock.name}`);
            
            try {
              // Move closer to tree first
              const distance = this.bot.entity.position.distanceTo(treePos);
              if (distance > 4) {
                await this.bot.pathfinder.goto(treePos.offset(0, 0, 1));
              }
              
              await this.bot.lookAt(treePos);
              await this.bot.dig(treeBlock, true); // Force digging
              console.log(`✅ Successfully cut ${treeBlock.name}!`);
              
              // Short break between cuts
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
              console.log(`⚠ Failed to cut tree ${i + 1}: ${error.message}`);
              // Try again if failed
              try {
                await this.bot.dig(treeBlock, false);
                console.log(`✅ Second attempt successful for ${treeBlock.name}!`);
              } catch (retryError) {
                console.log(`❌ Both attempts failed for tree ${i + 1}`);
              }
            }
          }
        }
        
        // Check what we collected
        const logs = this.bot.inventory.items().filter(item => 
          item && item.name && item.name.includes('log')
        );
        const totalLogs = logs.reduce((sum, log) => sum + log.count, 0);
        console.log(`📊 Total logs collected: ${totalLogs}`);
        
      } else {
        console.log('❌ No trees found! Bot will search wider area...');
      }
      
    } catch (error) {
      console.log('⚠ Log collection error:', error.message);
    }
  }

  // Craft planks using 2x2 inventory grid
  async inventoryCraftPlanks() {
    console.log('🪚 Converting logs to planks in inventory...');
    
    try {
      const logs = this.bot.inventory.items().filter(item => 
        item && item.name && item.name.includes('log')
      );
      
      for (const log of logs) {
        console.log(`🔨 Converting ${log.name} to planks...`);
        
        // Use recipesFor to find plank recipes
        const recipes = this.bot.recipesFor(log.type, null, 1, null);
        console.log(`🔍 Found ${recipes.length} recipes for ${log.name}`);
        
        if (recipes.length > 0) {
          const recipe = recipes[0]; // First recipe is usually planks
          const maxCraft = Math.min(log.count, 8); // Convert up to 8 logs
          
          try {
            await this.bot.craft(recipe, maxCraft);
            console.log(`✅ Crafted planks from ${maxCraft} ${log.name}!`);
          } catch (craftError) {
            console.log(`⚠ Crafting failed for ${log.name}:`, craftError.message);
          }
        }
        
        // Small delay between crafting operations
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (error) {
      console.log('⚠ Plank crafting error:', error.message);
    }
  }

  // Craft crafting table using 2x2 inventory grid
  async inventoryCraftCraftingTable() {
    console.log('🔨 Making crafting table in inventory...');
    
    try {
      const planks = this.bot.inventory.items().filter(item => 
        item && item.name && item.name.includes('planks')
      );
      
      if (planks.length > 0) {
        const totalPlanks = planks.reduce((sum, plank) => sum + plank.count, 0);
        
        if (totalPlanks >= 4) {
          console.log(`✅ Have ${totalPlanks} planks! Crafting table...`);
          
          // Find crafting table recipes using any plank type
          const plankType = planks[0].type;
          const recipes = this.bot.recipesFor(plankType, null, 1, null);
          
          // Look for crafting table recipe
          const craftingTableRecipe = recipes.find(recipe => 
            recipe.result && recipe.result.name === 'crafting_table'
          );
          
          if (craftingTableRecipe) {
            await this.bot.craft(craftingTableRecipe, 1);
            console.log('✅ Successfully crafted crafting table!');
            
            // Place it immediately
            setTimeout(() => {
              this.placeCraftingTableAndMakeTools();
            }, 1000);
          } else {
            console.log('❌ Crafting table recipe not found');
          }
        } else {
          console.log(`❌ Not enough planks: ${totalPlanks}/4`);
        }
      }
      
    } catch (error) {
      console.log('⚠ Crafting table creation error:', error.message);
    }
  }

  // Place crafting table and make sword
  async placeCraftingTableAndMakeTools() {
    console.log('📦 Placing crafting table and making tools...');
    
    try {
      const craftingTableItem = this.bot.inventory.items().find(item => 
        item && item.name === 'crafting_table'
      );
      
      if (craftingTableItem) {
        await this.bot.equip(craftingTableItem, 'hand');
        
        // Find suitable ground position
        const botPos = this.bot.entity.position;
        const groundPos = botPos.offset(1, -1, 0);
        const groundBlock = this.bot.blockAt(groundPos);
        
        if (groundBlock && groundBlock.name !== 'air') {
          const placePos = groundPos.offset(0, 1, 0);
          await this.bot.placeBlock(groundBlock, placePos);
          console.log('✅ Crafting table placed!');
          
          // Now make sword with the placed table
          setTimeout(() => {
            this.makeSwordWithCraftingTable();
          }, 2000);
        }
      }
      
    } catch (error) {
      console.log('⚠ Placement error:', error.message);
    }
  }

  // Make sword using placed crafting table
  async makeSwordWithCraftingTable() {
    console.log('⚔️ Making wooden sword at crafting table...');
    
    try {
      const craftingTable = this.bot.findBlock({
        matching: this.bot.registry.blocksByName.crafting_table?.id,
        maxDistance: 5
      });
      
      if (craftingTable) {
        console.log('🔨 Found crafting table! Making sword...');
        
        // First make sticks
        const planks = this.bot.inventory.items().find(item => 
          item && item.name && item.name.includes('planks')
        );
        
        if (planks && planks.count >= 4) {
          // Make sticks first
          const stickRecipes = this.bot.recipesFor(planks.type, craftingTable, 1, null);
          const stickRecipe = stickRecipes.find(recipe => 
            recipe.result && recipe.result.name === 'stick'
          );
          
          if (stickRecipe) {
            await this.bot.craft(stickRecipe, 4, craftingTable); // Make 4 sticks
            console.log('✅ Made sticks!');
            
            // Now make wooden sword
            setTimeout(async () => {
              const swordRecipes = this.bot.recipesFor(planks.type, craftingTable, 1, null);
              const swordRecipe = swordRecipes.find(recipe => 
                recipe.result && recipe.result.name === 'wooden_sword'
              );
              
              if (swordRecipe) {
                await this.bot.craft(swordRecipe, 1, craftingTable);
                console.log('⚔️ Successfully crafted wooden sword!');
                
                // Equip sword
                const sword = this.bot.inventory.items().find(item => 
                  item && item.name === 'wooden_sword'
                );
                if (sword) {
                  await this.bot.equip(sword, 'hand');
                  console.log('⚔️ Sword equipped! Ready for combat and hunting!');
                }
              }
            }, 1000);
          }
        }
      }
      
    } catch (error) {
      console.log('⚠ Sword making error:', error.message);
    }
  }

  // Complete survival sequence: Tree -> Planks -> Crafting Table -> Tools -> Combat
  async startSurvivalSequence() {
    console.log('🌲 SURVIVAL MODE: Starting from scratch...');
    
    try {
      // Step 1: Cut trees for wood
      await this.cutTreesForWood();
      
      // Step 2: Make planks from wood
      setTimeout(() => {
        this.makeWoodPlanks();
      }, 2000);
      
      // Step 3: Create crafting table
      setTimeout(() => {
        this.createCraftingTable();
      }, 4000);
      
      // Step 4: Make basic tools
      setTimeout(() => {
        this.makeBasicTools();
      }, 6000);
      
      // Step 5: Start combat activities
      setTimeout(() => {
        this.startCombatActivities();
      }, 8000);
      
    } catch (error) {
      console.log('⚠ Survival sequence error:', error.message);
    }
  }

  // Step 1: Cut trees systematically
  async cutTreesForWood() {
    console.log('🪓 Phase 1: Cutting trees for wood...');
    
    try {
      // Look for trees (oak, birch, spruce, etc.)
      const trees = this.bot.findBlocks({
        matching: (block) => {
          return block && block.name && (
            block.name.includes('log') ||
            block.name.includes('wood') ||
            block.name === 'oak_log' ||
            block.name === 'birch_log' ||
            block.name === 'spruce_log' ||
            block.name === 'jungle_log' ||
            block.name === 'dark_oak_log' ||
            block.name === 'acacia_log'
          );
        },
        maxDistance: 20,
        count: 5
      });

      if (trees.length > 0) {
        console.log(`🌳 Found ${trees.length} trees! Starting systematic cutting...`);
        
        // Cut multiple trees
        for (let i = 0; i < Math.min(trees.length, 3); i++) {
          const treePos = trees[i];
          const treeBlock = this.bot.blockAt(treePos);
          
          if (treeBlock) {
            console.log(`🪓 Cutting tree ${i + 1}/3: ${treeBlock.name}`);
            this.bot.lookAt(treePos);
            
            try {
              await this.bot.dig(treeBlock);
              console.log(`✅ Successfully cut ${treeBlock.name}!`);
              
              // Wait between cuts
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (error) {
              console.log(`⚠ Failed to cut tree ${i + 1}:`, error.message);
            }
          }
        }
        
        // Check wood inventory
        const woodCount = this.countWoodInInventory();
        console.log(`📊 Total wood collected: ${woodCount} pieces`);
        
      } else {
        console.log('❌ No trees found nearby! Bot will search wider area...');
        this.searchForDistantTrees();
      }
      
    } catch (error) {
      console.log('⚠ Tree cutting error:', error.message);
    }
  }

  // Step 2: Convert logs to planks
  makeWoodPlanks() {
    console.log('🪚 Phase 2: Converting wood to planks...');
    
    try {
      // Find wood logs in inventory
      const woodLogs = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name.includes('log') ||
          item.name.includes('wood')
        );
      });

      if (woodLogs.length > 0) {
        console.log(`🪵 Found ${woodLogs.length} types of wood logs`);
        
        // Use simplified crafting approach - direct recipe lookup
        woodLogs.forEach((log, index) => {
          setTimeout(() => {
            if (this.bot && this.connected && this.bot.mcData) {
              try {
                // Map log names to plank names correctly
                let plankType;
                if (log.name.includes('oak')) {
                  plankType = 'oak_planks';
                } else if (log.name.includes('birch')) {
                  plankType = 'birch_planks';
                } else if (log.name.includes('spruce')) {
                  plankType = 'spruce_planks';
                } else if (log.name.includes('jungle')) {
                  plankType = 'jungle_planks';
                } else if (log.name.includes('acacia')) {
                  plankType = 'acacia_planks';
                } else if (log.name.includes('dark_oak')) {
                  plankType = 'dark_oak_planks';
                } else {
                  plankType = log.name.replace('_log', '_planks').replace('_wood', '_planks');
                }
                
                console.log(`🔨 Converting ${log.name} to ${plankType}...`);
                
                // Always use the simple crafting method since mcData is unreliable
                console.log(`⚡ Using direct recipe lookup for ${log.name}...`);
                this.simpleCraftPlanks(log);
              } catch (error) {
                console.log(`⚠ Plank conversion error for ${log.name}:`, error.message);
                this.simpleCraftPlanks(log);
              }
            }
          }, index * 1500); // Longer delay between attempts
        });
        
      } else {
        console.log('❌ No wood logs found! Need to cut more trees...');
        this.cutTreesForWood();
      }
      
    } catch (error) {
      console.log('⚠ Plank making error:', error.message);
    }
  }

  // Simple crafting method for planks (fallback)
  simpleCraftPlanks(log) {
    console.log(`🔨 Trying simple craft for ${log.name}...`);
    
    try {
      // Use recipesFor to find plank recipes for this log
      const recipes = this.bot.recipesFor(log.type, null, 1, null);
      console.log(`🔍 Found ${recipes.length} recipes for ${log.name}`);
      
      if (recipes.length > 0) {
        // Use the first available recipe (usually planks)
        const recipe = recipes[0];
        this.bot.craft(recipe, Math.min(log.count, 4))
          .then(() => {
            console.log(`✅ Simple craft successful! Made ${recipe.result.count} ${recipe.result.name}!`);
            setTimeout(() => {
              this.checkAndCreateCraftingTable();
            }, 1000);
          })
          .catch(err => {
            console.log(`⚠ Simple craft failed:`, err.message);
          });
      } else {
        console.log(`❌ No recipes found for ${log.name}`);
      }
    } catch (error) {
      console.log(`⚠ Simple craft error:`, error.message);
    }
  }

  // Check planks and create crafting table if ready
  checkAndCreateCraftingTable() {
    const planks = this.bot.inventory.items().filter(item => {
      return item && item.name && item.name.includes('planks');
    });
    
    const totalPlanks = planks.reduce((sum, item) => sum + item.count, 0);
    console.log(`📊 Total planks available: ${totalPlanks}`);
    
    if (totalPlanks >= 4) {
      console.log('✅ Enough planks available! Creating crafting table...');
      this.createCraftingTable();
    } else {
      console.log(`❌ Need more planks (${totalPlanks}/4)`);
    }
  }

  // Step 3: Create crafting table
  createCraftingTable() {
    console.log('🔨 Phase 3: Creating crafting table...');
    
    try {
      // Check if we have planks
      const planks = this.bot.inventory.items().filter(item => {
        return item && item.name && item.name.includes('planks');
      });

      if (planks.length > 0 && planks[0].count >= 4) {
        console.log('✅ Sufficient planks found! Crafting table...');
        
        const craftingTableRecipe = this.bot.mcData.recipesByName['crafting_table'];
        if (craftingTableRecipe) {
          this.bot.craft(craftingTableRecipe, 1)
            .then(() => {
              console.log('✅ Successfully crafted crafting table!');
              
              // Place the crafting table
              setTimeout(() => {
                this.placeCraftingTable();
              }, 1000);
            })
            .catch(err => {
              console.log('⚠ Crafting table creation failed:', err.message);
            });
        } else {
          console.log('⚠ Crafting table recipe not found');
        }
        
      } else {
        console.log('❌ Not enough planks! Need at least 4 planks for crafting table');
        console.log(`Current planks: ${planks.length > 0 ? planks[0].count : 0}`);
      }
      
    } catch (error) {
      console.log('⚠ Crafting table creation error:', error.message);
    }
  }

  // Place crafting table on ground
  async placeCraftingTable() {
    console.log('📦 Phase 3.5: Placing crafting table...');
    
    try {
      // Find crafting table in inventory
      const craftingTableItem = this.bot.inventory.items().find(item => 
        item && item.name === 'crafting_table'
      );

      if (craftingTableItem) {
        console.log('🔨 Placing crafting table near bot...');
        
        await this.bot.equip(craftingTableItem, 'hand');
        
        // Find suitable ground position
        const botPos = this.bot.entity.position;
        const placePos = botPos.offset(2, 0, 0); // 2 blocks in front
        const groundBlock = this.bot.blockAt(placePos.offset(0, -1, 0));
        
        if (groundBlock && groundBlock.name !== 'air') {
          await this.bot.placeBlock(groundBlock, placePos);
          console.log('✅ Crafting table placed successfully!');
          
          // Wait and then start tool creation
          setTimeout(() => {
            this.makeBasicTools();
          }, 2000);
        } else {
          console.log('⚠ No suitable ground found for placing crafting table');
        }
        
      } else {
        console.log('❌ Crafting table not found in inventory');
      }
      
    } catch (error) {
      console.log('⚠ Crafting table placement error:', error.message);
    }
  }

  // Step 4: Make basic tools (sticks, sword, axe)
  makeBasicTools() {
    console.log('⚔️ Phase 4: Creating basic survival tools...');
    
    try {
      // Find our crafting table
      const craftingTable = this.bot.findBlock({
        matching: this.bot.registry.blocksByName.crafting_table?.id,
        maxDistance: 5
      });

      if (craftingTable) {
        console.log('🔨 Found crafting table! Making tools...');
        
        // Sequence: Sticks -> Sword -> Axe -> Pickaxe
        this.makeSticks(craftingTable);
        
        setTimeout(() => {
          this.makeWoodenSword(craftingTable);
        }, 2000);
        
        setTimeout(() => {
          this.makeWoodenAxe(craftingTable);
        }, 4000);
        
        setTimeout(() => {
          this.makeWoodenPickaxe(craftingTable);
        }, 6000);
        
      } else {
        console.log('❌ Crafting table not found! Creating one first...');
        this.createCraftingTable();
      }
      
    } catch (error) {
      console.log('⚠ Tool making error:', error.message);
    }
  }

  // Make sticks from planks
  makeSticks(craftingTable) {
    console.log('🪵 Making sticks...');
    
    try {
      const planks = this.bot.inventory.items().find(item => 
        item && item.name && item.name.includes('planks')
      );

      if (planks && planks.count >= 2) {
        const stickRecipe = this.bot.mcData.recipesByName['stick'];
        if (stickRecipe) {
          this.bot.craft(stickRecipe, 8, craftingTable) // Make 8 sticks
            .then(() => {
              console.log('✅ Successfully made sticks!');
            })
            .catch(err => {
              console.log('⚠ Stick making failed:', err.message);
            });
        }
      } else {
        console.log('❌ Not enough planks for sticks');
      }
    } catch (error) {
      console.log('⚠ Stick making error:', error.message);
    }
  }

  // Make wooden sword
  makeWoodenSword(craftingTable) {
    console.log('⚔️ Making wooden sword...');
    
    try {
      const planks = this.bot.inventory.items().find(item => 
        item && item.name && item.name.includes('planks')
      );
      const sticks = this.bot.inventory.items().find(item => 
        item && item.name === 'stick'
      );

      if (planks && planks.count >= 2 && sticks && sticks.count >= 1) {
        const swordRecipe = this.bot.mcData.recipesByName['wooden_sword'];
        if (swordRecipe) {
          this.bot.craft(swordRecipe, 1, craftingTable)
            .then(() => {
              console.log('⚔️ Successfully crafted wooden sword!');
              // Equip the sword immediately
              const sword = this.bot.inventory.items().find(item => 
                item && item.name === 'wooden_sword'
              );
              if (sword) {
                this.bot.equip(sword, 'hand');
                console.log('💪 Equipped wooden sword for combat!');
              }
            })
            .catch(err => {
              console.log('⚠ Sword crafting failed:', err.message);
            });
        }
      } else {
        console.log(`❌ Insufficient materials for sword - Planks: ${planks?.count || 0}, Sticks: ${sticks?.count || 0}`);
      }
    } catch (error) {
      console.log('⚠ Sword making error:', error.message);
    }
  }

  // Make wooden axe
  makeWoodenAxe(craftingTable) {
    console.log('🪓 Making wooden axe...');
    
    try {
      const planks = this.bot.inventory.items().find(item => 
        item && item.name && item.name.includes('planks')
      );
      const sticks = this.bot.inventory.items().find(item => 
        item && item.name === 'stick'
      );

      if (planks && planks.count >= 3 && sticks && sticks.count >= 2) {
        const axeRecipe = this.bot.mcData.recipesByName['wooden_axe'];
        if (axeRecipe) {
          this.bot.craft(axeRecipe, 1, craftingTable)
            .then(() => {
              console.log('🪓 Successfully crafted wooden axe!');
            })
            .catch(err => {
              console.log('⚠ Axe crafting failed:', err.message);
            });
        }
      } else {
        console.log(`❌ Insufficient materials for axe - Planks: ${planks?.count || 0}, Sticks: ${sticks?.count || 0}`);
      }
    } catch (error) {
      console.log('⚠ Axe making error:', error.message);
    }
  }

  // Make wooden pickaxe
  makeWoodenPickaxe(craftingTable) {
    console.log('⛏️ Making wooden pickaxe...');
    
    try {
      const planks = this.bot.inventory.items().find(item => 
        item && item.name && item.name.includes('planks')
      );
      const sticks = this.bot.inventory.items().find(item => 
        item && item.name === 'stick'
      );

      if (planks && planks.count >= 3 && sticks && sticks.count >= 2) {
        const pickaxeRecipe = this.bot.mcData.recipesByName['wooden_pickaxe'];
        if (pickaxeRecipe) {
          this.bot.craft(pickaxeRecipe, 1, craftingTable)
            .then(() => {
              console.log('⛏️ Successfully crafted wooden pickaxe!');
            })
            .catch(err => {
              console.log('⚠ Pickaxe crafting failed:', err.message);
            });
        }
      } else {
        console.log(`❌ Insufficient materials for pickaxe - Planks: ${planks?.count || 0}, Sticks: ${sticks?.count || 0}`);
      }
    } catch (error) {
      console.log('⚠ Pickaxe making error:', error.message);
    }
  }

  // Step 5: Start combat activities
  startCombatActivities() {
    console.log('⚔️ Phase 5: Starting combat and food gathering...');
    
    try {
      // Check if we have weapons
      const sword = this.bot.inventory.items().find(item => 
        item && item.name && item.name.includes('sword')
      );

      if (sword) {
        console.log(`💪 Armed with ${sword.name}! Starting combat activities...`);
        
        // Equip weapon
        this.bot.equip(sword, 'hand');
        
        // Start hunting sequence
        setTimeout(() => {
          this.huntAnimalsForFood();
        }, 1000);
        
        // Start zombie/monster hunting
        setTimeout(() => {
          this.huntHostileMobs();
        }, 5000);
        
      } else {
        console.log('❌ No weapon available! Making sword first...');
        this.makeBasicTools();
      }
      
    } catch (error) {
      console.log('⚠ Combat startup error:', error.message);
    }
  }

  // Enhanced animal hunting for food
  huntAnimalsForFood() {
    if (!this.bot || !this.connected) return;

    try {
      console.log('🍖 Hunting animals for food with proper weapon...');
      
      // Look for food animals
      const foodAnimals = Object.values(this.bot.entities).filter(entity => {
        return entity && entity.name && (
          entity.name === 'cow' ||
          entity.name === 'pig' ||
          entity.name === 'chicken' ||
          entity.name === 'sheep' ||
          entity.name === 'rabbit'
        ) && entity.position.distanceTo(this.bot.entity.position) < 20;
      });

      if (foodAnimals.length > 0) {
        const target = foodAnimals[Math.floor(Math.random() * foodAnimals.length)];
        console.log(`🎯 Target acquired: ${target.name}! Distance: ${Math.round(target.position.distanceTo(this.bot.entity.position))} blocks`);

        // Make sure sword is equipped
        const sword = this.bot.inventory.items().find(item => 
          item && item.name && item.name.includes('sword')
        );

        if (sword) {
          this.bot.equip(sword, 'hand')
            .then(() => {
              console.log(`⚔️ Equipped ${sword.name} for hunting!`);
              return this.bot.lookAt(target.position.plus({ x: 0, y: target.height / 2, z: 0 }));
            })
            .then(() => {
              // Move closer if needed
              if (target.position.distanceTo(this.bot.entity.position) > 3) {
                console.log(`🏃 Moving closer to ${target.name}...`);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                
                setTimeout(() => {
                  if (this.bot && this.connected) {
                    this.bot.clearControlStates();
                    this.attackTarget(target);
                  }
                }, 2000);
              } else {
                this.attackTarget(target);
              }
            })
            .catch(err => console.log('⚠ Hunting preparation failed:', err.message));
        } else {
          console.log('❌ No sword available for hunting!');
        }
      } else {
        console.log('🔍 No food animals found nearby, searching wider area...');
      }

    } catch (error) {
      console.log('⚠ Food hunting error:', error.message);
    }
  }

  // Hunt hostile mobs (zombies, skeletons, etc.)
  huntHostileMobs() {
    if (!this.bot || !this.connected) return;

    try {
      console.log('🧟 Hunting hostile mobs for safety and loot...');
      
      // Look for hostile mobs
      const hostileMobs = Object.values(this.bot.entities).filter(entity => {
        return entity && entity.name && (
          entity.name === 'zombie' ||
          entity.name === 'skeleton' ||
          entity.name === 'spider' ||
          entity.name === 'creeper' ||
          entity.name === 'enderman' ||
          entity.name === 'witch'
        ) && entity.position.distanceTo(this.bot.entity.position) < 16;
      });

      if (hostileMobs.length > 0) {
        const target = hostileMobs[0]; // Attack closest threat
        console.log(`⚔️ Hostile mob detected: ${target.name}! Engaging in combat!`);

        // Make sure sword is equipped
        const sword = this.bot.inventory.items().find(item => 
          item && item.name && item.name.includes('sword')
        );

        if (sword) {
          this.bot.equip(sword, 'hand')
            .then(() => {
              console.log(`🛡️ Ready for combat with ${sword.name}!`);
              return this.bot.lookAt(target.position.plus({ x: 0, y: target.height / 2, z: 0 }));
            })
            .then(() => {
              // Strategic approach - don't rush blindly
              console.log(`🎯 Engaging ${target.name} strategically...`);
              this.strategicCombat(target);
            })
            .catch(err => console.log('⚠ Combat preparation failed:', err.message));
        } else {
          console.log('❌ No weapon! Avoiding hostile mob...');
          // Run away if no weapon
          this.bot.setControlState('back', true);
          this.bot.setControlState('sprint', true);
          setTimeout(() => {
            if (this.bot && this.connected) {
              this.bot.clearControlStates();
            }
          }, 3000);
        }
      } else {
        console.log('✅ No hostile mobs nearby - area is safe');
      }

    } catch (error) {
      console.log('⚠ Hostile mob hunting error:', error.message);
    }
  }

  // Strategic combat approach
  strategicCombat(target) {
    try {
      const distance = target.position.distanceTo(this.bot.entity.position);
      
      if (distance > 3) {
        // Move closer
        console.log('🏃 Closing distance for combat...');
        this.bot.setControlState('forward', true);
        
        setTimeout(() => {
          if (this.bot && this.connected && target.isValid) {
            this.bot.clearControlStates();
            this.attackTarget(target);
          }
        }, 1500);
      } else {
        // Attack immediately
        this.attackTarget(target);
      }
      
    } catch (error) {
      console.log('⚠ Strategic combat error:', error.message);
    }
  }

  // Enhanced attack function
  attackTarget(target) {
    try {
      if (!target.isValid) {
        console.log('⚠ Target is no longer valid');
        return;
      }

      console.log(`💥 Attacking ${target.name}!`);
      
      // Look at target and attack
      this.bot.lookAt(target.position.plus({ x: 0, y: target.height / 2, z: 0 }))
        .then(() => {
          // Multiple attacks for better success
          for (let i = 0; i < 3; i++) {
            setTimeout(() => {
              if (this.bot && this.connected && target.isValid) {
                this.bot.attack(target);
                console.log(`⚔️ Attack ${i + 1}/3 on ${target.name}!`);
              }
            }, i * 500);
          }
        })
        .catch(err => console.log('⚠ Attack failed:', err.message));

      // Check results after combat
      setTimeout(() => {
        this.checkCombatResults(target);
      }, 2000);
      
    } catch (error) {
      console.log('⚠ Attack error:', error.message);
    }
  }

  // Check combat results and eat food if available
  checkCombatResults(target) {
    try {
      if (!target.isValid) {
        console.log('✅ Target eliminated successfully!');
        
        // Look for dropped food items
        setTimeout(() => {
          this.collectNearbyItems();
        }, 1000);
        
        // Check if we need to eat
        if (this.bot.food < 15) {
          setTimeout(() => {
            console.log('🍖 Combat made bot hungry, looking for food...');
            this.eatFood();
          }, 2000);
        }
      } else {
        console.log('⚠ Target still alive, continuing combat...');
        // Continue attacking if target survives
        setTimeout(() => {
          this.attackTarget(target);
        }, 1000);
      }
      
    } catch (error) {
      console.log('⚠ Combat results check error:', error.message);
    }
  }

  // Collect nearby dropped items
  collectNearbyItems() {
    try {
      const nearbyItems = Object.values(this.bot.entities).filter(entity => {
        return entity && entity.name === 'item' && 
               entity.position.distanceTo(this.bot.entity.position) < 5;
      });

      if (nearbyItems.length > 0) {
        console.log(`📦 Found ${nearbyItems.length} dropped items nearby!`);
        
        nearbyItems.forEach((item, index) => {
          setTimeout(() => {
            if (this.bot && this.connected && item.isValid) {
              console.log('🏃 Moving to collect dropped item...');
              this.bot.lookAt(item.position);
              this.bot.setControlState('forward', true);
              
              setTimeout(() => {
                if (this.bot && this.connected) {
                  this.bot.clearControlStates();
                  console.log('✅ Item collected!');
                }
              }, 1000);
            }
          }, index * 1500);
        });
      }
      
    } catch (error) {
      console.log('⚠ Item collection error:', error.message);
    }
  }

  // Helper functions
  countWoodInInventory() {
    try {
      const woodItems = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name.includes('log') ||
          item.name.includes('wood')
        );
      });
      
      return woodItems.reduce((total, item) => total + item.count, 0);
    } catch (error) {
      console.log('⚠ Wood count error:', error.message);
      return 0;
    }
  }

  searchForDistantTrees() {
    console.log('🔍 Searching for trees in wider area...');
    
    try {
      // Move in random direction to find trees
      const directions = [0, Math.PI/2, Math.PI, 3*Math.PI/2];
      const direction = directions[Math.floor(Math.random() * directions.length)];
      
      this.bot.look(direction, 0);
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);
      
      console.log('🚶 Bot exploring for trees...');
      
      setTimeout(() => {
        if (this.bot && this.connected) {
          this.bot.clearControlStates();
          // Try again after moving
          this.cutTreesForWood();
        }
      }, 5000);
      
    } catch (error) {
      console.log('⚠ Tree search error:', error.message);
    }
  }

  // Advanced crafting with existing crafting table
  advancedCrafting(craftingTable) {
    console.log('🏭 Advanced crafting with existing crafting table...');
    
    try {
      // Check what we can craft
      const inventory = this.bot.inventory.items();
      const hasSticks = inventory.some(item => item.name === 'stick');
      const hasPlanks = inventory.some(item => item.name && item.name.includes('planks'));
      const hasStone = inventory.some(item => item.name === 'cobblestone');
      const hasIron = inventory.some(item => item.name === 'iron_ingot');

      console.log(`📋 Crafting materials available:`);
      console.log(`   Sticks: ${hasSticks ? '✅' : '❌'}`);
      console.log(`   Planks: ${hasPlanks ? '✅' : '❌'}`);
      console.log(`   Stone: ${hasStone ? '✅' : '❌'}`);
      console.log(`   Iron: ${hasIron ? '✅' : '❌'}`);

      if (hasIron && hasSticks) {
        console.log('🔨 Crafting iron tools - highest priority!');
        this.craftIronTools(craftingTable);
      } else if (hasStone && hasSticks) {
        console.log('🔨 Crafting stone tools - good upgrade!');
        this.craftStoneTools(craftingTable);
      } else if (hasPlanks && hasSticks) {
        console.log('🔨 Crafting wooden tools - basic survival!');
        this.makeWoodenSword(craftingTable);
      } else {
        console.log('❌ Insufficient materials - starting resource gathering...');
        this.startSurvivalSequence();
      }
      
    } catch (error) {
      console.log('⚠ Advanced crafting error:', error.message);
    }
  }

  craftIronTools(craftingTable) {
    console.log('⚒️ Crafting iron tools...');
    
    const ironTools = ['iron_sword', 'iron_axe', 'iron_pickaxe'];
    
    ironTools.forEach((tool, index) => {
      setTimeout(() => {
        if (this.bot && this.connected) {
          const recipe = this.bot.mcData.recipesByName[tool];
          if (recipe) {
            this.bot.craft(recipe, 1, craftingTable)
              .then(() => {
                console.log(`⚒️ Successfully crafted ${tool}!`);
                if (tool.includes('sword')) {
                  // Equip sword immediately
                  const sword = this.bot.inventory.items().find(item => item.name === tool);
                  if (sword) this.bot.equip(sword, 'hand');
                }
              })
              .catch(err => console.log(`⚠ ${tool} crafting failed:`, err.message));
          }
        }
      }, index * 2000);
    });
  }

  craftStoneTools(craftingTable) {
    console.log('🗿 Crafting stone tools...');
    
    const stoneTools = ['stone_sword', 'stone_axe', 'stone_pickaxe'];
    
    stoneTools.forEach((tool, index) => {
      setTimeout(() => {
        if (this.bot && this.connected) {
          const recipe = this.bot.mcData.recipesByName[tool];
          if (recipe) {
            this.bot.craft(recipe, 1, craftingTable)
              .then(() => {
                console.log(`🗿 Successfully crafted ${tool}!`);
                if (tool.includes('sword')) {
                  // Equip sword immediately
                  const sword = this.bot.inventory.items().find(item => item.name === tool);
                  if (sword) this.bot.equip(sword, 'hand');
                }
              })
              .catch(err => console.log(`⚠ ${tool} crafting failed:`, err.message));
          }
        }
      }, index * 2000);
    });
  }

  // Follow roads and paths like a real explorer
  followRoads() {
    if (!this.bot || !this.connected) return;

    try {
      console.log('🛣️ Bot exploring roads and paths...');
      
      // Look for path blocks or structured areas
      const pathBlocks = this.bot.findBlocks({
        matching: (block) => {
          return block && block.name && (
            block.name.includes('path') ||
            block.name.includes('road') ||
            block.name.includes('stone_brick') ||
            block.name.includes('cobblestone') ||
            block.name === 'gravel'
          );
        },
        maxDistance: 20,
        count: 15
      });

      if (pathBlocks.length > 0) {
        // Follow the path
        const targetPath = pathBlocks[Math.floor(Math.random() * pathBlocks.length)];
        console.log(`🚶 Bot following path to: ${targetPath}`);
        
        // Walk along the path
        this.bot.lookAt(targetPath);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        
        // Sometimes jump while walking on roads (realistic player behavior)
        if (Math.random() < 0.4) {
          setTimeout(() => {
            if (this.bot && this.connected) {
              this.bot.setControlState('jump', true);
              console.log('🦘 Bot jumping while exploring road');
              
              setTimeout(() => {
                if (this.bot && this.connected) {
                  this.bot.setControlState('jump', false);
                }
              }, 300);
            }
          }, 500 + Math.random() * 1000);
        }

        // Stop after some time
        setTimeout(() => {
          if (this.bot && this.connected) {
            this.bot.clearControlStates();
            console.log('🛑 Bot stopped road exploration');
          }
        }, 3000 + Math.random() * 4000);
        
      } else {
        console.log('🏗️ No roads found, bot creating its own path...');
        this.createPath();
      }

    } catch (error) {
      console.log('⚠ Road exploration error:', error.message);
    }
  }

  // Build structures like houses, bridges
  buildStructures() {
    if (!this.bot || !this.connected) return;

    try {
      console.log('🏗️ Bot starting construction project...');
      
      const buildingMaterials = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name.includes('wood') ||
          item.name.includes('stone') ||
          item.name.includes('brick') ||
          item.name.includes('cobblestone') ||
          item.name === 'dirt'
        );
      });

      if (buildingMaterials.length > 0) {
        const material = buildingMaterials[Math.floor(Math.random() * buildingMaterials.length)];
        console.log(`🧱 Bot building with ${material.name}...`);
        
        // Build a small structure (like a pillar or wall)
        const startPos = this.bot.entity.position.offset(2, 0, 0);
        
        this.bot.equip(material, 'hand')
          .then(() => {
            // Build upward (pillar)
            for (let y = 0; y < 3; y++) {
              setTimeout(() => {
                if (this.bot && this.connected) {
                  const targetPos = startPos.offset(0, y, 0);
                  const referenceBlock = this.bot.blockAt(targetPos.offset(0, -1, 0));
                  
                  if (referenceBlock && referenceBlock.name !== 'air') {
                    this.bot.lookAt(targetPos);
                    this.bot.placeBlock(referenceBlock, targetPos)
                      .then(() => {
                        console.log(`🏗️ Bot placed block at level ${y + 1}`);
                      })
                      .catch(err => {
                        console.log(`⚠ Building failed at level ${y + 1}:`, err.message);
                      });
                  }
                }
              }, y * 1500); // 1.5 second delay between blocks
            }
          })
          .catch(err => console.log('⚠ Building preparation failed:', err.message));
          
      } else {
        console.log('🔍 Bot searching for building materials...');
        this.gatherBuildingMaterials();
      }

    } catch (error) {
      console.log('⚠ Building error:', error.message);
    }
  }

  // Helper methods for new features
  searchForFood() {
    try {
      // Look for food sources in the world
      const foodBlocks = this.bot.findBlocks({
        matching: (block) => {
          return block && block.name && (
            block.name.includes('wheat') ||
            block.name.includes('carrot') ||
            block.name.includes('potato') ||
            block.name.includes('beetroot') ||
            block.name.includes('berry')
          );
        },
        maxDistance: 15,
        count: 5
      });

      if (foodBlocks.length > 0) {
        const foodSource = foodBlocks[0];
        console.log(`🌾 Bot found food source: ${this.bot.blockAt(foodSource).name}`);
        this.bot.lookAt(foodSource);
        
        // Move towards food source
        this.bot.setControlState('forward', true);
        
        setTimeout(() => {
          if (this.bot && this.connected) {
            this.bot.clearControlStates();
            // Try to harvest
            this.bot.dig(this.bot.blockAt(foodSource))
              .then(() => console.log('🌾 Bot harvested food!'))
              .catch(err => console.log('⚠ Harvesting failed:', err.message));
          }
        }, 2000);
      }
    } catch (error) {
      console.log('⚠ Food search error:', error.message);
    }
  }

  searchForCraftingMaterials() {
    try {
      // Look for wood, stone, etc.
      const materialBlocks = this.bot.findBlocks({
        matching: (block) => {
          return block && block.name && (
            block.name.includes('log') ||
            block.name.includes('wood') ||
            block.name === 'stone' ||
            block.name === 'cobblestone'
          );
        },
        maxDistance: 10,
        count: 3
      });

      if (materialBlocks.length > 0) {
        const target = materialBlocks[0];
        console.log(`⛏️ Bot gathering materials: ${this.bot.blockAt(target).name}`);
        
        this.bot.lookAt(target);
        this.bot.dig(this.bot.blockAt(target))
          .then(() => console.log('✅ Bot gathered crafting materials!'))
          .catch(err => console.log('⚠ Material gathering failed:', err.message));
      }
    } catch (error) {
      console.log('⚠ Material search error:', error.message);
    }
  }

  createPath() {
    try {
      console.log('🛤️ Bot creating its own path...');
      
      const pathMaterial = this.bot.inventory.items().find(item => 
        item && item.name && (
          item.name === 'cobblestone' ||
          item.name === 'stone' ||
          item.name === 'gravel'
        )
      );

      if (pathMaterial) {
        this.bot.equip(pathMaterial, 'hand')
          .then(() => {
            // Create a small path forward
            for (let i = 1; i <= 5; i++) {
              setTimeout(() => {
                if (this.bot && this.connected) {
                  const pathPos = this.bot.entity.position.offset(i, -1, 0);
                  const referenceBlock = this.bot.blockAt(pathPos.offset(0, -1, 0));
                  
                  if (referenceBlock) {
                    this.bot.placeBlock(referenceBlock, pathPos)
                      .then(() => console.log(`🛤️ Bot placed path block ${i}/5`))
                      .catch(err => console.log(`⚠ Path creation failed: ${err.message}`));
                  }
                }
              }, i * 800);
            }
          })
          .catch(err => console.log('⚠ Path creation setup failed:', err.message));
      }
    } catch (error) {
      console.log('⚠ Path creation error:', error.message);
    }
  }

  gatherBuildingMaterials() {
    try {
      console.log('🪓 Bot gathering building materials...');
      
      // Look for trees to chop
      const trees = this.bot.findBlocks({
        matching: (block) => {
          return block && block.name && block.name.includes('log');
        },
        maxDistance: 15,
        count: 3
      });

      if (trees.length > 0) {
        const tree = trees[0];
        console.log('🌳 Bot found tree to chop for building materials');
        
        this.bot.lookAt(tree);
        
        // Equip axe if available
        const axe = this.bot.inventory.items().find(item => 
          item && item.name && item.name.includes('axe')
        );
        
        if (axe) {
          this.bot.equip(axe, 'hand')
            .then(() => {
              return this.bot.dig(this.bot.blockAt(tree));
            })
            .then(() => {
              console.log('🪵 Bot chopped tree for building materials!');
            })
            .catch(err => console.log('⚠ Tree chopping failed:', err.message));
        } else {
          // Use hands if no axe
          this.bot.dig(this.bot.blockAt(tree))
            .then(() => console.log('🪵 Bot chopped tree with hands!'))
            .catch(err => console.log('⚠ Tree chopping failed:', err.message));
        }
      }
    } catch (error) {
      console.log('⚠ Material gathering error:', error.message);
    }
  }

  performMining() {
    try {
      // Look for blocks around the bot
      const blocks = this.bot.findBlocks({
        matching: (block) => {
          return block && block.name && 
                 !block.name.includes('air') && 
                 !block.name.includes('water') && 
                 !block.name.includes('lava') &&
                 !block.name.includes('bedrock');
        },
        maxDistance: 4,
        count: 10
      });

      if (blocks.length > 0) {
        const randomBlock = blocks[Math.floor(Math.random() * blocks.length)];
        
        // 50% chance to dig, 50% chance to just look at block
        if (Math.random() < 0.5) {
          console.log('⛏️ Bot attempting to mine block at:', randomBlock);
          
          // Look at the block first (realistic behavior)
          this.bot.lookAt(randomBlock);
          
          setTimeout(() => {
            if (this.bot && this.connected) {
              this.bot.dig(this.bot.blockAt(randomBlock))
                .then(() => {
                  console.log('✅ Bot successfully mined a block!');
                  
                  // After mining, try to place a block if we have materials
                  setTimeout(() => {
                    this.tryPlaceBlock(randomBlock);
                  }, 1000 + Math.random() * 2000);
                })
                .catch((err) => {
                  console.log('⚠ Mining failed:', err.message);
                });
            }
          }, 500);
        } else {
          // Just look at the block (curious player behavior)
          this.bot.lookAt(randomBlock);
          console.log('👁️ Bot examining block');
        }
      }

      // Sometimes place blocks from inventory
      if (Math.random() < 0.3) {
        this.tryRandomBlockPlacement();
      }

    } catch (error) {
      console.log('⚠ Mining error:', error.message);
    }
  }

  tryPlaceBlock(position) {
    if (!this.bot || !this.connected) return;

    try {
      // Look for placeable items in inventory
      const placeableItems = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name.includes('dirt') ||
          item.name.includes('stone') ||
          item.name.includes('cobblestone') ||
          item.name.includes('wood') ||
          item.name.includes('plank')
        );
      });

      if (placeableItems.length > 0) {
        const item = placeableItems[0];
        const referenceBlock = this.bot.blockAt(position.offset(0, -1, 0));
        
        if (referenceBlock) {
          this.bot.equip(item, 'hand')
            .then(() => {
              return this.bot.placeBlock(referenceBlock, position.offset(0, 1, 0));
            })
            .then(() => {
              console.log('🧱 Bot placed a block!');
            })
            .catch((err) => {
              console.log('⚠ Block placing failed:', err.message);
            });
        }
      }
    } catch (error) {
      console.log('⚠ Place block error:', error.message);
    }
  }

  tryRandomBlockPlacement() {
    if (!this.bot || !this.connected) return;

    try {
      // Get bot's current position
      const botPos = this.bot.entity.position;
      
      // Try to place a block nearby
      const nearbyPositions = [
        botPos.offset(1, 0, 0),
        botPos.offset(-1, 0, 0),
        botPos.offset(0, 0, 1),
        botPos.offset(0, 0, -1),
        botPos.offset(1, 1, 1),
        botPos.offset(-1, 1, -1)
      ];

      const targetPos = nearbyPositions[Math.floor(Math.random() * nearbyPositions.length)];
      const targetBlock = this.bot.blockAt(targetPos);
      
      if (targetBlock && targetBlock.name === 'air') {
        const groundBlock = this.bot.blockAt(targetPos.offset(0, -1, 0));
        
        if (groundBlock && groundBlock.name !== 'air') {
          // Look for materials in inventory
          const buildingItems = this.bot.inventory.items().filter(item => {
            return item && item.name && (
              item.name.includes('dirt') ||
              item.name.includes('cobblestone') ||
              item.name.includes('wood')
            );
          });

          if (buildingItems.length > 0) {
            const item = buildingItems[0];
            this.bot.equip(item, 'hand')
              .then(() => {
                return this.bot.placeBlock(groundBlock, targetPos);
              })
              .then(() => {
                console.log('🏗️ Bot built something!');
              })
              .catch((err) => {
                console.log('⚠ Building failed:', err.message);
              });
          }
        }
      }
    } catch (error) {
      console.log('⚠ Random placement error:', error.message);
    }
  }

  stopActivity() {
    if (this.activityInterval) {
      clearInterval(this.activityInterval);
      this.activityInterval = null;
    }
    this.stopFastPlayerDetection();
  }

  startPlayerMonitoring() {
    if (this.playerCheckInterval) return;

    // Check for real players every 1 minute (60 seconds)
    this.playerCheckInterval = setInterval(() => {
      if (!this.connected || !this.bot) {
        // If hiding from players, check if we should return
        if (this.isHidingFromPlayers) {
          console.log('🔍 Bot is hiding - assuming real players have left after disconnect');
          this.realPlayersOnline.clear();
          this.returnAfterPlayersLeft();
        }
        return;
      }

      try {
        const currentPlayers = new Set();

        // Get all players currently online with more detailed checking
        Object.keys(this.bot.players).forEach(playerName => {
          const player = this.bot.players[playerName];

          // Allow DARK bots to coexist - don't count them as real players
          const isDarkBot = playerName.startsWith('DARK');

          // More advanced filtering - exclude bot-like usernames (but allow DARK bots)
          const isBotUsername = (!isDarkBot && playerName.startsWith('DARK_WORLD')) || 
                              playerName.startsWith('AFK') ||
                              playerName.startsWith('BOT') ||
                              playerName.includes('_BOT') ||
                              /^[A-Z_]+_\d+$/.test(playerName) || // Pattern like WORD_NUMBER
                              isDarkBot; // DARK bots are friendly bots

          // Only count as real player if they have a valid entity and are actually spawned
          if (!isBotUsername && player && player.entity) {
            currentPlayers.add(playerName);
            console.log(`🔍 Detected real player: ${playerName} (UUID: ${player.uuid})`);
          } else if (isDarkBot && playerName !== this.currentUsername) {
            console.log(`🤖 DARK bot coexisting: ${playerName}`);
          }
        });

        // Check if any real players joined
        const newPlayers = [...currentPlayers].filter(player => !this.realPlayersOnline.has(player));
        const leftPlayers = [...this.realPlayersOnline].filter(player => !currentPlayers.has(player));

        // Update the real players list
        this.realPlayersOnline = currentPlayers;

        if (newPlayers.length > 0) {
          console.log('👨‍💻 Real player(s) joined:', newPlayers.join(', '));
          console.log('📊 Total real players online:', this.realPlayersOnline.size);
          console.log('🚪 Bot exiting to give space to real players...');
          this.exitForRealPlayers();
        }

        if (leftPlayers.length > 0) {
          console.log('👋 Real player(s) left:', leftPlayers.join(', '));
          console.log('📊 Remaining real players:', this.realPlayersOnline.size);
        }

        // Only return if we're sure no real players are online
        if (this.realPlayersOnline.size === 0 && this.isHidingFromPlayers) {
          console.log('✅ No real players online confirmed, bot can return!');
          this.returnAfterPlayersLeft();
        }

        // Log current player status every 2 minutes when connected  
        if (Date.now() % 120000 < 3000) {
          console.log('📊 Current server status:');
          console.log(`   Real players: ${this.realPlayersOnline.size > 0 ? Array.from(this.realPlayersOnline).join(', ') : 'None'}`);
          console.log(`   Bot hiding: ${this.isHidingFromPlayers}`);
        }

      } catch (error) {
        console.log('⚠ Player monitoring error:', error.message);
      }
    }, 60000); // Check every 1 minute (60 seconds)
  }

  stopPlayerMonitoring() {
    if (this.playerCheckInterval) {
      clearInterval(this.playerCheckInterval);
      this.playerCheckInterval = null;
    }
  }

  startFastPlayerDetection() {
    if (this.fastPlayerCheckInterval) return;

    console.log('🔍 Starting ultra-fast player detection (500ms intervals)');

    // Ultra-fast detection every 500ms for immediate exit
    this.fastPlayerCheckInterval = setInterval(() => {
      if (!this.connected || !this.bot || this.isHidingFromPlayers) return;

      try {
        const playerList = Object.keys(this.bot.players);
        console.log(`🔎 Scanning ${playerList.length} players...`);

        // More aggressive real player detection
        const realPlayers = playerList.filter(playerName => {
          const player = this.bot.players[playerName];

          // Skip our own bot
          if (playerName === this.currentUsername) return false;

          // Allow multiple DARK bots to coexist - don't exit for DARK bots
          const isDarkBot = playerName.startsWith('DARK');
          
          // More comprehensive bot username patterns (but exclude DARK bots)
          const isBotPattern = 
            (!isDarkBot && playerName.startsWith('DARK_WORLD')) || 
            playerName.startsWith('AFK') ||
            playerName.startsWith('BOT') ||
            playerName.includes('_BOT') ||
            playerName.includes('BOT_') ||
            /^[A-Z_]+_\d+$/.test(playerName) || // WORD_NUMBER
            /^[A-Z]+\d+$/.test(playerName) ||   // WORDNUMBER
            playerName.toLowerCase().includes('afk') ||
            playerName.toLowerCase().includes('bot') ||
            isDarkBot; // DARK bots are considered bots (friendly bots)

          // Player must have valid entity and not match bot patterns
          const isRealPlayer = !isBotPattern && player && player.entity;

          if (isRealPlayer) {
            console.log(`🚨 REAL PLAYER DETECTED: ${playerName}`);
            console.log(`   - UUID: ${player.uuid}`);
            console.log(`   - Has entity: ${!!player.entity}`);
          } else if (isDarkBot && playerName !== this.currentUsername) {
            console.log(`🤖 DARK BOT DETECTED: ${playerName} - Allowing coexistence`);
          }

          return isRealPlayer;
        });

        if (realPlayers.length > 0) {
          console.log('⚡⚡⚡ IMMEDIATE EXIT TRIGGERED! ⚡⚡⚡');
          console.log(`Real players: ${realPlayers.join(', ')}`);
          console.log('🚪 Bot disconnecting NOW...');
          this.forceExitForRealPlayers(realPlayers);
        }
      } catch (error) {
        console.log('⚠ Fast detection error:', error.message);
      }
    }, 500); // Check every 500ms (twice per second)
  }

  stopFastPlayerDetection() {
    if (this.fastPlayerCheckInterval) {
      clearInterval(this.fastPlayerCheckInterval);
      this.fastPlayerCheckInterval = null;
    }
  }

  forceExitForRealPlayers(realPlayers) {
    if (this.isHidingFromPlayers) return; // Already hiding

    console.log('🚨 FORCE EXIT INITIATED 🚨');

    this.isHidingFromPlayers = true;
    this.realPlayersOnline = new Set(realPlayers);

    // Stop all activities immediately
    this.stopActivity();
    this.stopFastPlayerDetection();

    console.log('🔒 Bot entering EMERGENCY stealth mode');
    console.log(`📝 Detected real players: ${realPlayers.join(', ')}`);

    // Immediate disconnect with no delay
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        console.log('💨 Quitting bot NOW...');
        this.bot.quit('EMERGENCY EXIT - Real player detected');
      } catch (error) {
        console.log('⚠ Error in emergency quit:', error.message);
        // Force disconnect if quit fails
        if (this.bot.end) this.bot.end();
      }
    }

    this.connected = false;
    this.status = 'emergency_exit_for_real_players';

    // Cancel any scheduled reconnects
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    console.log('✅ Bot successfully exited for real players');
    this.startAdvancedMonitoring();
  }

  exitForRealPlayers() {
    if (this.isHidingFromPlayers) return; // Already hiding

    this.isHidingFromPlayers = true;
    this.stopActivity();

    console.log('🔒 Bot entering stealth mode - will monitor server externally');

    // Disconnect immediately but don't set isShuttingDown
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit('Real player joined - giving space');
      } catch (error) {
        console.log('⚠ Error quitting for real players:', error.message);
      }
    }

    this.connected = false;
    this.status = 'waiting_for_players_to_leave';

    // Cancel any scheduled reconnects
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Start advanced monitoring - try to reconnect periodically to check players
    this.startAdvancedMonitoring();
  }

  startAdvancedMonitoring() {
    if (this.advancedMonitoringInterval) {
      clearInterval(this.advancedMonitoringInterval);
    }

    let checkAttempts = 0;
    const maxChecks = 300; // Maximum 300 checks (10 minutes total with 2-second intervals)

    this.advancedMonitoringInterval = setInterval(() => {
      checkAttempts++;
      console.log(`🔍 Advanced monitoring check ${checkAttempts}/${maxChecks} - Waiting ${checkAttempts * 2} seconds`);

      // Wait much longer before assuming players left - 5 minutes minimum
      if (checkAttempts >= 150) { // 150 * 2 seconds = 5 minutes
        console.log('⏰ 5 minutes passed - attempting careful return');
        this.realPlayersOnline.clear();
        this.returnAfterPlayersLeft();
        return;
      }

      // Maximum monitoring time - 10 minutes
      if (checkAttempts >= maxChecks) {
        console.log('⏰ Maximum monitoring time reached (10 minutes) - forcing return');
        this.realPlayersOnline.clear();
        this.returnAfterPlayersLeft();
      }
    }, 2000); // Check every 2 seconds
  }

  stopAdvancedMonitoring() {
    if (this.advancedMonitoringInterval) {
      clearInterval(this.advancedMonitoringInterval);
      this.advancedMonitoringInterval = null;
    }
  }

  returnAfterPlayersLeft() {
    if (!this.isHidingFromPlayers) return; // Not hiding

    this.isHidingFromPlayers = false;
    this.stopAdvancedMonitoring();

    console.log('🤖 All clear! Preparing to return to server with delay...');

    // Add a reasonable delay before reconnecting to avoid throttling
    setTimeout(() => {
      if (!this.isShuttingDown && !this.connected && !this.isHidingFromPlayers) {
        console.log('🔄 Now attempting to reconnect after player monitoring...');
        this.connect();
      } else {
        console.log('🚫 Reconnection cancelled - bot state changed');
      }
    }, 10000); // 10 second delay to prevent rapid reconnections
  }

  switchToNextUsername() {
    // Keep trying next usernames until we find one that's not banned
    do {
      this.usernameCounter++;
      // Add random suffix to reduce conflicts
      const randomSuffix = Math.floor(Math.random() * 100);
      this.currentUsername = `${this.baseUsername}_${this.usernameCounter}_${randomSuffix}`;
    } while (this.bannedUsernames.has(this.currentUsername));

    console.log(`🔄 Switched to new username: ${this.currentUsername}`);
    console.log(`📊 Banned usernames: ${this.bannedUsernames.size}`);
  }

  // Send realistic chat messages
  sendRealisticChat() {
    if (!this.bot || !this.connected) return;

    try {
      const chatMessages = [
        'hey anyone here?',
        'nice server!',
        'looking for resources',
        'building something cool',
        'anyone want to team up?',
        'found any diamonds?',
        'this place looks cool',
        'hi everyone',
        'what are you guys doing?',
        'need some food lol',
        'anyone seen any villages?',
        'cool builds here',
        'lag is real',
        'brb getting food',
        'mining time',
        'nice weather today'
      ];

      const message = chatMessages[Math.floor(Math.random() * chatMessages.length)];
      
      // Only chat if no real players online to avoid suspicion
      if (this.realPlayersOnline.size === 0) {
        this.bot.chat(message);
        console.log(`💬 Bot chatted: "${message}"`);
      }

    } catch (error) {
      console.log('⚠ Chat error:', error.message);
    }
  }

  // Monitor bot's health, hunger, and other stats
  monitorBotStats() {
    if (!this.bot || !this.connected) return;

    try {
      const health = this.bot.health;
      const food = this.bot.food;
      const oxygen = this.bot.oxygenLevel;

      console.log(`📊 Bot Stats - Health: ${health}/20, Food: ${food}/20, Oxygen: ${oxygen}/20`);

      // Take action based on stats
      if (health < 10) {
        console.log('🩹 Bot is injured! Looking for healing items...');
        this.useHealingItems();
      }

      if (food < 6) {
        console.log('🍽️ Bot is hungry! Priority: Find food');
        this.eatFood();
      }

      if (oxygen < 15) {
        console.log('🫁 Bot needs air! Moving to surface...');
        this.moveToSurface();
      }

      // Check inventory space
      const inventoryFull = this.bot.inventory.emptySlotCount() < 5;
      if (inventoryFull) {
        console.log('🎒 Bot inventory almost full! Organizing items...');
        this.organizeInventory();
      }

    } catch (error) {
      console.log('⚠ Stats monitoring error:', error.message);
    }
  }

  // Use healing items when injured
  useHealingItems() {
    try {
      const healingItems = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name.includes('potion') ||
          item.name === 'golden_apple' ||
          item.name === 'enchanted_golden_apple' ||
          item.name === 'suspicious_stew'
        );
      });

      if (healingItems.length > 0) {
        const healItem = healingItems[0];
        console.log(`💊 Bot using healing item: ${healItem.name}`);
        
        this.bot.equip(healItem, 'hand')
          .then(() => {
            this.bot.activateItem();
            setTimeout(() => {
              if (this.bot && this.connected) {
                this.bot.deactivateItem();
                console.log('✅ Bot finished using healing item');
              }
            }, 1000);
          })
          .catch(err => console.log('⚠ Healing failed:', err.message));
      }
    } catch (error) {
      console.log('⚠ Healing error:', error.message);
    }
  }

  // Move to surface for air
  moveToSurface() {
    try {
      const currentY = this.bot.entity.position.y;
      console.log(`🏊 Bot at depth ${Math.round(currentY)}, swimming to surface...`);
      
      // Jump/swim upward
      this.bot.setControlState('jump', true);
      this.bot.setControlState('forward', true);
      
      setTimeout(() => {
        if (this.bot && this.connected) {
          this.bot.clearControlStates();
          console.log('🌊 Bot reached better oxygen level');
        }
      }, 3000);
      
    } catch (error) {
      console.log('⚠ Surface movement error:', error.message);
    }
  }

  // Organize inventory like a real player
  organizeInventory() {
    try {
      console.log('🧹 Bot organizing inventory...');
      
      // Drop less useful items to make space
      const dropItems = this.bot.inventory.items().filter(item => {
        return item && item.name && (
          item.name === 'dirt' ||
          item.name === 'cobblestone' ||
          item.name === 'gravel'
        ) && item.count > 32; // Only drop if we have too many
      });

      if (dropItems.length > 0) {
        const itemToDrop = dropItems[0];
        const dropAmount = Math.min(16, itemToDrop.count - 16); // Keep some
        
        this.bot.toss(itemToDrop.type, null, dropAmount)
          .then(() => {
            console.log(`🗑️ Bot dropped ${dropAmount} ${itemToDrop.name} to make space`);
          })
          .catch(err => console.log('⚠ Item dropping failed:', err.message));
      }
      
    } catch (error) {
      console.log('⚠ Inventory organization error:', error.message);
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      status: this.status,
      lastError: this.lastError,
      username: this.currentUsername,
      server: `${this.config.host}:${this.config.port}`,
      bannedUsernames: Array.from(this.bannedUsernames),
      usernameCounter: this.usernameCounter,
      realPlayersOnline: Array.from(this.realPlayersOnline),
      isHidingFromPlayers: this.isHidingFromPlayers,
      botStats: this.bot ? {
        health: this.bot.health || 0,
        food: this.bot.food || 0,
        oxygen: this.bot.oxygenLevel || 0,
        position: this.bot.entity ? {
          x: Math.round(this.bot.entity.position.x),
          y: Math.round(this.bot.entity.position.y),
          z: Math.round(this.bot.entity.position.z)
        } : null
      } : null
    };
  }

  disconnect() {
    // Don't set isShuttingDown to true for 24/7 operation
    // this.isShuttingDown = true; // Commented out for 24/7 mode
    
    console.log('🔄 Temporary disconnect - will auto-reconnect for 24/7 operation');
    
    this.stopActivity();
    this.stopPlayerMonitoring();
    this.stopFastPlayerDetection();
    this.stopAdvancedMonitoring();
    
    if (this.bot && typeof this.bot.quit === 'function') {
      try {
        this.bot.quit();
      } catch (error) {
        console.log('⚠ Error quitting bot:', error.message);
      }
      this.bot = null;
    }
    this.connected = false;
    this.status = 'temporarily_disconnected';
    
    // Auto-reconnect after temporary disconnect for 24/7 operation
    if (!this.reconnectTimeout) {
      console.log('🚀 Scheduling auto-reconnect for 24/7 operation...');
      this.reconnectTimeout = setTimeout(() => {
        console.log('🔄 Auto-reconnecting after temporary disconnect...');
        this.connect();
      }, 5000); // Reconnect after 5 seconds
    }
  }
}

module.exports = MinecraftBot;
