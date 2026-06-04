const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wedkbwsijfikbkaqnugz.supabase.co/rest/v1';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

async function supaFetch(method, endpoint, body = null) {
  if (!SUPABASE_KEY) return null;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    Prefer: 'return=representation',
  };
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const resp = await axios({ method, url: `${SUPABASE_URL}/${endpoint}`, headers, data: body });
    return resp.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Supabase] ${method} ${endpoint} ERRO:`, detail);
    if (body) console.error('[Supabase] Body enviado:', JSON.stringify(body));
    return null;
  }
}

module.exports = { supaFetch };
