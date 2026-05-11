const mineflayer = require('mineflayer')
const http       = require('http')
const WebSocket  = require('ws')
const { PNG }    = require('pngjs')
const config     = require('./config')

// ── Minecraft map colour palette ──────────────────────────────────────────────
// 62 base colours (index 0 = transparent, 1-61 = real colours)
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
  if (index < 4) return [0, 0, 0, 0] // transparent
  const base  = BASE_COLORS[Math.floor(index / 4)]
  const shade = SHADES[index % 4]
  if (!base) return [0, 0, 0, 255]
  return [
    Math.round(base[0] * shade / 255),
    Math.round(base[1] * shade / 255),
    Math.round(base[2] * shade / 255),
    255,
  ]
}

function gridToPNGBase64(grid) {
  const png = new PNG({ width: 128, height: 128 })
  for (let i = 0; i < 128 * 128; i++) {
    const [r, g, b, a] = mapColorToRGBA(grid[i])
    png.data[i * 4]     = r
    png.data[i * 4 + 1] = g
    png.data[i * 4 + 2] = b
    png.data[i * 4 + 3] = a
  }
  return PNG.sync.write(png).toString('base64')
}

// ── State ─────────────────────────────────────────────────────────────────────
let bot            = null
let antiAfkTimer   = null
let reconnectTimer = null
let reconnectAttempts = 0
let loggedIn       = false
const mapGrids     = new Map() // mapId -> Uint8Array(128*128)

