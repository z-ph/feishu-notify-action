const { createHmac } = require('node:crypto');

(async () => {
  const webhook = process.env.INPUT_WEBHOOK;
  const secret = process.env.INPUT_SECRET || '';
  const payload = JSON.parse(process.env.INPUT_PAYLOAD);

  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`Feishu error: ${JSON.stringify(body)}`);
})();