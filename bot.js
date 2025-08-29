
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
  }

  async connect() {
    if (this.status === 'connecting' || this.isShuttingDown) return;

    // Check if server is online first - if not, wait indefinitely
    const isServerOnline = await this.checkServerStatus();
    if (!isServerOnline) {
      console.log('📴 Server appears to be offline, starting infinite monitoring...');
      await this.waitForServerOnline(); // Wait indefinitely until server is back
      console.log('✅ Server is now online after monitoring, proceeding with connection...');
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

    console.log(`⏳ Connecting to server with username: ${this.currentUsername}...`);

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

      // Check if it's a real player (not our bot)
      const isBotPattern = 
        player.username.startsWith('DARK_WORLD') || 
        player.username.startsWith('AFK') ||
        player.username.startsWith('BOT') ||
        player.username.includes('_BOT') ||
        player.username.includes('BOT_') ||
        /^[A-Z_]+_\d+$/.test(player.username) ||
        /^[A-Z]+\d+$/.test(player.username) ||
        player.username.toLowerCase().includes('afk') ||
        player.username.toLowerCase().includes('bot');

      if (!isBotPattern && player.username !== this.currentUsername) {
        console.log('🚨🚨🚨 REAL PLAYER JOINED EVENT! 🚨🚨🚨');
        console.log(`Real player: ${player.username}`);
        console.log('⚡ INSTANT EXIT TRIGGERED BY EVENT');
        this.forceExitForRealPlayers([player.username]);
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
      delay = 3000; // 3 seconds for duplicate login (faster recovery)
    } else if (isThrottled) {
      delay = 45000; // 45 seconds for throttling (slightly faster)
    } else if (isNetworkError) {
      delay = 15000; // 15 seconds for network errors (faster recovery)
    } else {
      delay = 8000; // 8 seconds for normal errors (faster recovery)
    }

    console.log(`❌ Disconnected, retrying in ${delay/1000} seconds... (24/7 MODE - INFINITE RETRIES!)`);
    console.log(`🔍 Error type: ${isNetworkError ? 'Network/Server' : isThrottled ? 'Throttled' : isDuplicateLogin ? 'Duplicate Login' : 'Normal'}`);
    console.log('💪 BOT WILL KEEP TRYING FOREVER UNTIL CONNECTED TO WORLD!');
    
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
    console.log('🔍 INFINITE SERVER MONITORING: Will never give up checking server...');
    let attempts = 0;
    
    // Remove maxAttempts limit - keep trying forever until server is online
    while (!this.isShuttingDown) {
      attempts++;
      console.log(`🔍 Server check attempt #${attempts} (INFINITE RETRIES)...`);
      
      const isOnline = await this.checkServerStatus();
      if (isOnline) {
        console.log('🎉 Server is back online! Connecting immediately...');
        break;
      }
      
      // Progressive delay but cap at reasonable maximum
      const delay = Math.min(30000 + (attempts * 1000), 120000); // 30s to 2min max
      console.log(`📴 Server still offline, checking again in ${Math.round(delay/1000)} seconds... (Attempt ${attempts})`);
      console.log('💪 BOT NEVER GIVES UP - Will keep trying until server is back!');
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    console.log(`✅ Server monitoring complete after ${attempts} attempts`);
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

        // Try block interactions (mining/placing) occasionally
        if (Math.random() < 0.2) { // 20% chance
          this.performBlockActivity();
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
      console.log('⚠ Block activity error:', error.message);
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

          // More advanced filtering - exclude bot-like usernames
          const isBotUsername = playerName.startsWith('DARK_WORLD') || 
                              playerName.startsWith('AFK') ||
                              playerName.startsWith('BOT') ||
                              playerName.includes('_BOT') ||
                              /^[A-Z_]+_\d+$/.test(playerName); // Pattern like WORD_NUMBER

          // Only count as real player if they have a valid entity and are actually spawned
          if (!isBotUsername && player && player.entity) {
            currentPlayers.add(playerName);
            console.log(`🔍 Detected real player: ${playerName} (UUID: ${player.uuid})`);
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

          // More comprehensive bot username patterns
          const isBotPattern = 
            playerName.startsWith('DARK_WORLD') || 
            playerName.startsWith('AFK') ||
            playerName.startsWith('BOT') ||
            playerName.includes('_BOT') ||
            playerName.includes('BOT_') ||
            /^[A-Z_]+_\d+$/.test(playerName) || // WORD_NUMBER
            /^[A-Z]+\d+$/.test(playerName) ||   // WORDNUMBER
            playerName.toLowerCase().includes('afk') ||
            playerName.toLowerCase().includes('bot');

          // Player must have valid entity and not match bot patterns
          const isRealPlayer = !isBotPattern && player && player.entity;

          if (isRealPlayer) {
            console.log(`🚨 REAL PLAYER DETECTED: ${playerName}`);
            console.log(`   - UUID: ${player.uuid}`);
            console.log(`   - Has entity: ${!!player.entity}`);
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
      isHidingFromPlayers: this.isHidingFromPlayers
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
