const { createHmac } = require('node:crypto');

(async () => {
  const webhook = process.env.INPUT_WEBHOOK;
  const secret = process.env.INPUT_SECRET || '';
  const title = process.env.INPUT_TITLE || '';
  const message = process.env.INPUT_MESSAGE || '';
  const link = process.env.INPUT_LINK || '';

  const content = message
    ? message.split('\n').filter((line) => line.trim()).map((line) => [{ tag: 'text', text: line }])
    : [];
  if (link) content.push([{ tag: 'a', text: '查看详情', href: link }]);

  const payload = { msg_type: 'post', content: { post: { zh_cn: { content } } } };
  if (title) payload.content.post.zh_cn.title = title;

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