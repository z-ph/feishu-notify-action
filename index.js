const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');

// Minimal flat YAML "key: value" parser — enough for the reviewer map,
// avoids pulling js-yaml into a dependency-free action.
function parseReviewerMap(src) {
  const map = {};
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    // Strip quotes and trailing " # comment" (whitespace before #, per YAML).
    const value = line.slice(idx + 1).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (key && value) map[key] = value;
  }
  return map;
}

function messageLines(message) {
  return message.split('\n').filter((line) => line.trim()).map((line) => [{ tag: 'text', text: line }]);
}

// Build notification content for a pull_request/review_requested event.
// GitHub dispatches one review_requested event per requested reviewer,
// so we mention only the reviewer this event is about — mentioning the full
// requested_reviewers list would re-ping everyone on every event.
// Returns null when the event is not a reviewer assignment.
function reviewRequestContent(event, reviewerMap) {
  if (event.action !== 'review_requested' || !event.pull_request) return null;
  const pr = event.pull_request;
  const reviewer = event.requested_reviewer;
  const team = event.requested_team;
  if (!reviewer && !team) return null;

  const lines = [
    [
      { tag: 'a', text: `PR #${pr.number}`, href: pr.html_url },
      { tag: 'text', text: ` ${pr.title || ''}`.trimEnd() },
    ],
    [{ tag: 'text', text: `提交人：${pr.user && pr.user.login ? pr.user.login : 'unknown'}` }],
  ];

  if (reviewer) {
    const feishuId = reviewerMap[String(reviewer.login).toLowerCase()];
    lines.push(
      feishuId
        ? [{ tag: 'at', user_id: feishuId, user_name: reviewer.login }, { tag: 'text', text: ' 请抽空评审，谢谢' }]
        : [{ tag: 'text', text: `请 @${reviewer.login} 抽空评审，谢谢` }],
    );
  } else {
    lines.push([{ tag: 'text', text: `请团队 ${team.slug || team.name} 抽空评审，谢谢` }]);
  }
  return { title: `请求代码评审：${pr.title || `PR #${pr.number}`}`, link: pr.html_url || '', lines };
}

(async () => {
  const webhook = process.env.INPUT_WEBHOOK;
  if (!webhook) {
    console.log('No webhook configured, skipping');
    return;
  }
  const secret = process.env.INPUT_SECRET || '';
  let title = process.env.INPUT_TITLE || '';
  const message = process.env.INPUT_MESSAGE || '';
  let link = process.env.INPUT_LINK || '';
  const reviewerMap = parseReviewerMap(process.env.INPUT_REVIEWER_MAP || '');

  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};

  let content;
  const review = reviewRequestContent(event, reviewerMap);
  if (review) {
    // Explicit title/message still override the composed defaults.
    title = title || review.title;
    link = link || review.link;
    content = message ? messageLines(message) : review.lines;
  } else {
    content = message ? messageLines(message) : [];
  }
  if (link) content.push([{ tag: 'a', text: '查看详情', href: link }]);

  const payload = { msg_type: 'post', content: { post: { zh_cn: { content } } } };
  if (title) payload.content.post.zh_cn.title = title;

  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  }

  console.log('Feishu payload:', JSON.stringify(payload));
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log('Feishu response:', JSON.stringify(body));
  if (body.code !== 0) throw new Error(`Feishu error: ${JSON.stringify(body)}`);
})();
