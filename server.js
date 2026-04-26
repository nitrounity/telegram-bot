require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const app = express()

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

    try {
      // ✅ CREATE INVITE LINK
      console.log("🔗 Creating invite link...")
      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      console.log("✅ Invite link created")

      // ✅ SEND TO USER
      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${link.invite_link}`
      )

      console.log("📩 Message sent to user")

      // ✅ NOTIFY ADMIN
      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 New Payment!\n\nUser ID: ${userId}\nAmount: $${amount}`
      )

      console.log("📩 Admin notified")

    } catch (err) {
      console.log("❌ Telegram error:", err.message)
    }
  }

  res.sendStatus(200)
})

app.listen(3000, () => console.log("Webhook server running"))