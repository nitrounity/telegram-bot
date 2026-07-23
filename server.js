require('dotenv').config()
const bot = require('./bot')
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { createClient } = require('@supabase/supabase-js')

let supabase

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

// 🔹 SUPABASE HELPERS
async function upsertCustomer({ userId, stripeCustomerId, paypalId }) {
  try {
    const record = {
      user_id: String(userId),
      status: 'active',
      created_at: new Date().toISOString()
    }

    if (stripeCustomerId) record.stripe_customer_id = stripeCustomerId
    if (paypalId) record.paypal_id = paypalId

    const { error } = await supabase
      .from('customers')
      .upsert(record, { onConflict: 'user_id' })

    if (error) {
      console.log("❌ Supabase upsert error:", error.message)
    } else {
      console.log("✅ Customer upserted in Supabase:", userId)
    }
  } catch (err) {
    console.log("❌ Supabase upsert exception:", err.message)
  }
}

async function markCustomerCancelled(userId, source = 'Stripe') {
  try {
    const { error } = await supabase
      .from('customers')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString()
      })
      .eq('user_id', String(userId))

    if (error) {
      console.log(`❌ Supabase cancellation update error (${source}):`, error.message)
      return
    }

    console.log(`✅ Marked user ${userId} ${source === 'PayPal' ? 'PayPal ' : ''}subscription as cancelled`)
  } catch (err) {
    console.log(`❌ Supabase cancellation exception (${source}):`, err.message)
  }
}

const app = express()

// 🔹 TELEGRAM WEBHOOK
const WEBHOOK_PATH = '/telegram-webhook'
app.use(WEBHOOK_PATH, express.json(), (req, res, next) => {
  if (isShuttingDown) return res.sendStatus(503)
  next()
}, (req, res) => bot.handleUpdate(req.body, res))

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

      await upsertCustomer({
        userId,
        stripeCustomerId: session.customer || paymentId
      })

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

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object
    const userId = subscription.metadata?.user_id

    if (!userId) {
      console.log("❌ customer.subscription.deleted missing user_id metadata")
      return res.sendStatus(200)
    }

    await markCustomerCancelled(userId, 'Stripe')
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

      await upsertCustomer({
        userId,
        paypalId: paymentId
      })

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

  if (event.event_type === 'BILLING.SUBSCRIPTION.CANCELLED') {
    try {
      const resource = event.resource
      const userId = resource?.custom_id

      if (!userId) {
        console.log("❌ BILLING.SUBSCRIPTION.CANCELLED missing custom_id")
        return res.sendStatus(200)
      }

      await markCustomerCancelled(userId, 'PayPal')
    } catch (err) {
      console.log("❌ PayPal cancellation webhook error:", err.message)
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

    await upsertCustomer({
      userId: user_id,
      paypalId: captureData.id
    })

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

// 🔹 ADMIN: LIST EXPIRED CANCELLED CUSTOMERS (READ-ONLY)
app.get('/admin/check-expired', async (req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('user_id, status, cancelled_at')
      .eq('status', 'cancelled')
      .lt('cancelled_at', thirtyDaysAgo.toISOString())

    if (error) {
      console.log("❌ Supabase query error (check-expired):", error.message)
      return res.status(500).json({ success: false, error: error.message })
    }

    return res.json({ success: true, count: data.length, customers: data })
  } catch (err) {
    console.log("❌ /admin/check-expired error:", err.message)
    return res.status(500).json({ success: false, error: err.message })
  }
})

// 🔹 ADMIN: CLEANUP EXPIRED CANCELLED CUSTOMERS
app.get('/admin/cleanup-expired', async (req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const errors = []
  let removed = 0

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('user_id')
      .eq('status', 'cancelled')
      .lt('cancelled_at', thirtyDaysAgo.toISOString())

    if (error) {
      console.log("❌ Supabase query error (cleanup-expired):", error.message)
      return res.status(500).json({ success: false, error: error.message })
    }

    for (const customer of data) {
      const userId = customer.user_id

      try {
        await bot.telegram.banChatMember(process.env.GROUP_ID, userId)
        removed++
      } catch (err) {
        console.log(`❌ Failed to remove user ${userId}:`, err.message)
        errors.push({ user_id: userId, error: err.message })
      }
    }

    console.log(`✅ Cleanup: removed ${removed} expired customers`)

    return res.json({ success: true, removed, errors })
  } catch (err) {
    console.log("❌ /admin/cleanup-expired error:", err.message)
    return res.status(500).json({ success: false, error: err.message })
  }
})


// 🔹 START SERVER
let server

async function start() {
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
  } catch (err) {
    console.error("❌ Failed to set Telegram webhook:", err.message)
    process.exit(1)
  }

  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    console.log("✅ Supabase client initialized")
  } catch (err) {
    console.error("❌ Failed to initialize Supabase:", err.message)
    process.exit(1)
  }

  server = app.listen(3000, () => {
    console.log("🚀 Server running on port 3000")
  })
}

start()

module.exports = { get server() { return server }, setShuttingDown }
