const { Inngest } = require('inngest');

const inngest = new Inngest({
  id: 'suno-api-lite',
  // INNGEST_EVENT_KEY é lido automaticamente do process.env.INNGEST_EVENT_KEY
  // INNGEST_SIGNING_KEY é lido automaticamente do process.env.INNGEST_SIGNING_KEY
});

module.exports = { inngest };
