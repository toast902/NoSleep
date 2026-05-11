module.exports = {
  // ── Server ────────────────────────────────────────────────────────────────
  // Your Minefort server address (shown on your Minefort dashboard)
  host: 'lunarsmps5.minefort.com',
  port: 25565,
  version: '1.21.11',

  // ── Account ───────────────────────────────────────────────────────────────
  // The Microsoft account username/email that owns the bot account.
  // auth: 'microsoft' will open a browser login on first run, then cache it.
  username: 'KeepAliveBot',   // any name you want
  auth: 'offline',            // no Microsoft account needed

  // ── Behaviour ─────────────────────────────────────────────────────────────
  // How long (ms) to wait before reconnecting after a disconnect
  reconnectDelay: 10000,      // 10 seconds

  // Move randomly every this many milliseconds to avoid AFK kicks
  antiAfkInterval: 20000,     // 20 seconds

  // If the bot gets sent to a lobby/hub on join, type this command to
  // transfer to your actual server. Leave as null if not needed.
  // e.g. for Minefort: '/server your-server-name'
  joinCommand: null,
}
