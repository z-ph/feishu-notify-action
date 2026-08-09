'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlatYamlMap } from '../src/tool/flatYaml.js';
import { inputsSchema, reviewRequestedEventSchema, payloadSchema, parseOrThrow } from '../src/validate/schemas.js';
import { renderString, renderElements } from '../src/assemble/templates.js';
import { assembleReviewRequest, assembleGenericMessage } from '../src/assemble/reviewRequest.js';
import feishuImage from '../src/tool/feishuImage.js';
import { parseImgTags, extractImgUrls, splitMentionElements } from '../src/assemble/reviewRequest.js';

const OPEN_ID = 'ou_6e9bdfd1f3c55ddbf412cd760716ee19';
const OPEN_ID_2 = 'ou_56071ba27060edd2b688c4d46f86200f';
const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc';

// ---- tool: flatYaml ----

test('flatYaml: parses entries, strips comments and quotes', () => {
  const map = parseFlatYamlMap(
    `# header\nCsmHt: ${OPEN_ID}   # 梁志宏\n'z-ph': "${OPEN_ID_2}"\n`,
    'reviewer-map',
  );
  assert.deepEqual(map, { CsmHt: OPEN_ID, 'z-ph': OPEN_ID_2 });
});

test('flatYaml: throws on malformed line, never skips', () => {
  assert.throws(() => parseFlatYamlMap('not-a-mapping', 'reviewer-map'), /line 1 is not "key: value"/);
});

test('flatYaml: empty input yields empty map', () => {
  assert.deepEqual(parseFlatYamlMap('', 'reviewer-map'), {});
  assert.deepEqual(parseFlatYamlMap(undefined, 'reviewer-map'), {});
});

// ---- validate: inputs ----

test('inputs: accepts minimal valid input', () => {
  const inputs = parseOrThrow(inputsSchema, { webhook: WEBHOOK }, 'inputs');
  assert.equal(inputs.reviewerMap && Object.keys(inputs.reviewerMap).length, 0);
});

test('inputs: rejects missing/non-Feishu webhook', () => {
  assert.throws(() => parseOrThrow(inputsSchema, { webhook: '' }, 'inputs'), /webhook/);
  assert.throws(() => parseOrThrow(inputsSchema, { webhook: 'https://example.com/hook' }, 'inputs'), /webhook/);
});

test('inputs: rejects invalid open_id values in reviewer map', () => {
  assert.throws(
    () => parseOrThrow(inputsSchema, { webhook: WEBHOOK, reviewerMap: { csmht: 'ou_short' } }, 'inputs'),
    /open_id/,
  );
});

// ---- validate: event ----

const baseEvent = {
  action: 'review_requested',
  requested_reviewer: { login: 'csmht' },
  pull_request: { number: 38, title: 'feat: x', html_url: 'https://github.com/a/b/pull/38', user: { login: 'z-ph' } },
};

test('event: accepts review_requested with reviewer', () => {
  const event = parseOrThrow(reviewRequestedEventSchema, baseEvent, 'event');
  assert.equal(event.requested_reviewer.login, 'csmht');
});

test('event: rejects when neither reviewer nor team present', () => {
  const { requested_reviewer, ...noReviewer } = baseEvent;
  assert.throws(() => parseOrThrow(reviewRequestedEventSchema, noReviewer, 'event'), /requested_reviewer/);
});

// ---- validate: payload ----

test('payload: rejects empty content and invalid elements', () => {
  assert.throws(
    () => parseOrThrow(payloadSchema, { msg_type: 'post', content: { post: { zh_cn: { content: [] } } } }, 'payload'),
    /empty/,
  );
  assert.throws(
    () =>
      parseOrThrow(
        payloadSchema,
        { msg_type: 'post', content: { post: { zh_cn: { content: [[{ tag: 'at', user_id: 'ou_bad' }]] } } } },
        'payload',
      ),
    /at|user_id/,
  );
});

// ---- assemble: templates ----

test('templates: unknown variable throws with available list', () => {
  assert.throws(() => renderString('hi {{nope}}', { a: '1' }), /unknown template variable.*a/);
  assert.throws(() => renderElements('{{nope}}', {}), /unknown template token/);
});

