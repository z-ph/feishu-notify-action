'use strict';

const { readFileSync } = require('node:fs');
const { parseFlatYamlMap } = require('./src/tool/flatYaml');
const { signPayload, sendToFeishu } = require('./src/tool/feishu');
const { inputsSchema, reviewRequestedEventSchema, payloadSchema, parseOrThrow } = require('./src/validate/schemas');
const { assembleReviewRequest, assembleGenericMessage } = require('./src/assemble/reviewRequest');

// 入口：tool 层读原始输入 → validate 层校验 → assemble 层组装 → validate 层校验输出 → tool 层发送。
// 校验失败一律抛错（::error:: + exit 1），不做任何静默兜底。

function readInputs() {
  // GitHub 把输入名转环境变量时只替换空格不替换连字符：
  // 输入 `reviewer-map` 到达时为 INPUT_REVIEWER-MAP。
  const rawMap = parseFlatYamlMap(process.env['INPUT_REVIEWER-MAP'], 'reviewer-map');
  return parseOrThrow(
    inputsSchema,
    {
      webhook: process.env.INPUT_WEBHOOK || '',
      secret: process.env.INPUT_SECRET || '',
      title: process.env.INPUT_TITLE || '',
      message: process.env.INPUT_MESSAGE || '',
      link: process.env.INPUT_LINK || '',
      reviewerMap: rawMap,
      titleTemplate: process.env['INPUT_TITLE-TEMPLATE'] || '',
      messageTemplate: process.env['INPUT_MESSAGE-TEMPLATE'] || '',
    },
    'inputs',
  );
}

function readEvent() {
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is not set (not running in Actions?)');
  return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
}

(async () => {
  const inputs = readInputs();
  const event = readEvent();

  let title;
  let content;
  if (event.action === 'review_requested') {
    // review_requested 只走模板组装,title/message/link 输入在此模式下无意义。
    const reviewEvent = parseOrThrow(reviewRequestedEventSchema, event, 'review_requested event');
    const review = assembleReviewRequest(reviewEvent, inputs.reviewerMap, {
      title: inputs.titleTemplate,
      message: inputs.messageTemplate,
    });
    title = review.title;
    content = review.lines;
  } else {
    title = inputs.title;
    content = assembleGenericMessage(inputs.message, inputs.link);
  }

  const unsigned = { msg_type: 'post', content: { post: { zh_cn: { content } } } };
  if (title) unsigned.content.post.zh_cn.title = title;
  const payload = inputs.secret ? signPayload(unsigned, inputs.secret) : unsigned;

  parseOrThrow(payloadSchema, payload, 'outgoing payload');
  await sendToFeishu(inputs.webhook, payload);
})().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
