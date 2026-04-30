require('dotenv').config()
const express = require('express')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { createClient } = require('@supabase/supabase-js')

const app = express()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// ✅ SAVE PAYMENT (DB)
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
    const username = session.metadata?.username || "no_username"
    const amount = session.amount_total / 100

    if (!userId) return res.sendStatus(200)

    // 🔒 Prevent duplicate DB insert (NOT delivery)
    const { data: existing } = await supabase
      .from('payments')
      .select('payment_id')
      .eq('payment_id', paymentId)
      .limit(1)

    if (!existing || existing.length === 0) {
      await savePayment({
        userId,
        amount,
        method: "stripe",
        paymentId
      })
    } else {
      console.log("⚠️ Duplicate Stripe:", paymentId)
    }

    // ✅ ALWAYS send invite
    try {
      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\n\n🔑 Join here:\n${link.invite_link}\n\n💡 Use /access anytime.`
      )

      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `🎉 *New Payment Received!*\n\n` +
        `• Method: STRIPE\n` +
        `• User: @${username}\n` +
        `• Profile: [Open](tg://user?id=${userId})\n` +
        `• User ID: \`${userId}\`\n` +
        `• Amount: *$${amount}*\n`,
        { parse_mode: "Markdown" }
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

      const userId =
        resource.custom_id ||
        resource.purchase_units?.[0]?.custom_id

      if (!userId) return res.sendStatus(200)

      const { data: existing } = await supabase
        .from('payments')
        .select('payment_id')
        .eq('payment_id', paymentId)
        .limit(1)

      if (!existing || existing.length === 0) {
        await savePayment({
          userId,
          amount: Number(resource.amount?.value),
          method: "paypal",
          paymentId
        })
      } else {
        console.log("⚠️ Duplicate PayPal:", paymentId)
      }

      // ✅ ALWAYS send invite
      const link = await global.bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
        member_limit: 1
      })

      await global.bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\n\n🔑 Join here:\n${link.invite_link}\n\n💡 Use /access anytime.`
      )

      await global.bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `🎉 *New Payment Received!*\n\n` +
        `• Method: PAYPAL\n` +
        `• User: [Open Profile](tg://user?id=${userId})\n` +
        `• User ID: \`${userId}\`\n` +
        `• Amount: *$${resource.amount?.value}*\n`,
        { parse_mode: "Markdown" }
      )

      console.log("✅ PayPal complete")

    } catch (err) {
      console.log("❌ PayPal webhook error:", err.message)
    }
  }

  res.sendStatus(200)
})

// 🔹 PAYPAL FALLBACK (backup)
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

    await global.bot.telegram.sendMessage(
      user_id,
      `✅ PayPal payment received!\n\n🔑 Join here:\n${link.invite_link}\n\n💡 Use /access anytime.`
    )

    res.send("Payment successful! Return to Telegram.")

  } catch (err) {
    console.log("❌ PayPal fallback error:", err.message)
    res.send("Error processing payment.")
  }
})

// 🚀 START SERVER
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000")
})