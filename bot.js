const mineflayer = require('mineflayer')
const http       = require('http')
const WebSocket  = require('ws')
const { PNG }    = require('pngjs')
const config     = require('./config')

// ── Map colour palette ────────────────────────────────────────────────────────
const BASE_COLORS = [
  null,
  [127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],
  [167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],
  [112,112,112],[64,64,255],[143,119,72],[255,252,245],[213,125,50],
  [176,75,213],[101,151,213],[229,229,51],[127,204,25],[242,127,165],
  [76,76,76],[153,153,153],[76,127,153],[127,63,178],[51,76,178],
  [102,76,51],[102,127,51],[153,51,51],[25,25,25],[250,238,77],
  [92,219,213],[74,128,255],[0,217,58],[129,86,49],[112,2,0],
  [209,177,161],[159,82,36],[149,87,108],[112,108,138],[186,133,36],
  [103,117,53],[160,77,78],[57,41,35],[135,107,98],[87,92,92],
  [122,73,88],[76,62,92],[76,50,35],[76,82,42],[142,60,46],
  [37,22,16],[189,48,49],[148,63,97],[92,25,29],[22,126,134],
  [58,142,140],[86,44,62],[20,180,133],[100,100,100],[216,175,147],
  [127,167,150],
]
const SHADES = [180, 220, 255, 135]

function mapColorToRGBA(index) {
  if (index < 4) return [0, 0, 0, 0]
  const base = BASE_COLORS[Math.floor(index / 4)]
  const shade = SHADES[index % 4]
  if (!base) return [0, 0, 0, 255]
  return [Math.round(base[0]*shade/255), Math.round(base[1]*shade/255), Math.round(base[2]*shade/255), 255]
}

function gridToPNGBase64(grid) {
  const png = new PNG({ width: 128, height: 128 })
  for (let i = 0; i < 128*128; i++) {
    const [r,g,b,a] = mapColorToRGBA(grid[i])
    png.data[i*4]=r; png.data[i*4+1]=g; png.data[i*4+2]=b; png.data[i*4+3]=a
  }
  return PNG.sync.write(png).toString('base64')
}

// ── State ─────────────────────────────────────────────────────────────────────
let bot            = null
let antiAfkTimer   = null
let reconnectTimer = null
let reconnectAttempts = 0
let loggedIn       = false
let transferTarget = null
let session        = null   // { host, port, username, password, version }
const mapGrids     = new Map()
const mapSlotOrder = []

// ── Logging ───────────────────────────────────────────────────────────────────
function timestamp() { return new Date().toISOString().replace('T',' ').substring(0,19) }
function log(msg)  { console.log (`[${timestamp()}] [INFO]  ${msg}`); broadcast('log', msg) }
function warn(msg) { console.warn(`[${timestamp()}] [WARN]  ${msg}`); broadcast('log', '⚠ ' + msg) }
function err(msg)  { console.error(`[${timestamp()}] [ERROR] ${msg}`); broadcast('log', '✖ ' + msg) }

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true })

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data })
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg) })
}

wss.on('connection', ws => {
  // Send current session state to newly connected browser
  ws.send(JSON.stringify({ type: 'state', data: session ? 'connected' : 'setup' }))

  // Re-send any cached map panels
  mapSlotOrder.forEach((id, slot) => {
    const grid = mapGrids.get(id)
    if (grid) {
      try { ws.send(JSON.stringify({ type: 'map', data: { slot, b64: gridToPNGBase64(grid) } })) }
      catch (_) {}
    }
  })

  ws.on('message', raw => {
    try {
      const { type, data } = JSON.parse(raw)

      if (type === 'start') {
        // Browser sent connection settings — start the bot
        session = {
          host:     data.host,
          port:     parseInt(data.port) || 25565,
          username: data.username || config.username,
          password: data.password || config.botPassword,
          version:  data.version  || config.version,
        }
        log(`Starting bot → ${session.host}:${session.port} as ${session.username}`)
        broadcast('state', 'connecting')
        createBot(session.host, session.port)
      }

      if (type === 'stop') {
        log('Bot stopped by user.')
        stopBot()
        session = null
        broadcast('state', 'setup')
      }

      if (type === 'chat' && bot) {
        bot.chat(data)
        log(`[You → bot] ${data}`)
      }
    } catch (_) {}
  })
})

