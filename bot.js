const mineflayer = require('mineflayer')
const config = require('./config')

// ── State ─────────────────────────────────────────────────────────────────────
let bot = null
let antiAfkTimer = null
let reconnectTimer = null
let reconnectAttempts = 0

// ── Logging helpers ───────────────────────────────────────────────────────────
function log(msg)  { console.log (`[${timestamp()}] [INFO]  ${msg}`) }
function warn(msg) { console.warn (`[${timestamp()}] [WARN]  ${msg}`) }
function err(msg)  { console.error(`[${timestamp()}] [ERROR] ${msg}`) }
function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19)
}

// ── Bot creation ──────────────────────────────────────────────────────────────
function createBot() {
  clearTimers()

  log(`Connecting to ${config.host}:${config.port} as ${config.username} (attempt ${++reconnectAttempts})`)

  bot = mineflayer.createBot({
    host:     config.host,
    port:     config.port,
    username: config.username,
    auth:     config.auth,
    version:  config.version,
    hideErrors: false,
  })

  // ── Events ──────────────────────────────────────────────────────────────────

  bot.once('login', () => {
    reconnectAttempts = 0
    log(`Logged in as ${bot.username}`)

    // Some Minefort setups drop you into a lobby first
    if (config.joinCommand) {
      log(`Sending join command: ${config.joinCommand}`)
      setTimeout(() => bot.chat(config.joinCommand), 2000)
    }

    startAntiAfk()
  })

  bot.on('spawn', () => {
    log(`Spawned in world: ${bot.game.dimension}`)
  })

  bot.on('chat', (username, message) => {
    // Ignore own messages
    if (username === bot.username) return
    log(`<${username}> ${message}`)
  })

  bot.on('kicked', (reason) => {
    let reasonText = reason
    try {
      // reason is sometimes a JSON chat component
      const parsed = JSON.parse(reason)
      reasonText = parsed.text || parsed.translate || reason
    } catch (_) {}
    warn(`Kicked: ${reasonText}`)
    scheduleReconnect()
  })

  bot.on('error', (e) => {
    // ECONNREFUSED usually means the server is still starting up
    if (e.code === 'ECONNREFUSED') {
      warn(`Connection refused — server may be starting. Retrying...`)
    } else {
      err(`${e.message}`)
    }
  })

  bot.on('end', (reason) => {
    log(`Disconnected (${reason || 'unknown reason'})`)
    clearTimers()
    scheduleReconnect()
  })
}

// ── Anti-AFK ─────────────────────────────────────────────────────────────────
function startAntiAfk() {
  clearInterval(antiAfkTimer)
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return

    // Randomly look around and do a small hop to reset the AFK timer
    const yaw   = Math.random() * Math.PI * 2
    const pitch = (Math.random() - 0.5) * Math.PI * 0.5
    bot.look(yaw, pitch, false)

    // Tap jump briefly
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 250)

    log('Anti-AFK: nudged')
  }, config.antiAfkInterval)
}

// ── Reconnect logic ───────────────────────────────────────────────────────────
function scheduleReconnect() {
  clearTimers()
  const delay = config.reconnectDelay
  log(`Reconnecting in ${delay / 1000}s...`)
  reconnectTimer = setTimeout(createBot, delay)
}

function clearTimers() {
  if (antiAfkTimer)   { clearInterval(antiAfkTimer);  antiAfkTimer   = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer);  reconnectTimer = null }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  log('Shutting down...')
  clearTimers()
  if (bot) bot.quit('Bot stopped')
  process.exit(0)
})

process.on('uncaughtException', (e) => {
  err(`Uncaught exception: ${e.message}`)
  scheduleReconnect()
})

// Keeps Render's free tier alive — must be before createBot()
const http = require('http')
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000)

// ── Start ─────────────────────────────────────────────────────────────────────
createBot()