test('templates: renders string and element tokens', () => {
  assert.equal(renderString('PR #{{pr.number}}', { 'pr.number': '38' }), 'PR #38');
  const lines = renderElements('{{anchor}} by {{who}}', {
    anchor: () => [{ tag: 'a', text: 'PR #38', href: 'https://x/38' }],
    who: () => [{ tag: 'text', text: 'z-ph' }],
  });
  assert.deepEqual(lines, [[
    { tag: 'a', text: 'PR #38', href: 'https://x/38' },
    { tag: 'text', text: ' by ' },
    { tag: 'text', text: 'z-ph' },
  ]]);
});

// ---- assemble: review request ----

test('review: mention on + mapped reviewer produces at element', () => {
  const event = parseOrThrow(reviewRequestedEventSchema, baseEvent, 'event');
  const { title, lines } = assembleReviewRequest(event, { csmht: OPEN_ID }, {}, true);
  assert.equal(title, '请求代码评审：feat: x');
  assert.deepEqual(lines[2][0], { tag: 'at', user_id: OPEN_ID, user_name: 'csmht' });
  assert.deepEqual(lines[0][0], { tag: 'a', text: 'PR #38', href: 'https://github.com/a/b/pull/38' });
  // 组装结果必须能通过输出校验
  parseOrThrow(payloadSchema, { msg_type: 'post', content: { post: { zh_cn: { title, content: lines } } } }, 'payload');
});

test('review: mention on + unmapped reviewer throws, never degrades', () => {
  const event = parseOrThrow(reviewRequestedEventSchema, baseEvent, 'event');
  assert.throws(() => assembleReviewRequest(event, {}, {}, true), /enable-mention is on.*csmht.*missing/);
});

test('review: mention off renders no at element even with mapping', () => {
  const event = parseOrThrow(reviewRequestedEventSchema, baseEvent, 'event');
  const { lines } = assembleReviewRequest(event, { csmht: OPEN_ID }, {}, false);
  assert.ok(!lines.flat().some((el) => el.tag === 'at'));
});

test('review: team request renders team line', () => {
  const teamEvent = {
    action: 'review_requested',
    requested_team: { slug: 'backend', name: 'Backend' },
    pull_request: baseEvent.pull_request,
  };
  const event = parseOrThrow(reviewRequestedEventSchema, teamEvent, 'event');
  const { lines } = assembleReviewRequest(event, {}, {}, true);
  assert.match(lines[2][0].text, /backend/);
});

test('review: user templates override defaults', () => {
  const event = parseOrThrow(reviewRequestedEventSchema, baseEvent, 'event');
  const { title, lines } = assembleReviewRequest(
    event,
    { csmht: OPEN_ID },
    { title: '[评审] PR #{{pr.number}} by {{author}}', message: '{{mention}} 看下 {{pr.anchor}}' },
    true,
  );
  assert.equal(title, '[评审] PR #38 by z-ph');
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0].tag, 'at');
});

test('generic: message lines plus detail link', async () => {
  const lines = await assembleGenericMessage('a\nb', 'https://x/1');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2], [{ tag: 'a', text: '查看详情', href: 'https://x/1' }]);
});

// ---- assemble: img tag parsing ----


const GH_IMG = '<img width="2828" height="1496" alt="Image" src="https://github.com/user-attachments/assets/b83ae07d-7e66-4b7e-bd59-caf54a81d4d8" />';
const GH_IMG_URL = 'https://github.com/user-attachments/assets/b83ae07d-7e66-4b7e-bd59-caf54a81d4d8';

// 无 token 时降级为超链接
test('img: no token - single <img> becomes link element', async () => {
  const els = await parseImgTags(GH_IMG);
  assert.equal(els.length, 1);
  assert.deepEqual(els[0], { tag: 'a', text: '📷 图片', href: GH_IMG_URL });
});

test('img: no token - text before <img> preserved', async () => {
  const els = await parseImgTags(`看看这个截图 ${GH_IMG}`);
  assert.equal(els.length, 2);
  assert.deepEqual(els[0], { tag: 'text', text: '看看这个截图' });
  assert.deepEqual(els[1], { tag: 'a', text: '📷 图片', href: GH_IMG_URL });
});

