require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

// ✅ Validate required environment variables at startup
if (!process.env.GROUP_ID) {
  console.error('❌ Missing required environment variable: GROUP_ID')
  process.exit(1)
}

const app = express()

// 🔒 Shutdown flag — set to true when SIGTERM is received
let isShuttingDown = false
exports.setShuttingDown = () => { isShuttingDown = true }

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // 🛑 Reject new requests during graceful shutdown
  if (isShuttingDown) {
    console.log('⚠️ Rejecting webhook request — server is shutting down')
    return res.status(503).json({ error: 'Service unavailable — shutting down' })
  }

  console.log("🔥 Webhook HIT")

  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.log('❌ Webhook error:', err.message)
    return res.sendStatus(400)
  }

  console.log("✅ Event type:", event.type)

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const userId = session.metadata?.user_id
    const amount = session.amount_total / 100

    console.log("💰 User paid:", userId)

    if (!userId) {
      console.log("❌ No user_id in metadata")
      return res.sendStatus(200)
    }

    // ✅ CREATE INVITE LINK
    let link
    try {
      console.log("🔗 Creating invite link...")
      link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })
      console.log("✅ Invite link created")
    } catch (err) {
      console.error("❌ Failed to create invite link:", err.message)
      return res.sendStatus(500)
    }

    // ✅ SEND TO USER AND NOTIFY ADMIN
    try {
      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${link.invite_link}`
      )
      console.log("📩 Message sent to user")

      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 New Payment!\n\nUser ID: ${userId}\nAmount: $${amount}`
      )
      console.log("📩 Admin notified")
    } catch (err) {
      console.error("❌ Failed to send Telegram messages:", err.message)
      return res.sendStatus(500)
    }
  }

  res.sendStatus(200)
})

const server = app.listen(3000, () => console.log("Webhook server running"))

server.on('error', (err) => {
  console.error('❌ Failed to start webhook server:', err.message)
  process.exit(1)
})

exports.server = server