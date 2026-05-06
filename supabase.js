require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

// =========================
// 🔑 SHARED SUPABASE CLIENT
// =========================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

// =========================
// 🔁 RETRY HELPER
// =========================
async function withRetry(fn, label = 'Supabase query', retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { data, error } = await fn()

    if (!error) return { data, error: null }

    console.log(`❌ ${label} failed (attempt ${attempt}/${retries}):`, error.message, '| code:', error.code)

    if (attempt < retries) {
      await new Promise(res => setTimeout(res, 200 * Math.pow(2, attempt - 1)))
    } else {
      return { data: null, error }
    }
  }
}

// =========================
// 💾 SUPABASE HELPERS
// =========================

/**
 * Check if a user has a payment record.
 * Returns true/false, or throws on unrecoverable error.
 */
async function checkPayment(userId) {
  const { data, error } = await withRetry(
    () => supabase
      .from('payments')
      .select('user_id')
      .eq('user_id', String(userId))
      .limit(1),
    `checkPayment(userId=${userId})`
  )

  if (error) throw error

  if (!Array.isArray(data)) {
    console.log('⚠️ checkPayment(): unexpected data shape:', data)
    return false
  }

  return data.length > 0
}

/**
 * Check if a payment_id already exists in the DB.
 * Returns true/false, or throws on unrecoverable error.
 */
async function paymentExists(paymentId) {
  const { data, error } = await withRetry(
    () => supabase
      .from('payments')
      .select('payment_id')
      .eq('payment_id', paymentId)
      .limit(1),
    `paymentExists(paymentId=${paymentId})`
  )

  if (error) {
    console.log('❌ paymentExists() unrecoverable error | paymentId:', paymentId, '| code:', error.code)
    throw error
  }

  if (!Array.isArray(data)) {
    console.log('⚠️ paymentExists(): unexpected data shape:', data)
    return false
  }

  return data.length > 0
}

/**
 * Insert a new payment record.
 * Returns true on success, false on failure.
 */
async function savePayment({ userId, amount, method, paymentId }) {
  const { error } = await withRetry(
    () => supabase
      .from('payments')
      .insert([{
        user_id: String(userId),
        amount: Number(amount),
        method,
        payment_id: paymentId
      }]),
    `savePayment(userId=${userId}, method=${method}, paymentId=${paymentId})`
  )

  if (error) {
    console.log('❌ savePayment() unrecoverable error | userId:', userId, '| method:', method, '| paymentId:', paymentId, '| code:', error.code)
    return false
  }

  console.log('✅ Saved to Supabase')
  return true
}

/**
 * Return the total count of payment records.
 * Returns a number, or throws on unrecoverable error.
 */
async function getPaymentCount() {
  const { data, error } = await withRetry(
    () => supabase.from('payments').select('*'),
    'getPaymentCount()'
  )

  if (error) throw error

  if (!Array.isArray(data)) {
    console.log('⚠️ getPaymentCount(): unexpected data shape:', data)
    return 0
  }

  return data.length
}

module.exports = { supabase, checkPayment, paymentExists, savePayment, getPaymentCount }
