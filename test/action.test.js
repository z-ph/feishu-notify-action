'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFlatYamlMap } = require('../src/tool/flatYaml');
const { inputsSchema, reviewRequestedEventSchema, payloadSchema, parseOrThrow } = require('../src/validate/schemas');
const { renderString, renderElements } = require('../src/assemble/templates');
const { assembleReviewRequest, assembleGenericMessage } = require('../src/assemble/reviewRequest');

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

test('generic: message lines plus detail link', () => {
  const lines = assembleGenericMessage('a\nb', 'https://x/1');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2], [{ tag: 'a', text: '查看详情', href: 'https://x/1' }]);
});