test('img: no token - multiple <img> tags', async () => {
  const els = await parseImgTags(`${GH_IMG} 和 ${GH_IMG}`);
  assert.equal(els.length, 3);
  assert.deepEqual(els[0], { tag: 'a', text: '📷 图片', href: GH_IMG_URL });
  assert.deepEqual(els[1], { tag: 'text', text: '和' });
  assert.deepEqual(els[2], { tag: 'a', text: '📷 图片', href: GH_IMG_URL });
});

test('img: no <img> tag returns empty array', async () => {
  assert.deepEqual(await parseImgTags('普通文本'), []);
  assert.deepEqual(await parseImgTags(''), []);
});

test('img: no token - assembleGenericMessage produces link paragraph', async () => {
  const lines = await assembleGenericMessage(`评论内容\n${GH_IMG}`, 'https://x/1');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], [{ tag: 'text', text: '评论内容' }]);
  assert.deepEqual(lines[1], [{ tag: 'a', text: '📷 图片', href: GH_IMG_URL }]);
  assert.deepEqual(lines[2], [{ tag: 'a', text: '查看详情', href: 'https://x/1' }]);
  parseOrThrow(payloadSchema, { msg_type: 'post', content: { post: { zh_cn: { content: lines } } } }, 'payload');
});

test('img: single-quoted src attribute also parsed', async () => {
  const els = await parseImgTags(`<img src='https://example.com/img.png' alt='pic' />`);
  assert.equal(els.length, 1);
  assert.deepEqual(els[0], { tag: 'a', text: '📷 图片', href: 'https://example.com/img.png' });
});

test('img: <img> without src returns empty (not parsed)', async () => {
  const els = await parseImgTags('<img alt="no src" />');
  assert.equal(els.length, 0);
});

// 有 token 时上传图片，返回 img 元素
// 用 mock 替换 downloadAndUpload，避免真实网络请求
const origDownloadAndUpload = feishuImage.downloadAndUpload;

function mockDownloadAndUpload(imageKey) {
  feishuImage.downloadAndUpload = async (url) => imageKey;
}

function restoreDownloadAndUpload() {
  feishuImage.downloadAndUpload = origDownloadAndUpload;
}

test('img: with token - single <img> becomes img element with image_key', async () => {
  mockDownloadAndUpload('img_v3_mock_key_001');
  try {
    const els = await parseImgTags(GH_IMG, 'fake-token');
    assert.equal(els.length, 1);
    assert.deepEqual(els[0], { tag: 'img', image_key: 'img_v3_mock_key_001' });
  } finally {
    restoreDownloadAndUpload();
  }
});

test('img: with token - text before <img> preserved + img element', async () => {
  mockDownloadAndUpload('img_v3_mock_key_002');
  try {
    const els = await parseImgTags(`看看这个截图 ${GH_IMG}`, 'fake-token');
    assert.equal(els.length, 2);
    assert.deepEqual(els[0], { tag: 'text', text: '看看这个截图' });
    assert.deepEqual(els[1], { tag: 'img', image_key: 'img_v3_mock_key_002' });
  } finally {
    restoreDownloadAndUpload();
  }
});

test('img: with token - multiple <img> tags each get distinct image_key', async () => {
  let callCount = 0;
  feishuImage.downloadAndUpload = async (url) => {
    callCount++;
    return `img_v3_mock_key_${callCount}`;
  };
  try {
    const els = await parseImgTags(`${GH_IMG} 和 ${GH_IMG}`, 'fake-token');
    assert.equal(els.length, 3);
    assert.deepEqual(els[0], { tag: 'img', image_key: 'img_v3_mock_key_1' });
    assert.deepEqual(els[1], { tag: 'text', text: '和' });
    assert.deepEqual(els[2], { tag: 'img', image_key: 'img_v3_mock_key_2' });
  } finally {
    restoreDownloadAndUpload();
  }
});

test('img: with token - assembleGenericMessage produces img paragraph + passes payload validation', async () => {
  mockDownloadAndUpload('img_v3_mock_key_003');
  try {
    const lines = await assembleGenericMessage(`评论内容\n${GH_IMG}`, 'https://x/1', 'fake-token');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0], [{ tag: 'text', text: '评论内容' }]);
    assert.deepEqual(lines[1], [{ tag: 'img', image_key: 'img_v3_mock_key_003' }]);
    assert.deepEqual(lines[2], [{ tag: 'a', text: '查看详情', href: 'https://x/1' }]);
    parseOrThrow(payloadSchema, { msg_type: 'post', content: { post: { zh_cn: { content: lines } } } }, 'payload');
  } finally {
    restoreDownloadAndUpload();
  }
});