// ── Logging ───────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T',' ').substring(0,19)
}
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
  ws.on('message', raw => {
    try {
      const { type, data } = JSON.parse(raw)
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
    h2{color:#7ec8e3;font-size:1rem;letter-spacing:2px;text-transform:uppercase}
    #status{font-size:.8rem;color:#888}#status.on{color:#4caf50}
    #main{display:flex;gap:12px;flex:1;min-height:0}
    #log{flex:1;overflow-y:auto;background:#0d0d1a;border:1px solid #333;
         border-radius:6px;padding:10px;font-size:.82rem;line-height:1.7}
    .e{padding:1px 0;word-break:break-word;border-bottom:1px solid #111}
    .w{color:#ffb347}.x{color:#ff6b6b}.c{color:#90ee90}.y{color:#7ec8e3}
    #mapPanel{display:flex;flex-direction:column;align-items:center;gap:8px;width:280px;flex-shrink:0}
    #mapLabel{color:#7ec8e3;font-size:.8rem;text-transform:uppercase;letter-spacing:1px}
    #mapImg{width:256px;height:256px;image-rendering:pixelated;
            border:2px solid #444;border-radius:4px;background:#0d0d1a;display:none}
    #mapPlaceholder{width:256px;height:256px;border:2px dashed #333;border-radius:4px;
                    display:flex;align-items:center;justify-content:center;
                    color:#444;font-size:.75rem;text-align:center;padding:16px}
    #row{display:flex;gap:8px}
    input{flex:1;padding:10px;background:#0d0d1a;border:1px solid #444;
          border-radius:6px;color:#fff;font-family:inherit;font-size:.9rem;outline:none}
    input:focus{border-color:#7ec8e3}
    button{padding:10px 18px;background:#7ec8e3;color:#0d0d1a;border:none;
           border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit}
    button:hover{background:#5bb8d4}
  </style>
</head>
<body>
  <h2>🤖 Bot Console &nbsp;<span id="status">connecting...</span></h2>
  <div id="main">
    <div id="log"></div>
    <div id="mapPanel">
      <div id="mapLabel">📍 Captcha Map</div>
      <img id="mapImg" alt="captcha map">
      <div id="mapPlaceholder">Waiting for map data...<br><br>The captcha will appear here when the bot loads it.</div>
    </div>
  </div>
  <div id="row">
    <input id="inp" placeholder="Type captcha answer or chat message, press Enter..." autocomplete="off">
    <button onclick="send()">Send</button>
  </div>
<script>
  const logEl=document.getElementById('log')
  const st=document.getElementById('status')
  const inp=document.getElementById('inp')
  const mapImg=document.getElementById('mapImg')
  const mapPlaceholder=document.getElementById('mapPlaceholder')

  const proto=location.protocol==='https:'?'wss':'ws'
  const ws=new WebSocket(proto+'://'+location.host)

  ws.onopen=()=>{st.textContent='connected';st.className='on';add('Connected to bot console.','')}
  ws.onclose=()=>{st.textContent='disconnected';st.className=''}
  ws.onmessage=e=>{
    const{type,data}=JSON.parse(e.data)
    if(type==='log')  add(data, data.startsWith('⚠')?'w':data.startsWith('✖')?'x':'')
    if(type==='chat') add(data,'c')
    if(type==='map'){
      mapImg.src='data:image/png;base64,'+data
      mapImg.style.display='block'
      mapPlaceholder.style.display='none'
    }
  }

  function add(text,cls){
    const d=document.createElement('div')
    d.className='e '+cls
    d.textContent='['+new Date().toLocaleTimeString()+'] '+text
    logEl.appendChild(d)
    logEl.scrollTop=logEl.scrollHeight
  }

  function send(){
    const v=inp.value.trim();if(!v)return
    ws.send(JSON.stringify({type:'chat',data:v}))
    add('[You] '+v,'y')
    inp.value=''
  }

  inp.addEventListener('keydown',e=>{if(e.key==='Enter')send()})
</script>
</body>
</html>`

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/html'})
  res.end(PAGE)
})
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
server.listen(process.env.PORT || 3000, () => {
  console.log(`[${timestamp()}] [INFO]  Web console ready`)
})

// ── Bot creation ──────────────────────────────────────────────────────────────
function createBot() {
  clearTimers()
  loggedIn = false
  mapGrids.clear()

  log(`Connecting to ${config.host}:${config.port} as ${config.username} (attempt ${++reconnectAttempts})`)

  bot = mineflayer.createBot({
    host: config.host, port: config.port,
    username: config.username, auth: config.auth,
    version: config.version, hideErrors: false,
  })

  bot.once('login', () => {
    reconnectAttempts = 0
    log(`Logged in as ${bot.username}`)
    log('Waiting for captcha map to load — it will appear on the right side of the console...')
    startAntiAfk()

    // Intercept raw map packets to capture pixel data
    bot._client.on('map', (packet) => {
      const id = packet.mapId
      if (!mapGrids.has(id)) mapGrids.set(id, new Uint8Array(128 * 128))
      const grid = mapGrids.get(id)

      if (packet.data && packet.columns > 0) {
        for (let dy = 0; dy < packet.rows; dy++) {
          for (let dx = 0; dx < packet.columns; dx++) {
            grid[(packet.y + dy) * 128 + (packet.x + dx)] =
              packet.data[dy * packet.columns + dx]
          }
        }
        // Send the rendered PNG to all connected browsers
        try {
          const b64 = gridToPNGBase64(grid)
          broadcast('map', b64)
          log(`Map #${id} updated — check the panel on the right`)
        } catch (e) {
          warn(`Map render failed: ${e.message}`)
        }
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
        bot.chat('/login ' + config.botPassword)
        log('Auto-sent /login')
        loggedIn = true
      }, 800)
    }

    if (loggedIn && (lower.includes('successfully logged in') || lower.includes('you are now logged'))) {
      setTimeout(() => {
        bot.chat('/server lunarsmps5')
        log('Auto-sent /server transfer')
      }, 1200)
    }
  })

  bot.on('kicked', (reason) => {
    let r = reason
    try { const p = JSON.parse(reason); r = p.text || p.translate || reason } catch (_) {}
    warn(`Kicked: ${r}`)
    scheduleReconnect()
  })

  bot.on('error', (e) => {
    if (e.code === 'ECONNREFUSED') warn('Connection refused — retrying...')
    else err(e.message)
  })

  bot.on('end', (reason) => {
    log(`Disconnected (${reason || 'unknown'})`)
    clearTimers()
    scheduleReconnect()
  })
}

// ── Anti-AFK ──────────────────────────────────────────────────────────────────
function startAntiAfk() {
  clearInterval(antiAfkTimer)
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI * 0.5, false)
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 250)
    log('Anti-AFK: nudged')
  }, config.antiAfkInterval)
}

// ── Reconnect ─────────────────────────────────────────────────────────────────
function scheduleReconnect() {
  clearTimers()
  log(`Reconnecting in ${config.reconnectDelay / 1000}s...`)
  reconnectTimer = setTimeout(createBot, config.reconnectDelay)
}

function clearTimers() {
  if (antiAfkTimer)   { clearInterval(antiAfkTimer);  antiAfkTimer   = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer);  reconnectTimer = null }
}

// ── Shutdown ──────────────────────────────────────────────────────────────────
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

createBot()
