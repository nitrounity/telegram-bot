require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { createClient } = require('@supabase/supabase-js')

const replyMode = new Map()
const userMap = new Map()
const supportCooldown = new Map()
const appUrl = process.env.PUBLIC_URL || process.env.BASE_URL || process.env.APP_URL

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
  if (String(userId) === String(process.env.ADMIN_ID) || testUsers.has(String(userId))) {
    return true
  }

  const { data, error } = await supabase
    .from('payments')
    .select('user_id')
    .eq('user_id', String(userId))
    .limit(1)

  if (error) {
    console.log("❌ Supabase error in hasPaid():", error.message, "| userId:", userId, "| code:", error.code)
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

  userMap.set(String(userId), username)

  if (!seenUsers.has(userId)) {
    seenUsers.add(userId)
    await bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `🚀 New User\n@${username}\n${name}\nID: ${userId}`
    )
  }

  const paid = await hasPaid(userId)

  if (paid) {
    const inGroup = testUsers.has(String(userId)) ? false : await isUserInGroup(userId)

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
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10000)
    })

    const tokenData = await tokenRes.json()

    if (!tokenRes.ok || !tokenData.access_token) {
      console.log("❌ PayPal auth failed:", JSON.stringify(tokenData))
      return ctx.editMessageText("❌ PayPal auth failed.")
    }

    const { access_token } = tokenData

    const orderRes = await fetch(`${process.env.PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: {
            currency_code: "USD",
            value: "39.99"
          },
          custom_id: String(userId)
        }],
        ...(appUrl ? {
          application_context: {
            return_url: `${appUrl}/success?user_id=${userId}`,
            cancel_url: `https://t.me/${process.env.BOT_USERNAME}`
          }
        } : {})
      })
    })

    const orderData = await orderRes.json()

    if (!orderRes.ok) {
      console.log("❌ PayPal order failed:", JSON.stringify(orderData))
      return ctx.editMessageText("❌ Failed to create PayPal payment.")
    }

    const approve = orderData.links?.find(l => l.rel === "approve")

    if (!approve) {
      console.log("❌ PayPal approve link missing:", JSON.stringify(orderData))
      return ctx.editMessageText("❌ Failed to create PayPal payment link.")
    }

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
  const username = userMap.get(String(userId)) || "user"

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

  const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
    member_limit: 1
  })

  return ctx.reply(`🔑 ${link.invite_link}`)
})

// 🔹 STATS
bot.command('stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return
  const { data, error } = await supabase.from('payments').select('*')

  if (error) {
    console.log("❌ Supabase stats error:", error.message)
    return ctx.reply("❌ Failed to fetch stats.")
  }

  return ctx.reply(`📊 Users: ${(data || []).length}`)
})

// 🔹 TEST MODE
bot.command('test', (ctx) => {
  testUsers.add(String(ctx.from.id))
  ctx.reply("🧪 Test ON")
})

bot.command('stoptest', (ctx) => {
  testUsers.delete(String(ctx.from.id))
  ctx.reply("🛑 Test OFF")
})

// 🔹 SUPPORT SYSTEM (UPDATED)
bot.on('message', async (ctx) => {
  if (!ctx.message.text) return

  // ⛔ IGNORE GROUPS / CHANNELS
  if (ctx.chat.type !== 'private') return

  const userId = ctx.from.id
  const username = ctx.from.username || "no_username"
  const text = ctx.message.text

  userMap.set(String(userId), username)

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

    const match = ctx.message.reply_to_message.text?.match(/ID:\s*`?(\d+)`?/)
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
    console.log("❌ Support handler error:", err.stack || err.message)
    await ctx.reply("❌ Failed to contact support. Please try again.")
  }
})

// 🚀 START
bot.launch()
console.log("Bot running...")

module.exports = bot