test('img: extractImgUrls returns all src URLs', () => {
  const urls = extractImgUrls(`${GH_IMG} middle ${GH_IMG}`);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], GH_IMG_URL);
  assert.equal(urls[1], GH_IMG_URL);
});

// ---- assemble: generic-path @mention ----

const MENTION_MAP = { octocat: OPEN_ID, hubot: OPEN_ID_2 };

test('mention: mapped @login becomes at element, CJK prefix preserved', () => {
  const els = splitMentionElements('提交人：@octocat', MENTION_MAP);
  assert.deepEqual(els, [
    { tag: 'text', text: '提交人：' },
    { tag: 'at', user_id: OPEN_ID, user_name: 'octocat' },
  ]);
});

test('mention: unmapped @login stays plain text, merged with surroundings', () => {
  const els = splitMentionElements('cc @stranger 和 @ghost 看一下', MENTION_MAP);
  assert.deepEqual(els, [{ tag: 'text', text: 'cc @stranger 和 @ghost 看一下' }]);
});

test('mention: undefined map (mention disabled) returns original text untouched', () => {
  const els = splitMentionElements('提交人：@octocat', undefined);
  assert.deepEqual(els, [{ tag: 'text', text: '提交人：@octocat' }]);
});

test('mention: email-like foo@bar is not treated as a mention', () => {
  const els = splitMentionElements('联系 foo@hubot.com 咨询', MENTION_MAP);
  assert.deepEqual(els, [{ tag: 'text', text: '联系 foo@hubot.com 咨询' }]);
});

test('mention: @org/team team mention stays literal', () => {
  const els = splitMentionElements('@octocat/team 看一下', MENTION_MAP);
  assert.deepEqual(els, [{ tag: 'text', text: '@octocat/team 看一下' }]);
});

test('mention: multiple mentions in one line, lookup case-insensitive', () => {
  const els = splitMentionElements('@OctoCat 和 @hubot', MENTION_MAP);
  assert.deepEqual(els, [
    { tag: 'at', user_id: OPEN_ID, user_name: 'OctoCat' },
    { tag: 'text', text: ' 和 ' },
    { tag: 'at', user_id: OPEN_ID_2, user_name: 'hubot' },
  ]);
});

test('mention: trailing punctuation not swallowed into login', () => {
  const els = splitMentionElements('@octocat, 请看', MENTION_MAP);
  assert.deepEqual(els, [
    { tag: 'at', user_id: OPEN_ID, user_name: 'octocat' },
    { tag: 'text', text: ', 请看' },
  ]);
});

test('mention: assembleGenericMessage converts body @mentions + passes payload validation', async () => {
  const lines = await assembleGenericMessage(
    '@reviewer 评论：\n@octocat 看一下这个改动\ncc @stranger',
    'https://x/1',
    '',
    undefined,
    MENTION_MAP,
  );
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], [{ tag: 'text', text: '@reviewer 评论：' }]);
  assert.deepEqual(lines[1], [
    { tag: 'at', user_id: OPEN_ID, user_name: 'octocat' },
    { tag: 'text', text: ' 看一下这个改动' },
  ]);
  assert.deepEqual(lines[2], [{ tag: 'text', text: 'cc @stranger' }]);
  assert.deepEqual(lines[3], [{ tag: 'a', text: '查看详情', href: 'https://x/1' }]);
  parseOrThrow(payloadSchema, { msg_type: 'post', content: { post: { zh_cn: { content: lines } } } }, 'payload');
});

test('mention: mention before <img> converted, img link preserved (no token)', async () => {
  const lines = await assembleGenericMessage(`@octocat 看图\n${GH_IMG}`, '', '', undefined, MENTION_MAP);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], [
    { tag: 'at', user_id: OPEN_ID, user_name: 'octocat' },
    { tag: 'text', text: ' 看图' },
  ]);
  assert.deepEqual(lines[1], [{ tag: 'a', text: '📷 图片', href: GH_IMG_URL }]);
});
