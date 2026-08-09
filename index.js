'use strict';

import { readFileSync } from 'node:fs';
import { parseFlatYamlMap } from './src/tool/flatYaml.js';
import { signPayload, sendToFeishu } from './src/tool/feishu.js';
import feishuImage from './src/tool/feishuImage.js';
import { buildImageUrlResolver } from './src/tool/githubImage.js';
import { inputsSchema, reviewRequestedEventSchema, payloadSchema, parseOrThrow } from './src/validate/schemas.js';
import { assembleReviewRequest, assembleGenericMessage } from './src/assemble/reviewRequest.js';

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
      enableMention: process.env['INPUT_ENABLE-MENTION'],
      titleTemplate: process.env['INPUT_TITLE-TEMPLATE'] || '',
      messageTemplate: process.env['INPUT_MESSAGE-TEMPLATE'] || '',
      appId: process.env['INPUT_APP-ID'] || '',
      appSecret: process.env['INPUT_APP-SECRET'] || '',
      githubToken: process.env['INPUT_GITHUB-TOKEN'] || '',
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

  // 有 app-id + app-secret 时获取 tenant_access_token，用于上传图片。
  let token = '';
  if (inputs.appId && inputs.appSecret) {
    token = await feishuImage.getTenantAccessToken(inputs.appId, inputs.appSecret);
  }

  let title;
  let content;
  if (event.action === 'review_requested') {
    // review_requested 只走模板组装,title/message/link 输入在此模式下无意义。
    const reviewEvent = parseOrThrow(reviewRequestedEventSchema, event, 'review_requested event');
    const review = assembleReviewRequest(
      reviewEvent,
      inputs.reviewerMap,
      { title: inputs.titleTemplate, message: inputs.messageTemplate },
      inputs.enableMention,
    );
    title = review.title;
    content = review.lines;
  } else {
    // enable-mention 在通用路径的语义：message 里的 @GitHub登录名 经 reviewer-map
    // 转换为飞书 @ 元素；未命中映射的保持纯文本（评论正文是用户内容，见 assemble 层）。
    // 但开启 mention 却给空映射是配置错误，直接抛错（与 review_requested 路径一致）。
    if (inputs.enableMention && Object.keys(inputs.reviewerMap).length === 0) {
      throw new Error('enable-mention is on but reviewer-map is empty — add mappings or turn enable-mention off');
    }
    const mentionMap = inputs.enableMention ? inputs.reviewerMap : undefined;
    // 有 github-token 时，message 里的私有仓库 user-attachments 图片
    // 先经 API body_html 解析为签名直链再下载（直访私有附件恒 404）。
    const resolveUrl = inputs.githubToken
      ? buildImageUrlResolver({ event, githubToken: inputs.githubToken })
      : undefined;
    title = inputs.title;
    content = await assembleGenericMessage(inputs.message, inputs.link, token, resolveUrl, mentionMap);
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
