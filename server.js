require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { paymentExists, savePayment } = require('./supabase')

const bot = require('./bot')
const app = express()
const PORT = process.env.PORT || 3000
let shuttingDown = false

function setShuttingDown() {
  shuttingDown = true
}

app.use((req, res, next) => {
  if (shuttingDown) {
    return res.status(503).send('Server is shutting down')
  }

  return next()
})

// =========================
// 💾 PAYMENT HELPERS
// =========================
async function savePaymentIfNew(payment) {
  if (await paymentExists(payment.paymentId)) {
    console.log(`ℹ️ Payment already processed: ${payment.paymentId}`)
    return false
  }

  return savePayment(payment)
}

// =========================
// 💰 PAYPAL HELPERS
// =========================
const paypalTokenCache = { token: null, expiresAt: 0 }

async function getPayPalAccessToken() {
  if (paypalTokenCache.token && Date.now() < paypalTokenCache.expiresAt) {
    return paypalTokenCache.token
  }

  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64')

  const tokenRes = await fetch(`${process.env.PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000)
  })

  const tokenData = await tokenRes.json()

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`PayPal auth failed: ${JSON.stringify(tokenData)}`)
  }

  paypalTokenCache.token = tokenData.access_token
  paypalTokenCache.expiresAt = Date.now() + 30 * 60 * 1000

  return paypalTokenCache.token
}

async function verifyPayPalWebhook(req, event) {
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    throw new Error('PAYPAL_WEBHOOK_ID is not configured')
  }

  const accessToken = await getPayPalAccessToken()
  const verifyRes = await fetch(`${process.env.PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: event
    })
  })

  const verifyData = await verifyRes.json()

  if (!verifyRes.ok || verifyData.verification_status !== 'SUCCESS') {
    throw new Error(`PayPal webhook verification failed: ${JSON.stringify(verifyData)}`)
  }
}

function getCaptureFromOrder(order) {
  return order.purchase_units
    ?.flatMap(unit => unit.payments?.captures || [])
    ?.find(capture => capture.status === 'COMPLETED')
}

function getPayPalWebhookUserId(resource) {
  return resource.custom_id || resource.purchase_units?.[0]?.custom_id
}

// =========================
// 🔁 RETRY SEND
// =========================
async function sendInvite(userId, link) {
  const message =
    `✅ Payment received!\n\n` +
    `🔑 Join here:\n${link}\n\n` +
    `💡 Use /access anytime if needed.`

  for (let i = 1; i <= 3; i++) {
    try {
      await bot.telegram.sendMessage(userId, message)
      console.log(`✅ Sent (attempt ${i})`)
      return true
    } catch (err) {
      console.log(`❌ Attempt ${i} failed:`, err.message)
      await new Promise(res => setTimeout(res, 2000))
    }
  }

  // fallback
  try {
    await bot.telegram.sendMessage(
      userId,
      `⚠️ Payment received, but message failed.\n\n👉 Use /access to get your invite link.`
    )
  } catch (err) {
    console.log("❌ Fallback failed:", err.message)
  }

  return false
}

async function sendNewPaymentInvite(userId) {
  try {
    const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    const sent = await sendInvite(userId, link.invite_link)
    return sent
  } catch (err) {
    console.log("❌ sendNewPaymentInvite() failed for userId:", userId, "|", err.message)
    return false
  }
}

// =========================
// 💳 STRIPE WEBHOOK
// =========================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.log("❌ Stripe error:", err.message)
    return res.sendStatus(400)
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const paymentId = session.id
    const userId = session.metadata?.user_id
    const amount = session.amount_total / 100

    if (!userId) return res.sendStatus(200)

    try {
      const saved = await savePaymentIfNew({
        userId,
        amount,
        method: 'stripe',
        paymentId
      })

      if (saved) {
        const invited = await sendNewPaymentInvite(userId)
        if (!invited) {
          console.log("❌ Stripe: invite not delivered for userId:", userId)
        }
      }
    } catch (err) {
      console.log("❌ Stripe invite error:", err.message)
    }
  }

  res.sendStatus(200)
})

// =========================
// 💰 PAYPAL WEBHOOK
// =========================
app.post('/paypal-webhook', express.json(), async (req, res) => {
  const event = req.body

  try {
    await verifyPayPalWebhook(req, event)
  } catch (err) {
    console.log("❌ PayPal webhook verification error:", err.message)
    return res.sendStatus(400)
  }

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    try {
      const resource = event.resource
      const paymentId = resource.id
      const userId = getPayPalWebhookUserId(resource)

      if (!userId) return res.sendStatus(200)

      const saved = await savePaymentIfNew({
        userId,
        amount: Number(resource.amount?.value),
        method: 'paypal',
        paymentId
      })

      if (saved) {
        const invited = await sendNewPaymentInvite(userId)
        if (!invited) {
          console.log("❌ PayPal webhook: invite not delivered for userId:", userId)
        }
      }
    } catch (err) {
      console.log("❌ PayPal error:", err.message)
    }
  }

  res.sendStatus(200)
})

// =========================
// 🔁 PAYPAL FALLBACK
// =========================
app.get('/success', async (req, res) => {
  const { token, user_id: userId } = req.query

  if (!token || !userId) {
    return res.status(400).send('Missing payment details')
  }

  try {
    const accessToken = await getPayPalAccessToken()

    const captureRes = await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    })

    const order = await captureRes.json()

    if (!captureRes.ok) {
      console.log("❌ PayPal capture failed:", JSON.stringify(order))
      return res.status(400).send('Payment capture failed')
    }

    const capture = getCaptureFromOrder(order)

    if (!capture) {
      console.log("❌ PayPal capture missing completed capture:", JSON.stringify(order))
      return res.status(400).send('Payment was not completed')
    }

    const saved = await savePaymentIfNew({
      userId,
      amount: Number(capture.amount?.value),
      method: 'paypal',
      paymentId: capture.id
    })

    if (saved) {
      const invited = await sendNewPaymentInvite(userId)
      if (!invited) {
        console.log("❌ PayPal fallback: invite not delivered for userId:", userId)
      }
    }

    res.send('Payment successful!')
  } catch (err) {
    console.log("❌ PayPal fallback error:", err.message)
    res.status(500).send('Error')
  }
})

// =========================
// 🚀 START
// =========================
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})

module.exports = { server, setShuttingDown }
