require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const app = express()

// 🔹 STRIPE WEBHOOK
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("🔥 Stripe Webhook HIT")

  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.log("❌ Stripe webhook error:", err.message)
    return res.sendStatus(400)
  }

  console.log("✅ Event:", event.type)

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const userId = session.metadata?.user_id
    const amount = session.amount_total / 100

    if (!userId) {
      console.log("❌ Missing user_id")
      return res.sendStatus(200)
    }

    try {
      // 🔗 Create invite
      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      // 📩 Send to user
      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${link.invite_link}`
      )

      // 📩 Notify admin
      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 Stripe Payment\nUser: ${userId}\nAmount: $${amount}`
      )

      console.log("✅ Stripe flow complete")

    } catch (err) {
      console.log("❌ Telegram error:", err.message)
    }
  }

  res.sendStatus(200)
})


// 🔹 PAYPAL SUCCESS (redirect-based)
app.get('/success', async (req, res) => {
  const { token, user_id } = req.query

  console.log("🟡 PayPal success route hit")

  try {
    // 🔑 Get PayPal token
    const auth = Buffer.from(
      process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_SECRET
    ).toString("base64")

    const tokenRes = await fetch(`${process.env.PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    })

    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token

    // 💰 Capture payment
    await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    })

    // 🔗 Create invite
    const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    // 📩 Send to user
    await global.bot.telegram.sendMessage(
      user_id,
      `✅ PayPal payment received!\nJoin here:\n${link.invite_link}`
    )

    // 📩 Notify admin
    await global.bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `💰 PayPal Payment\nUser: ${user_id}`
    )

    res.send("Payment successful! Return to Telegram.")

    console.log("✅ PayPal flow complete")

  } catch (err) {
    console.log("❌ PayPal error:", err.message)
    res.send("Error processing payment.")
  }
})


// 🔹 START SERVER
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000")
})