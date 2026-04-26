require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const bot = new Telegraf(process.env.BOT_TOKEN)
global.bot = bot

// 🧠 Track users (simple memory)
const seenUsers = new Set()

// 🔹 START
bot.start((ctx) => {
  const userId = ctx.from.id
  const username = ctx.from.username || "no_username"
  const name = ctx.from.first_name || "no_name"

  // 🚀 FIRST TIME USER NOTIFICATION
  if (!seenUsers.has(userId)) {
    seenUsers.add(userId)

    global.bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `🚀 New User Started Bot!\n\nUser: @${username}\nName: ${name}\nUser ID: ${userId}`
    ).catch(() => {})
  }

  ctx.reply(
    `Hi, ${name}!\n\nPlease select the option below to proceed with your purchase:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('ONETIMEFEE: $39.99 / Lifetime', 'buy')],
    ])
  )
})

// 🔹 BUY → PAYMENT MENU
bot.action('buy', (ctx) => {
  ctx.editMessageText(
    'Please select a payment method:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 Credit/Debit Card (Stripe)', 'stripe')],
      [Markup.button.callback('PayPal', 'paypal')],
      [Markup.button.callback('Crypto (No KYC)', 'crypto')],
      [Markup.button.callback('⬅️ Back', 'back_main')],
    ])
  )
})

// 🔹 STRIPE PAYMENT
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
        user_id: ctx.from.id,
        username: ctx.from.username || "no_username",
        first_name: ctx.from.first_name || "no_name"
      }
    })

    await ctx.reply(`💳 Pay with card:\n${session.url}`)
  } catch (err) {
    console.log("Stripe error:", err.message)
    ctx.reply("❌ Error creating payment. Try again.")
  }
})

// 🔹 PAYPAL (placeholder)
bot.action('paypal', (ctx) => {
  ctx.reply('PayPal coming soon.')
})

// 🔹 CRYPTO (placeholder)
bot.action('crypto', (ctx) => {
  ctx.reply('Crypto payment coming soon.')
})

// 🔹 BACK TO MAIN MENU
bot.action('back_main', (ctx) => {
  ctx.editMessageText(
    `Hi, ${ctx.from.first_name}!\n\nPlease select the option below to proceed with your purchase:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('ONETIMEFEE: $39.99 / Lifetime', 'buy')],
    ])
  )
})

// 🚀 START BOT
bot.launch()
console.log("Bot is running...")