// ── Web console ───────────────────────────────────────────────────────────────
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bot Console</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#1a1a2e;color:#e0e0e0;font-family:'Courier New',monospace;
         display:flex;flex-direction:column;height:100vh;padding:16px;gap:12px}
    h2{color:#7ec8e3;font-size:1rem;letter-spacing:2px;text-transform:uppercase;display:flex;align-items:center;gap:12px}
    #badge{font-size:.75rem;padding:3px 10px;border-radius:20px;background:#333;color:#888}
    #badge.on{background:#1a3a1a;color:#4caf50}
    #badge.connecting{background:#2a2a1a;color:#ffb347}

    /* ── Setup screen ── */
    #setup{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:20px}
    #setupBox{background:#0d0d1a;border:1px solid #333;border-radius:10px;padding:32px;width:100%;max-width:420px;display:flex;flex-direction:column;gap:14px}
    #setupBox h3{color:#7ec8e3;font-size:.9rem;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}
    .field{display:flex;flex-direction:column;gap:4px}
    .field label{font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:1px}
    .field input{padding:9px 12px;background:#1a1a2e;border:1px solid #444;border-radius:6px;
                 color:#fff;font-family:inherit;font-size:.9rem;outline:none}
    .field input:focus{border-color:#7ec8e3}
    #connectBtn{padding:12px;background:#7ec8e3;color:#0d0d1a;border:none;border-radius:6px;
                font-weight:bold;font-size:.95rem;cursor:pointer;font-family:inherit;margin-top:4px}
    #connectBtn:hover{background:#5bb8d4}

    /* ── Console screen ── */
    #console{display:none;flex-direction:column;flex:1;gap:12px;min-height:0}
    #toprow{display:flex;gap:8px;align-items:center}
    #serverLabel{color:#888;font-size:.8rem;flex:1}
    #stopBtn{padding:6px 14px;background:#3a1a1a;color:#ff6b6b;border:1px solid #5a2a2a;
             border-radius:6px;font-family:inherit;font-size:.8rem;cursor:pointer}
    #stopBtn:hover{background:#5a2a2a}
    #main{display:flex;gap:12px;flex:1;min-height:0}
    #log{flex:1;overflow-y:auto;background:#0d0d1a;border:1px solid #333;
         border-radius:6px;padding:10px;font-size:.82rem;line-height:1.7}
    .e{padding:1px 0;word-break:break-word;border-bottom:1px solid #111}
    .w{color:#ffb347}.x{color:#ff6b6b}.c{color:#90ee90}.y{color:#7ec8e3}
    #mapPanel{display:flex;flex-direction:column;align-items:center;gap:8px;width:310px;flex-shrink:0}
    #mapLabel{color:#7ec8e3;font-size:.8rem;text-transform:uppercase;letter-spacing:1px;align-self:flex-start}
    #mapGrid{display:grid;grid-template-columns:repeat(3,96px);grid-template-rows:repeat(3,96px);
             gap:2px;background:#0d0d1a;border:2px solid #333;border-radius:6px;padding:6px}
    .mapCell{width:96px;height:96px;image-rendering:pixelated;background:#111;border:1px solid #222}
    #mapHint{font-size:.72rem;color:#555;text-align:center}
    #row{display:flex;gap:8px}
    #inp{flex:1;padding:10px;background:#0d0d1a;border:1px solid #444;border-radius:6px;
         color:#fff;font-family:inherit;font-size:.9rem;outline:none}
    #inp:focus{border-color:#7ec8e3}
    #sendBtn{padding:10px 18px;background:#7ec8e3;color:#0d0d1a;border:none;border-radius:6px;
             font-weight:bold;cursor:pointer;font-family:inherit}
    #sendBtn:hover{background:#5bb8d4}
  </style>
</head>
<body>
  <h2>🤖 Bot Console <span id="badge">idle</span></h2>

  <!-- Setup screen -->
  <div id="setup">
    <div id="setupBox">
      <h3>Connect to Server</h3>
      <div class="field">
        <label>Server IP</label>
        <input id="f_host" placeholder="play.example.com" autocomplete="off">
      </div>
      <div class="field">
        <label>Port</label>
        <input id="f_port" placeholder="25565" value="25565" autocomplete="off">
      </div>
      <div class="field">
        <label>Username</label>
        <input id="f_username" placeholder="BotUsername" autocomplete="off">
      </div>
      <div class="field">
        <label>AuthMe Password</label>
        <input id="f_password" type="password" placeholder="your /login password" autocomplete="off">
      </div>
      <div class="field">
        <label>Minecraft Version</label>
        <input id="f_version" placeholder="1.21.11" value="1.21.11" autocomplete="off">
      </div>
      <button id="connectBtn" onclick="startBot()">Connect</button>
    </div>
  </div>

  <!-- Console screen -->
  <div id="console">
    <div id="toprow">
      <span id="serverLabel">—</span>
      <button id="stopBtn" onclick="stopBot()">■ Disconnect</button>
    </div>
    <div id="main">
      <div id="log"></div>
      <div id="mapPanel">
        <div id="mapLabel">📍 Captcha (3×3)</div>
        <div id="mapGrid">
          ${Array.from({length:9},(_,i)=>`<img class="mapCell" id="cell_${i}" src="" alt="">`).join('')}
        </div>
        <div id="mapHint">Maps fill in as the bot receives them.<br>Type the captcha in the box below.</div>
      </div>
    </div>
    <div id="row">
      <input id="inp" placeholder="Type captcha answer, press Enter..." autocomplete="off">
      <button id="sendBtn" onclick="sendMsg()">Send</button>
    </div>
  </div>

<script>
  const badge      = document.getElementById('badge')
  const setupEl    = document.getElementById('setup')
  const consoleEl  = document.getElementById('console')
  const logEl      = document.getElementById('log')
  const serverLabel= document.getElementById('serverLabel')
  const inp        = document.getElementById('inp')

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws    = new WebSocket(proto + '://' + location.host)

  ws.onmessage = e => {
    const { type, data } = JSON.parse(e.data)

    if (type === 'state') {
      if (data === 'setup') {
        setupEl.style.display = 'flex'
        consoleEl.style.display = 'none'
        badge.textContent = 'idle'; badge.className = ''
      } else if (data === 'connecting') {
        setupEl.style.display = 'none'
        consoleEl.style.display = 'flex'
        badge.textContent = 'connecting'; badge.className = 'connecting'
      } else if (data === 'connected') {
        setupEl.style.display = 'none'
        consoleEl.style.display = 'flex'
        badge.textContent = 'connected'; badge.className = 'on'
      }
    }

    if (type === 'log')  add(data, data.startsWith('⚠')?'w':data.startsWith('✖')?'x':'')
    if (type === 'chat') add(data, 'c')
    if (type === 'map') {
      const cell = document.getElementById('cell_' + data.slot)
      if (cell) cell.src = 'data:image/png;base64,' + data.b64
    }
  }

  function add(text, cls) {
    const d = document.createElement('div')
    d.className = 'e ' + cls
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text
    logEl.appendChild(d)
    logEl.scrollTop = logEl.scrollHeight
  }

  function startBot() {
    const host = document.getElementById('f_host').value.trim()
    if (!host) { alert('Server IP is required'); return }
    serverLabel.textContent = host + ':' + (document.getElementById('f_port').value || '25565')
    ws.send(JSON.stringify({ type: 'start', data: {
      host,
      port:     document.getElementById('f_port').value,
      username: document.getElementById('f_username').value.trim(),
      password: document.getElementById('f_password').value,
      version:  document.getElementById('f_version').value.trim(),
    }}))
  }

  function stopBot() {
    ws.send(JSON.stringify({ type: 'stop' }))
    logEl.innerHTML = ''
    for (let i = 0; i < 9; i++) {
      const c = document.getElementById('cell_' + i)
      if (c) c.src = ''
    }
  }

  function sendMsg() {
    const v = inp.value.trim(); if (!v) return
    ws.send(JSON.stringify({ type: 'chat', data: v }))
    add('[You] ' + v, 'y')
    inp.value = ''
  }

  inp.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg() })
