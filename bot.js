require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const { createClient } = require('@supabase/supabase-js')

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

async function hasPaid(userId) {
  // 🔥 TEST MODE OVERRIDE
  if (String(userId) === String(process.env.ADMIN_ID) && testUsers.has(userId)) {
    return true
  }

  const { data, error } = await supabase
    .from('payments')
    .select('user_id')
    .eq('user_id', String(userId))
    .limit(1)

  if (error) {
    console.log("❌ Supabase check error:", error.message)
    return false
  }

  return data && data.length > 0
}

async function isUserInGroup(userId) {
  try {
    const member = await bot.telegram.getChatMember(process.env.GROUP_ID, userId)

    return (
      member.status === 'member' ||
      member.status === 'administrator' ||
      member.status === 'creator'
    )
  } catch (err) {
    return false
  }
}

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
        `🚀 New User\n@${username}\n${name}\nID: ${userId}`
      )
    } catch {}
  }

  // 🔥 CHECK IF USER ALREADY PAID
  
const paid = await hasPaid(userId)

if (paid) {
  const inGroup =
    testUsers.has(userId) ? false : await isUserInGroup(userId)

  if (inGroup) {
    return ctx.reply(
      `✅ You already have access to the group.\n\n` +
      `💡 Use /access anytime if you need a new invite link.`
    )
  }

  try {
    const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    return ctx.reply(
      `✅ You already have access!\n\n` +
      `🔑 Join here:\n${link.invite_link}\n\n` +
      `💡 Use /access anytime if you need a new invite link.`
    )
  } catch (err) {
    console.log(err.message)
    return ctx.reply("Error generating access link.")
  }
}

  // ❌ NOT PAID → SHOW PAYMENT
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


// 🔹 ADMIN STATS (SUPABASE)
bot.command('stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) {
    return ctx.reply("❌ Not authorized.")
  }

  try {
    const { data, error } = await supabase
      .from('payments')
      .select('*')

    if (error) {
      console.log(error)
      return ctx.reply("❌ Failed to fetch stats.")
    }

    if (!data || data.length === 0) {
      return ctx.reply("No payments yet.")
    }

    const totalRevenue = data.reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const totalUsers = new Set(data.map(p => p.user_id)).size

    const stripeCount = data.filter(p => p.method === 'stripe').length
    const paypalCount = data.filter(p => p.method === 'paypal').length

    const recent = data
      .slice(-5)
      .reverse()
      .map(p => `$${p.amount} (${p.method})`)
      .join('\n')

    await ctx.reply(
      `📊 Stats:\n\n` +
      `💰 Revenue: $${totalRevenue}\n` +
      `👥 Users: ${totalUsers}\n\n` +
      `💳 Stripe: ${stripeCount}\n` +
      `💰 PayPal: ${paypalCount}\n\n` +
      `🕒 Recent:\n${recent}`
    )

  } catch (err) {
    console.log(err)
    ctx.reply("❌ Error loading stats.")
  }
})

// 🔹 ACCESS COMMAND
bot.command('access', async (ctx) => {
  const userId = ctx.from.id

  const paid = await hasPaid(userId)

  if (!paid) {
    return ctx.reply("❌ You don’t have access yet. Please purchase first.")
  }

  const inGroup =
  testUsers.has(userId) ? false : await isUserInGroup(userId)

  if (inGroup) {
    return ctx.reply("✅ You already have access to the group.")
  }

  try {
    const link = await bot.telegram.createChatInviteLink(process.env.GROUP_ID, {
      member_limit: 1
    })

    return ctx.reply(`🔑 Your access link:\n${link.invite_link}`)
  } catch (err) {
    console.log(err.message)
    return ctx.reply("Error generating access link.")
  }
})

bot.command('test', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) {
    return ctx.reply("❌ Not authorized.")
  }

  testUsers.add(ctx.from.id)

  return ctx.reply("🧪 Test mode ENABLED\nYou are now treated as a paid user.")
})

bot.command('stoptest', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) {
    return ctx.reply("❌ Not authorized.")
  }

  testUsers.delete(ctx.from.id)

  return ctx.reply("🛑 Test mode DISABLED\nBack to normal behavior.")
})

// 🚀 START BOT
bot.launch()
console.log("Bot is running...")