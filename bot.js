require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const bot = new Telegraf(process.env.BOT_TOKEN)
global.bot = bot

// 🧠 Track first-time users
const seenUsers = new Set()

// 🔹 START
bot.start(async (ctx) => {
  const userId = ctx.from.id
  const username = ctx.from.username || "no_username"
  const name = ctx.from.first_name || "no_name"

  // 🚀 Notify admin (first time only)
  if (!seenUsers.has(userId)) {
    seenUsers.add(userId)

    try {
      await bot.telegram.sendMessage(
        process.env.ADMIN_ID,
        `🚀 New User Started Bot!\n\nUser: @${username}\nName: ${name}\nUser ID: ${userId}`
      )
    } catch {}
  }

  return ctx.reply(
    `Hi, ${name}!\n\nChoose an option:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 Buy Lifetime Access ($39.99)', 'buy')],
    ])
  )
})


// 🔹 BUY MENU
bot.action('buy', (ctx) => {
  return ctx.editMessageText(
    'Select payment method:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 Stripe', 'stripe')],
      [Markup.button.callback('💰 PayPal', 'paypal')],
      [Markup.button.callback('⬅️ Back', 'back')],
    ])
  )
})


// 🔹 STRIPE
bot.action('stripe', async (ctx) => {
  try {
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

    return ctx.reply(`💳 Pay here:\n${session.url}`)

  } catch (err) {
    console.log("Stripe error:", err.message)
    return ctx.reply("❌ Stripe error. Try again.")
  }
})


// 🔹 PAYPAL
bot.action('paypal', async (ctx) => {
  try {
    const userId = ctx.from.id

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

    // 💰 Create order
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
          }
        }],
        application_context: {
          return_url: `https://telegram-bot-production-a216.up.railway.app/success?user_id=${userId}`,
          cancel_url: `https://t.me/${process.env.BOT_USERNAME}`
        }
      })
    })

    const orderData = await orderRes.json()
    const approveLink = orderData.links.find(l => l.rel === "approve").href

    return ctx.reply(`💰 Pay with PayPal:\n${approveLink}`)

  } catch (err) {
    console.log("PayPal error:", err.message)
    return ctx.reply("❌ PayPal error. Try again.")
  }
})


// 🔹 BACK
bot.action('back', (ctx) => {
  return ctx.editMessageText(
    `Hi, ${ctx.from.first_name}!\n\nChoose an option:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 Buy Lifetime Access ($39.99)', 'buy')],
    ])
  )
})


// 🚀 START BOT
bot.launch()
console.log("Bot is running...")