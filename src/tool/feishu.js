'use strict';

import { createHmac } from 'crypto';
// Tool 层：飞书自定义机器人 webhook 通信。

// 官方签名算法：HMAC-SHA256，key 为 `${timestamp}\n${secret}`，对空串签名后 base64。
function signPayload(payload, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    ...payload,
    timestamp,
    sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64'),
  };
}

async function sendToFeishu(webhook, payload) {
  console.log('Feishu payload:', JSON.stringify(payload));
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log('Feishu response:', JSON.stringify(body));
  if (body.code !== 0) {
    throw new Error(`Feishu webhook rejected the message: ${JSON.stringify(body)}`);
  }
  return body;
}

export { signPayload, sendToFeishu };
