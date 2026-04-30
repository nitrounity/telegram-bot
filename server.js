require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { createClient } = require('@supabase/supabase-js')

const app = express()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// =========================
// 💾 SAVE PAYMENT
// =========================
async function savePayment({ userId, amount, method, paymentId }) {
  const { error } = await supabase
    .from('payments')
    .insert([{
      user_id: String(userId),
      amount: Number(amount),
      method,
      payment_id: paymentId
    }])

  if (error) {
    console.log("❌ Supabase error:", error.message)
  } else {
    console.log("✅ Saved to Supabase")
  }
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
      await global.bot.telegram.sendMessage(userId, message)
      console.log(`✅ Sent (attempt ${i})`)
      return
    } catch (err) {
      console.log(`❌ Attempt ${i} failed:`, err.message)
      await new Promise(res => setTimeout(res, 2000))
    }
  }

  // fallback
  try {
    await global.bot.telegram.sendMessage(
      userId,
      `⚠️ Payment received, but message failed.\n\n👉 Use /access to get your invite link.`
    )
  } catch (err) {
    console.log("❌ Fallback failed:", err.message)
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

    const { data } = await supabase
      .from('payments')
      .select('payment_id')
      .eq('payment_id', paymentId)
      .limit(1)

    if (!data || data.length === 0) {
      await savePayment({
        userId,
        amount,
        method: "stripe",
        paymentId
      })
    }

    try {
      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      await sendInvite(userId, link.invite_link)

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

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    try {
      const resource = event.resource
      const paymentId = resource.id

      const userId =
        resource.custom_id ||
        resource.purchase_units?.[0]?.custom_id

      if (!userId) return res.sendStatus(200)

      const { data } = await supabase
        .from('payments')
        .select('payment_id')
        .eq('payment_id', paymentId)
        .limit(1)

      if (!data || data.length === 0) {
        await savePayment({
          userId,
          amount: Number(resource.amount?.value),
          method: "paypal",
          paymentId
        })
      }

      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      await sendInvite(userId, link.invite_link)

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
  const { token, user_id } = req.query

  try {
    const auth = Buffer.from(
      process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_SECRET
    ).toString("base64")

    const tokenRes = await fetch(`${process.env.PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    })

    const { access_token } = await tokenRes.json()

    await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    })

    const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    await sendInvite(user_id, link.invite_link)

    res.send("Payment successful!")

  } catch (err) {
    console.log("❌ PayPal fallback error:", err.message)
    res.send("Error")
  }
})

// =========================
// 🚀 START
// =========================
app.listen(3000, () => {
  console.log("🚀 Server running")
})