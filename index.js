require('./bot')
const { server, setShuttingDown } = require('./server')

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...')

  // 🛑 Signal webhook handler to reject new requests immediately
  setShuttingDown()

  try {
    await global.bot.stop()
    console.log('✅ Bot stopped')
  } catch (err) {
    console.error('❌ Error stopping bot:', err.message)
  }

  server.close((err) => {
    if (err) {
      console.error('❌ Error closing HTTP server:', err.message)
      process.exit(1)
    }
    console.log('✅ HTTP server closed')
    process.exit(0)
  })
})