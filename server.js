require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const app = express()

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature']

  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.log('Webhook error:', err.message)
    return res.sendStatus(400)
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const userId = session.metadata.user_id
    const amount = session.amount_total / 100

    console.log("User paid:", userId)

    // ✅ 1. SEND ACCESS TO USER (AUTO)
    global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    }).then(link => {
      global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${link.invite_link}`
      )
    }).catch(err => {
      console.log("Invite link error:", err.message)
    })

    // ✅ 2. SEND NOTIFICATION TO YOU (ADMIN)
    global.bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `💰 New Payment!\n\nUser ID: ${userId}\nAmount: $${amount}`
    ).catch(err => {
      console.log("Admin notify error:", err.message)
    })
  }

  res.sendStatus(200)
})

app.listen(3000, () => console.log("Webhook server running"))