require('dotenv').config()
const bot = require('./bot')
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

let isShuttingDown = false
function setShuttingDown() { isShuttingDown = true }

const processedPayments = new Set()

async function createCustomerInviteLink() {
  if (!process.env.GROUP_ID) {
    console.log("❌ GROUP_ID environment variable is not set")
    return null
  }

  try {
    const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })
    console.log("✅ Invite link created:", link.invite_link)
    return link.invite_link
  } catch (err) {
    console.log("❌ Failed to create invite link:", err.message)
    return null
  }
}

const app = express()

// 🔹 HEALTHCHECK
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true })
})

// 🔹 TELEGRAM WEBHOOK
const WEBHOOK_PATH = '/telegram-webhook'
app.use(WEBHOOK_PATH, express.json(), (req, res, next) => {
  if (isShuttingDown) return res.sendStatus(503)
  next()
}, (req, res) => {
  console.log("📩 Incoming Telegram update:", JSON.stringify(req.body))
  bot.handleUpdate(req.body, res).catch(err => {
    console.log("❌ handleUpdate error:", err)
    if (!res.headersSent) res.sendStatus(200)
  })
})

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
    const paymentId = session.id // 🔑 unique Stripe ID
    const userId = session.metadata?.user_id
    const amount = session.amount_total / 100

    // 🚫 DUPLICATE CHECK (MUST BE FIRST)
    if (processedPayments.has(paymentId)) {
      console.log("⚠️ Duplicate Stripe ignored:", paymentId)
      return res.sendStatus(200)
    }

    processedPayments.add(paymentId)

    if (!userId) return res.sendStatus(200)

    try {
      const inviteLink = await createCustomerInviteLink()

      if (!inviteLink) {
        console.log("❌ Invite link unavailable — aborting Stripe message to user:", userId)
        return res.sendStatus(200)
      }

      await bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${inviteLink}`
      )

      await bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 Stripe Payment\nUser: ${userId}\nAmount: ${amount}`
      )

      console.log("✅ Stripe complete")

    } catch (err) {
      console.log("❌ Telegram error:", err.message)
    }
  }

  res.sendStatus(200)
})

// 🔹 PAYPAL WEBHOOK (🔥 MAIN SYSTEM)
app.post('/paypal-webhook', express.json(), async (req, res) => {
  console.log("🟡 PayPal Webhook HIT")

  const event = req.body

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    try {
      const resource = event.resource

      const paymentId = resource.id // 🔑 unique PayPal ID
      const userId = resource.custom_id

      // 🚫 DUPLICATE CHECK
      if (processedPayments.has(paymentId)) {
        console.log("⚠️ Duplicate PayPal event ignored:", paymentId)
        return res.sendStatus(200)
      }

      processedPayments.add(paymentId)

      if (!userId) {
        console.log("❌ Missing user_id")
        return res.sendStatus(200)
      }

      console.log("💰 PayPal payment:", paymentId, "User:", userId)

      const inviteLink = await createCustomerInviteLink()

      if (!inviteLink) {
        console.log("❌ Invite link unavailable — aborting PayPal message to user:", userId)
        return res.sendStatus(200)
      }

      await bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\nJoin here:\n${inviteLink}`
      )

      await bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `💰 PayPal Payment\nUser: ${userId}`
      )

    } catch (err) {
      console.log("❌ PayPal webhook error:", err.message)
    }
  }

  res.sendStatus(200)
})

// 🔹 PAYPAL FALLBACK (OPTIONAL BUT SAFE)
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

    const captureRes = await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    })

    if (!captureRes.ok) {
      const captureErrorBody = await captureRes.text()
      console.log("❌ PayPal capture failed:", captureRes.status, captureErrorBody)
      return res.send("Payment could not be captured. Please contact support.")
    }

    const captureData = await captureRes.json()
    console.log("✅ PayPal capture succeeded:", captureData.id, captureData.status)

    const inviteLink = await createCustomerInviteLink()

    if (!inviteLink) {
      console.log("❌ Invite link unavailable — aborting PayPal fallback message to user:", user_id)
      return res.send("Payment received, but could not generate invite link. Please contact support.")
    }

    await bot.telegram.sendMessage(
      user_id,
      `✅ PayPal payment received!\nJoin here:\n${inviteLink}`
    )

    await bot.telegram.sendMessage(
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
let server

async function start() {
  console.log("🔄 Starting server initialization...")

  // Set up Telegram webhook before accepting traffic
  const baseUrl = process.env.BASE_URL
  if (!baseUrl) {
    console.error("❌ BASE_URL environment variable is not set — cannot register webhook")
    process.exit(1)
  }

  const webhookUrl = `${baseUrl}${WEBHOOK_PATH}`

  try {
    await bot.telegram.setWebhook(webhookUrl)
    console.log("✅ Telegram webhook set:", webhookUrl)

    const info = await bot.telegram.getWebhookInfo()
    console.log("ℹ️ Webhook info:", JSON.stringify(info))
  } catch (err) {
    console.error("❌ Failed to set Telegram webhook:", err.message)
    process.exit(1)
  }

  const port = process.env.PORT || 3000
  server = app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`)
    console.log("✅ Healthcheck available at /health")
    console.log("✅ Server startup complete — ready to accept traffic")
  })

  server.on('error', (err) => {
    console.error("❌ Server failed to start:", err.message)
    process.exit(1)
  })
}

start().catch((err) => {
  console.error("❌ Fatal error during startup:", err)
  process.exit(1)
})

module.exports = { get server() { return server }, setShuttingDown }