</script>
</body>
</html>`

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(PAGE)
})
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
server.listen(process.env.PORT || 3000, () => {
  console.log(`[${timestamp()}] [INFO]  Web console ready on port ${process.env.PORT || 3000}`)
})

// ── Bot ───────────────────────────────────────────────────────────────────────
function stopBot() {
  clearTimers()
  transferTarget = null
  if (bot) { try { bot.quit('stopped') } catch (_) {} bot = null }
  mapGrids.clear()
  mapSlotOrder.length = 0
  loggedIn = false
}

function createBot(host, port) {
  clearTimers()
  loggedIn = false
  mapGrids.clear()
  mapSlotOrder.length = 0

  const isLobby = (host === session?.host)

  log(`Connecting to ${host}:${port} as ${session.username} (attempt ${++reconnectAttempts})`)

  bot = mineflayer.createBot({
    host, port,
    username: session.username,
    auth:     config.auth,
    version:  session.version,
    hideErrors: false,
  })

  bot.once('login', () => {
    reconnectAttempts = 0
    log(`Logged in as ${bot.username}`)
    broadcast('state', 'connected')

    if (!isLobby) {
      // Direct connection to game server — just AuthMe, no captcha
      setTimeout(() => {
        if (bot && bot.entity) {
          bot.chat('/login ' + session.password)
          log('Auto-sent /login to game server')
        }
      }, 2000)
    } else {
      log('In lobby — waiting for captcha map...')
    }

    startAntiAfk()

    // Debug: log all packets during server switch
    let switching = false
    bot._client.on("packet", (data, meta) => {
      if (switching) log(`[PKT] ${meta.name} (${meta.state ?? bot._client.state})`)
    })
    bot._client.on("start_configuration", () => {
      log("start_configuration received")
      switching = true
      bot._client.write("acknowledge_configuration", {})
      bot._client.state = "configuration"
    })

    // Must reply to keep_alive even in configuration state or the server kicks us
    bot._client.on("keep_alive", (packet) => {
      if (bot._client.state === "configuration") {
        try { bot._client.write("keep_alive", { keepAliveId: packet.keepAliveId }) }
        catch (e) { warn(`keep_alive reply failed: ${e.message}`) }
      }
    })

    // Must reply to select_known_packs or configuration stalls
    bot._client.on("select_known_packs", (packet) => {
      log(`select_known_packs received (${(packet.knownPacks||[]).length} packs from server)`)
      // Try both possible packet names for the response
      const sent = ['known_packs', 'select_known_packs'].find(name => {
        try { bot._client.write(name, { knownPacks: [] }); return true }
        catch (_) { return false }
      })
      if (sent) log(`replied to select_known_packs via '${sent}'`)
      else warn('could not reply to select_known_packs — no valid packet name found')
    })

    bot._client.on("finish_configuration", () => {
      log("finish_configuration received — server switch complete!")
      bot._client.write("acknowledge_configuration", {})
      bot._client.state = "play"
      switching = false
      loggedIn = false
    })

    // Native Transfer packet handler
    bot._client.on('transfer', (packet) => {
      log(`Transfer packet → ${packet.host}:${packet.port}`)
      transferTarget = { host: packet.host, port: packet.port }
      clearTimers()
      bot._client.end('transfer')
    })

    // Map art capture
    bot._client.on('map', (packet) => {
      const id = packet.mapId ?? packet.id ?? packet.itemDamage
      if (id == null) return
      if (!mapGrids.has(id)) {
        if (mapSlotOrder.length >= 9) return
        mapGrids.set(id, new Uint8Array(128 * 128))
        mapSlotOrder.push(id)
        log(`Map panel ${mapSlotOrder.length}/9 (id ${id})`)
      }
      const grid = mapGrids.get(id)
      const slot = mapSlotOrder.indexOf(id)
      if (packet.data && packet.columns > 0) {
        for (let dy = 0; dy < packet.rows; dy++)
          for (let dx = 0; dx < packet.columns; dx++)
            grid[(packet.y+dy)*128+(packet.x+dx)] = packet.data[dy*packet.columns+dx]
        try { broadcast('map', { slot, b64: gridToPNGBase64(grid) }) }
        catch (e) { warn(`Map render error: ${e.message}`) }
      }
    })
  })

  bot.on('spawn', () => log(`Spawned in world: ${bot.game.dimension}`))

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    if (!text.trim()) return
    broadcast('chat', text)
    console.log(`[${timestamp()}] [CHAT] ${text}`)
    const lower = text.toLowerCase()

    if (!loggedIn && (lower.includes('/login') || lower.includes('please login') || lower.includes('log in'))) {
      setTimeout(() => {
        if (bot) { bot.chat('/login ' + session.password); log('Auto-sent /login'); loggedIn = true }
      }, 800)
    }

    if (loggedIn && isLobby && (lower.includes('successfully logged in') || lower.includes('you are now logged'))) {
      setTimeout(() => {
        if (bot && bot.entity && !transferTarget) {
          log('No transfer packet — trying /server as fallback')
          const serverName = session.host.split('.')[0]
          bot.chat('/server ' + serverName)
        }
      }, 3000)
    }
  })

  bot.on('kicked', (reason) => {
    let r
    try {
      const obj = typeof reason === 'string' ? JSON.parse(reason) : reason
      r = obj?.type === 'compound' ? obj.value?.text?.value || JSON.stringify(obj.value)
                                   : obj?.text || JSON.stringify(obj)
    } catch (_) { r = String(reason) }
    warn(`Kicked: ${r}`)
    scheduleReconnect()
  })

  bot.on('error', (e) => {
    if (e.code === 'ECONNREFUSED') warn('Connection refused — retrying...')
    else err(e.message)
  })

  bot.on('end', (reason) => {
    if (reason === 'transfer' && transferTarget) {
      const { host: tHost, port: tPort } = transferTarget
      transferTarget = null
      log(`Transferring to ${tHost}:${tPort}...`)
      clearTimers()
      setTimeout(() => createBot(tHost, tPort), 2000)
      return
    }
    log(`Disconnected (${reason || 'unknown'})`)
    clearTimers()
    if (session) scheduleReconnect()
  })
}

// ── Anti-AFK ──────────────────────────────────────────────────────────────────
function startAntiAfk() {
  clearInterval(antiAfkTimer)
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return
    bot.look(Math.random()*Math.PI*2, (Math.random()-.5)*Math.PI*.5, false)
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 250)
  }, config.antiAfkInterval)
}

function scheduleReconnect() {
  clearTimers()
  transferTarget = null
  log(`Reconnecting in ${config.reconnectDelay / 1000}s...`)
  reconnectTimer = setTimeout(() => { if (session) createBot(session.host, session.port) }, config.reconnectDelay)
}

function clearTimers() {
  if (antiAfkTimer)   { clearInterval(antiAfkTimer);  antiAfkTimer   = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer);  reconnectTimer = null }
}

process.on('SIGINT', () => { stopBot(); process.exit(0) })
process.on('uncaughtException', (e) => { err(`Uncaught: ${e.message}`); scheduleReconnect() })
