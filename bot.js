require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { createClient } = require('@supabase/supabase-js')

const replyMode = new Map()
const userMap = new Map()
const supportCooldown = new Map()

// 🔑 Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

const bot = new Telegraf(process.env.BOT_TOKEN)
global.bot = bot

const seenUsers = new Set()
const testUsers = new Set()

// 🔒 Loading keyboard
const loadingKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('⏳ Processing...', 'noop')],
])

bot.action('noop', (ctx) => ctx.answerCbQuery())

// 🔹 CHECK IF USER PAID
async function hasPaid(userId) {
  if (String(userId) === String(process.env.ADMIN_ID) && testUsers.has(userId)) {
    return true
  }

  const { data, error } = await supabase
    .from('payments')
    .select('user_id')
    .eq('user_id', String(userId))
    .limit(1)

  if (error) {
    console.log("❌ Supabase error:", error.message)
    return false
  }

  return data && data.length > 0
}

// 🔹 CHECK IF USER IN GROUP
async function isUserInGroup(userId) {
  try {
    const member = await bot.telegram.getChatMember(process.env.GROUP_ID, userId)
    return ['member','administrator','creator'].includes(member.status)
  } catch {
    return false
  }
}

// 🔹 START
bot.start(async (ctx) => {
  const userId = ctx.from.id
  const username = ctx.from.username || "no_username"
  const name = ctx.from.first_name || "no_name"

  userMap.set(userId, username)

  if (!seenUsers.has(userId)) {
    seenUsers.add(userId)
    await bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `🚀 New User\n@${username}\n${name}\nID: ${userId}`
    )
  }

  const paid = await hasPaid(userId)

  if (paid) {
    const inGroup = testUsers.has(userId) ? false : await isUserInGroup(userId)

    if (inGroup) {
      return ctx.reply(
        `✅ You already have access.\n\n💡 Use /access anytime if needed.`
      )
    }

    const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    return ctx.reply(
      `✅ You have access!\n\n🔑 Join:\n${link.invite_link}\n\n💡 Use /access anytime.`
    )
  }

  return ctx.reply(
    `Hi, ${name} 👋\n\n` +
    `💬 Chat here for Customer Support\n\n` +
    `Please select the option below to proceed with your purchase:`,
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
        user_id: ctx.from.id,
        username: ctx.from.username || "no_username"
      }
    })

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

    await ctx.editMessageText("⏳ Generating PayPal payment...", loadingKeyboard)

    const auth = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
    ).toString("base64")

    const tokenRes = await fetch(`${process.env.PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    })

    const tokenText = await tokenRes.text()
    console.log("TOKEN RESPONSE:", tokenText)

    if (!tokenRes.ok) {
      return ctx.editMessageText("❌ PayPal auth failed.")
    }

    const { access_token } = JSON.parse(tokenText)

    const orderRes = await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
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
}]
      })
    })

    const orderText = await orderRes.text()
    console.log("ORDER RESPONSE:", orderText)

    if (!orderRes.ok) {
      return ctx.editMessageText("❌ Failed to create PayPal payment.")
    }

    const orderData = JSON.parse(orderText)

    const approve = orderData.links.find(l => l.rel === "approve")

    return ctx.editMessageText(
      `💰 Pay with PayPal:\n${approve.href}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Stripe', 'stripe')],
        [Markup.button.callback('💰 PayPal', 'paypal')],
        [Markup.button.callback('Crypto', 'crypto')],
        [Markup.button.callback('⬅️ Back', 'back_main')],
      ])
    )

  } catch (err) {
    console.log("🔥 PAYPAL CRASH:", err)
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
    'Please select an option:',
    Markup.inlineKeyboard([
      [Markup.button.callback('ONETIMEFEE: $39.99 / Lifetime', 'buy')],
    ])
  )
})

// 🔹 SUPPORT REPLY BUTTON (UPDATED)
bot.action(/reply_(.+)/, async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) {
    return ctx.answerCbQuery("Not allowed")
  }

  const userId = ctx.match[1]
  const username = userMap.get(userId) || "user"

  replyMode.set(ctx.from.id, userId)

  await ctx.answerCbQuery()

  await ctx.reply(
    `✍️ Replying to @${username}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Cancel", callback_data: "cancel_reply" }]
        ]
      }
    }
  )
})

// 🔹 CANCEL REPLY
bot.action('cancel_reply', async (ctx) => {
  replyMode.delete(ctx.from.id)
  await ctx.answerCbQuery()
  await ctx.reply("❌ Reply cancelled.")
})

// 🔹 ACCESS
bot.command('access', async (ctx) => {
  const paid = await hasPaid(ctx.from.id)
  if (!paid) return ctx.reply("❌ You don’t have access.")

  const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID)
  ctx.reply(`🔑 ${link.invite_link}`)
})

// 🔹 STATS
bot.command('stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return
  const { data } = await supabase.from('payments').select('*')
  ctx.reply(`📊 Users: ${data.length}`)
})

// 🔹 TEST MODE
bot.command('test', (ctx) => {
  testUsers.add(ctx.from.id)
  ctx.reply("🧪 Test ON")
})

bot.command('stoptest', (ctx) => {
  testUsers.delete(ctx.from.id)
  ctx.reply("🛑 Test OFF")
})

// 🔹 SUPPORT SYSTEM (UPDATED)
bot.on('message', async (ctx) => {
  if (!ctx.message.text) return

  const userId = ctx.from.id
  const username = ctx.from.username || "no_username"
  const text = ctx.message.text

  userMap.set(userId, username)

  if (text.startsWith('/')) return

  // ADMIN
  if (String(userId) === String(process.env.ADMIN_ID)) {

    if (replyMode.has(userId)) {
      const target = replyMode.get(userId)

      await bot.telegram.sendMessage(target, `💬 Support:\n${text}`)
      replyMode.delete(userId)

      return ctx.reply("✅ Reply sent.")
    }

    if (!ctx.message.reply_to_message) {
      return ctx.reply("⚠️ Reply or use button.")
    }

    const match = ctx.message.reply_to_message.text.match(/ID: `(\d+)`/)
    if (!match) return ctx.reply("❌ Could not detect user.")

    await bot.telegram.sendMessage(match[1], `💬 Support:\n${text}`)
    return
  }

  // USER → ADMIN
  try {
    await bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `📩 New Support Message\n\nFrom @${username}\nID: ${userId}\n—\n${text}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💬 Reply", callback_data: `reply_${userId}` }]
          ]
        }
      }
    )

    const now = Date.now()
    const last = supportCooldown.get(userId) || 0

    if (now - last > 86400000) {
      await ctx.reply("✅ Message sent to support. We'll reply shortly.")
      supportCooldown.set(userId, now)
    }

  } catch (err) {
  console.log(err.message)
  await ctx.reply("❌ Failed to contact support. Please try again.")
}
})

// 🚀 START
bot.launch()
console.log("Bot running...")