require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const bot = new Telegraf(process.env.BOT_TOKEN)
global.bot = bot

const seenUsers = new Set()

const loadingKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('⏳ Processing...', 'noop')],
])

bot.action('noop', (ctx) => ctx.answerCbQuery())

// 🔹 START
bot.start(async (ctx) => {
  const userId = ctx.from.id
  const username = ctx.from.username || "no_username"
  const name = ctx.from.first_name || "no_name"

  if (!seenUsers.has(userId)) {
    seenUsers.add(userId)

    try {
      await bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `🚀 New User\n@${username}\n${name}\nID: ${userId}`
      )
    } catch {}
  }

  return ctx.reply(
    `Hi, ${name} 👋\n\nPlease select the option below to proceed with your purchase:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('ONETIMEFEE: $39.99 / Lifetime', 'buy')],
    ])
  )
})


// 🔹 PAYMENT MENU
bot.action('buy', (ctx) => {
  return ctx.editMessageText(
    'Please select a payment method:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 Credit/Debit Card (Stripe)', 'stripe')],
      [Markup.button.callback('💰 PayPal', 'paypal')],
      [Markup.button.callback('Crypto (No KYC)', 'crypto')],
      [Markup.button.callback('⬅️ Back', 'back_main')],
    ])
  )
})


// 🔹 STRIPE
bot.action('stripe', async (ctx) => {
  try {
    // 🔒 LOCK BUTTONS
    await ctx.editMessageText("⏳ Generating Stripe payment...", loadingKeyboard)

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Lifetime Access' },
          unit_amount: 3999
        },
        quantity: 1
      }],
      success_url: `https://t.me/${process.env.BOT_USERNAME}`,
      cancel_url: `https://t.me/${process.env.BOT_USERNAME}`,
      metadata: {
        user_id: ctx.from.id
      }
    })

    // 🔓 UNLOCK BUTTONS
    return ctx.editMessageText(
      `💳 Pay with Stripe:\n${session.url}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Stripe', 'stripe')],
        [Markup.button.callback('💰 PayPal', 'paypal')],
        [Markup.button.callback('Crypto', 'crypto')],
        [Markup.button.callback('⬅️ Back', 'back_main')],
      ])
    )

  } catch (err) {
    console.log(err.message)
    return ctx.editMessageText("❌ Stripe error. Try again.")
  }
})

// 🔹 PAYPAL
bot.action('paypal', async (ctx) => {
  try {
    const userId = ctx.from.id

    // 🔒 LOCK BUTTONS
    await ctx.editMessageText("⏳ Generating PayPal payment...", loadingKeyboard)

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

    const orderRes = await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: {
            currency_code: "USD",
            value: "39.99"
          },
          custom_id: String(userId)
        }],
        application_context: {
          return_url: `${process.env.BASE_URL}/success?user_id=${userId}`,
          cancel_url: `https://t.me/${process.env.BOT_USERNAME}`
        }
      })
    })

    if (!orderRes.ok) {
      return ctx.editMessageText("❌ Failed to create PayPal payment.")
    }

    const orderData = await orderRes.json()
    const approveLink = orderData.links.find(l => l.rel === "approve").href

    // 🔓 UNLOCK BUTTONS
    return ctx.editMessageText(
      `💰 Pay with PayPal:\n${approveLink}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Stripe', 'stripe')],
        [Markup.button.callback('💰 PayPal', 'paypal')],
        [Markup.button.callback('Crypto', 'crypto')],
        [Markup.button.callback('⬅️ Back', 'back_main')],
      ])
    )

  } catch (err) {
    console.log(err.message)
    return ctx.editMessageText("❌ PayPal error. Try again.")
  }
})

// 🔹 CRYPTO
bot.action('crypto', (ctx) => {
  return ctx.editMessageText(
    "Crypto coming soon.",
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 Stripe', 'stripe')],
      [Markup.button.callback('💰 PayPal', 'paypal')],
      [Markup.button.callback('Crypto', 'crypto')],
      [Markup.button.callback('⬅️ Back', 'back_main')],
    ])
  )
})


// 🔹 BACK
bot.action('back_main', (ctx) => {
  return ctx.editMessageText(
    `Please select the option below to proceed with your purchase:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('ONETIMEFEE: $39.99 / Lifetime', 'buy')],
    ])
  )
})

// 🔹 ADMIN STATS COMMAND
const fs = require('fs')
const path = require('path')

const DATA_FILE = path.join(__dirname, 'payments.json')

bot.command('stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) {
    return ctx.reply("❌ You are not authorized.")
  }

  try {
    if (!fs.existsSync(DATA_FILE)) {
      return ctx.reply("No payments yet.")
    }

    const raw = fs.readFileSync(DATA_FILE)
    const payments = JSON.parse(raw)

    const totalRevenue = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const totalUsers = new Set(payments.map(p => p.userId)).size

    const stripeCount = payments.filter(p => p.method === 'stripe').length
    const paypalCount = payments.filter(p => p.method === 'paypal').length

    await ctx.reply(
      `📊 Stats:\n\n` +
      `💰 Revenue: $${totalRevenue}\n` +
      `👥 Users: ${totalUsers}\n\n` +
      `💳 Stripe: ${stripeCount}\n` +
      `💰 PayPal: ${paypalCount}`
    )

  } catch (err) {
    console.log(err)
    ctx.reply("Error reading stats.")
  }
})

// 🚀 START
bot.launch()
console.log("Bot is running...")