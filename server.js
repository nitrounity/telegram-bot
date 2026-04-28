require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const fs = require('fs')
const path = require('path')

const DATA_FILE = path.join(__dirname, 'payments.json')

const app = express()

const processedPayments = new Set()

function savePayment(data) {
  let payments = []

  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE)
    payments = JSON.parse(raw)
  }

  payments.push(data)

  fs.writeFileSync(DATA_FILE, JSON.stringify(payments, null, 2))
}


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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const paymentId = session.id
    const userId = session.metadata?.user_id
    const amount = session.amount_total / 100

    if (processedPayments.has(paymentId)) {
      console.log("⚠️ Duplicate Stripe ignored:", paymentId)
      return res.sendStatus(200)
    }

    processedPayments.add(paymentId)

    if (!userId) return res.sendStatus(200)

    // ✅ SAVE PAYMENT
    savePayment({
      userId,
      amount,
      method: "stripe",
      date: new Date().toISOString()
    })

    try {
      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${link.invite_link}`
      )

      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 Stripe Payment\nUser: ${userId}\nAmount: $${amount}`
      )

      console.log("✅ Stripe complete")

    } catch (err) {
      console.log("❌ Telegram error:", err.message)
    }
  }

  res.sendStatus(200)
})


// 🔹 PAYPAL WEBHOOK
app.post('/paypal-webhook', express.json(), async (req, res) => {
  console.log("🟡 PayPal Webhook HIT")

  const event = req.body

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    try {
      const resource = event.resource
      const paymentId = resource.id
      const userId = resource.custom_id

      if (processedPayments.has(paymentId)) {
        console.log("⚠️ Duplicate PayPal ignored:", paymentId)
        return res.sendStatus(200)
      }

      processedPayments.add(paymentId)

      if (!userId) return res.sendStatus(200)

      // ✅ SAVE PAYMENT
      savePayment({
        userId,
        amount: resource.amount?.value || "unknown",
        method: "paypal",
        date: new Date().toISOString()
      })

      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${link.invite_link}`
      )

      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 PayPal Payment\nUser: ${userId}`
      )

    } catch (err) {
      console.log("❌ PayPal webhook error:", err.message)
    }
  }

  res.sendStatus(200)
})


// 🔹 PAYPAL FALLBACK
app.get('/success', async (req, res) => {
  const { token, user_id } = req.query

  console.log("🟡 PayPal success fallback hit")

  try {
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

    await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    })

    const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    await global.bot.telegram.sendMessage(
      user_id,
      `✅ PayPal payment received!\nJoin here:\n${link.invite_link}`
    )

    await global.bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `💰 PayPal (fallback)\nUser: ${user_id}`
    )

    res.send("Payment successful! Return to Telegram.")

  } catch (err) {
    console.log("❌ PayPal fallback error:", err.message)
    res.send("Error processing payment.")
  }
})


// 🔹 START SERVER
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000")
})