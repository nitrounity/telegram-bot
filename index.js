require('./bot')
require('./server')

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down bot...')
  await global.bot.stop()
  process.exit(0)
})