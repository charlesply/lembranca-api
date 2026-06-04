const axios = require('axios');
const cookie = require('cookie');
const UserAgent = require('user-agents');
const crypto = require('crypto');

class SunoClient {
  static BASE_URL = 'https://studio-api-prod.suno.com';
  static CLERK_URL = 'https://auth.suno.com';
  static CLERK_VERSION = '5.117.0';

  constructor(cookieStr) {
    this.cookies = cookie.parse(cookieStr || '');
    this.userAgent = new UserAgent(/Macintosh/).random().toString();
    this.deviceId = this.cookies.ajs_anonymous_id || crypto.randomUUID();
    this.sid = null;
    this.token = null;
    this.tokenExpiry = 0;

    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'User-Agent': this.userAgent,
      }
    });

    // Auto-attach token + cookies to every request
    this.client.interceptors.request.use(config => {
      if (this.token && !config.headers.Authorization) {
        config.headers.Authorization = `Bearer ${this.token}`;
      }
      const cookieStr = Object.entries(this.cookies)
        .map(([k, v]) => cookie.serialize(k, v))
        .join('; ');
      config.headers.Cookie = cookieStr;
      return config;
    });

    // Auto-save returned cookies
    this.client.interceptors.response.use(resp => {
      const setCookie = resp.headers['set-cookie'];
      if (Array.isArray(setCookie)) {
        const newCookies = cookie.parse(setCookie.join('; '));
        Object.assign(this.cookies, newCookies);
      }
      return resp;
    });
  }

  async init() {
    console.log('[SunoClient] Inicializando...');
    await this.getAuthToken();
    await this.keepAlive();
    console.log('[SunoClient] ✅ Pronto! SID:', this.sid);

    // Renovar token a cada 30s
    setInterval(() => this.keepAlive().catch(e => console.error('[keepAlive]', e.message)), 30000);
    return this;
  }

  async getAuthToken() {
    const url = `${SunoClient.CLERK_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoClient.CLERK_VERSION}`;
    const resp = await this.client.get(url, {
      headers: { Authorization: this.cookies.__client }
    });
    const sid = resp.data?.response?.last_active_session_id;
    if (!sid) throw new Error('Falha ao obter session ID. Atualize SUNO_COOKIE.');
    this.sid = sid;
    console.log('[SunoClient] Session ID:', sid);
  }

  async keepAlive() {
    if (!this.sid) throw new Error('Session ID não definido');
    const url = `${SunoClient.CLERK_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoClient.CLERK_VERSION}`;
    const resp = await this.client.post(url, {}, {
      headers: { Authorization: this.cookies.__client }
    });
    this.token = resp.data.jwt;
    this.tokenExpiry = Date.now() + 55000;
    console.log('[SunoClient] Token renovado');
  }

  async ensureToken(force = false) {
    if (force || !this.token || Date.now() > this.tokenExpiry) {
      await this.keepAlive();
    }
  }

  getBrowserToken() {
    const ts = Date.now();
    const btPayload = JSON.stringify({ timestamp: ts });
    const btB64 = Buffer.from(btPayload).toString('base64');
    return JSON.stringify({ token: btB64 });
  }

  // Retry com backoff exponencial para 422/429
  async retryPost(url, payload, headers, maxRetries = 4) {
    const delays = [5000, 15000, 30000, 60000]; // 5s, 15s, 30s, 60s
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = delays[Math.min(attempt - 1, delays.length - 1)];
          console.log(`[SunoClient] ⏳ Retry ${attempt}/${maxRetries} em ${delay/1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          // Renovar token antes de tentar de novo
          await this.ensureToken(true);
          // Atualizar browser-token
          if (headers['browser-token']) {
            headers['browser-token'] = this.getBrowserToken();
          }
        }
        return await this.client.post(url, payload, { headers });
      } catch (err) {
        const status = err.response?.status;
        const errType = err.response?.data?.error_type || '';
        console.error(`[SunoClient] ❌ Tentativa ${attempt + 1}: ${status} ${errType}`);
        lastErr = err;
        // Só retry em 422 (token_validation) ou 429 (rate limit)
        if (status !== 422 && status !== 429) throw err;
      }
    }
    throw lastErr;
  }

  // =================== API ENDPOINTS ===================

  async getLimit() {
    await this.ensureToken();
    const resp = await this.client.get(`${SunoClient.BASE_URL}/api/billing/info/`);
    return {
      credits_left: resp.data.total_credits_left,
      monthly_limit: resp.data.monthly_limit,
      monthly_usage: resp.data.monthly_usage,
      period: resp.data.period,
    };
  }

  async customGenerate({ prompt, tags, title, model, make_instrumental, negative_tags, vocal_gender, wait_audio, weirdness, style_weight }) {
    await this.ensureToken();
    const crypto = require('crypto');

    // v5.5 (chirp-fenix): vocal_gender e weirdness vão DENTRO de metadata.
    // No top-level o Suno IGNORA silenciosamente e usa default.
    const _vg = (['male', 'm', 'Masculino', 'masculino'].includes(vocal_gender)) ? 'm'
              : (['female', 'f', 'Feminino', 'feminino'].includes(vocal_gender)) ? 'f' : null;
    const _norm = v => { if (v == null) return null; const n = Number(v); if (Number.isNaN(n)) return null; return n > 1 ? n / 100 : n; };
    const _weird = _norm(weirdness) ?? 0.50;
    const _sw = _norm(style_weight);
    // Sertanejo SEMPRE com Violão: "Sertanejo, Feliz, ..." -> "Sertanejo, Violão, Feliz, ..."
    let _tags = tags;
    if (_tags && /sertanej/i.test(_tags) && !/viol[ãa]o/i.test(_tags)) _tags = _tags.replace(/(sertanej[^,]*)/i, '$1, Violão');

    const payload = {
      token: null,
      generation_type: 'TEXT',
      title: title || '',
      tags: _tags || '',
      negative_tags: negative_tags || '',
      mv: model || process.env.SUNO_MODEL || 'chirp-crow',
      prompt: prompt || '',
      make_instrumental: make_instrumental || false,
      user_uploaded_images_b64: null,
      metadata: {
        web_client_pathname: '/create',
        is_max_mode: false,
        is_mumble: false,
        create_mode: 'custom',
        user_tier: '3eaebef3-ef46-446a-931c-3d50cd1514f1',
        create_session_token: crypto.randomUUID(),
        disable_volume_normalization: false,
        control_sliders: {
          weirdness_constraint: _weird,
          ...(_sw != null ? { style_weight: _sw } : {}),
        },
        ...(_vg ? { vocal_gender: _vg } : {}),
      },
      override_fields: [],
      cover_clip_id: null,
      cover_start_s: null,
      cover_end_s: null,
      persona_id: null,
      artist_clip_id: null,
      artist_start_s: null,
      artist_end_s: null,
      continue_clip_id: null,
      continued_aligned_prompt: null,
      continue_at: null,
      transaction_uuid: crypto.randomUUID(),
      token_provider: null,
    };

    console.log('[SunoClient] Gerando música customizada:', { title, tags, model, vocal_gender: _vg, weirdness: _weird });
    const resp = await this.retryPost(
      `${SunoClient.BASE_URL}/api/generate/v2-web/`,
      payload,
      { 'browser-token': this.getBrowserToken(), 'Origin': 'https://suno.com', 'Referer': 'https://suno.com/create' }
    );
    
    const clips = resp.data.clips || [];
    console.log(`[SunoClient] ✅ ${clips.length} clips gerados`);

    if (wait_audio && clips.length > 0) {
      return await this.waitForClips(clips.map(c => c.id));
    }

    return clips.map(c => ({
      id: c.id,
      title: c.title,
      status: c.status,
      audio_url: c.audio_url || '',
      video_url: c.video_url || '',
      image_url: c.image_large_url || c.image_url || '',
      lyric: c.metadata?.prompt || '',
      model_name: c.model_name || model,
      created_at: c.created_at,
      tags: c.metadata?.tags || tags,
      duration: c.metadata?.duration_formatted || '',
    }));
  }

  async generate({ prompt, model, make_instrumental, wait_audio }) {
    await this.ensureToken();
    
    const payload = {
      gpt_description_prompt: prompt || '',
      mv: model || 'chirp-v3-5',
      make_instrumental: make_instrumental || false,
      prompt: '',
      generation_type: 'TEXT',
    };

    console.log('[SunoClient] Gerando música por descrição:', { prompt });
    const resp = await this.retryPost(
      `${SunoClient.BASE_URL}/api/generate/v2-web/`,
      payload,
      { 'browser-token': this.getBrowserToken(), 'Origin': 'https://suno.com', 'Referer': 'https://suno.com/create' }
    );
    const clips = resp.data.clips || [];

    if (wait_audio && clips.length > 0) {
      return await this.waitForClips(clips.map(c => c.id));
    }

    return clips;
  }

  async getClips(ids) {
    await this.ensureToken();
    const idsParam = Array.isArray(ids) ? ids.join(',') : ids;
    const resp = await this.client.get(`${SunoClient.BASE_URL}/api/feed/?ids=${idsParam}`);
    return resp.data.map(c => ({
      id: c.id,
      title: c.title,
      status: c.status,
      audio_url: c.audio_url || '',
      video_url: c.video_url || '',
      image_url: c.image_large_url || c.image_url || '',
      lyric: c.metadata?.prompt || '',
      model_name: c.model_name || '',
      created_at: c.created_at,
      tags: c.metadata?.tags || '',
      duration: c.metadata?.duration_formatted || '',
      error_message: c.metadata?.error_message || '',
    }));
  }

  async waitForClips(clipIds, maxWait = 300) {
    const start = Date.now();
    console.log(`[SunoClient] Aguardando ${clipIds.length} clips ficarem prontos...`);
    
    while ((Date.now() - start) / 1000 < maxWait) {
      const clips = await this.getClips(clipIds);
      const allDone = clips.every(c => c.status === 'complete' || c.status === 'error');
      
      if (allDone) {
        console.log('[SunoClient] ✅ Todos os clips prontos!');
        return clips;
      }
      
      const statuses = clips.map(c => `${c.id.slice(0,8)}: ${c.status}`).join(', ');
      console.log(`[SunoClient] ⏳ ${statuses}`);
      await new Promise(r => setTimeout(r, 10000));
    }
    
    // Timeout - retorna o que tem
    return await this.getClips(clipIds);
  }
}

module.exports = SunoClient;
