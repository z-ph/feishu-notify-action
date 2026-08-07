const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');

const OPEN_ID_RE = /^ou_[0-9a-f]{32}$/;
const WEBHOOK_RE = /^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/.+/;

function requireInput(name, envName) {
  const value = process.env[envName];
  if (!value || !value.trim()) {
    throw new Error(`input "${name}" is required but empty (env ${envName} unset)`);
  }
  return value;
}

// Minimal flat YAML "key: value" parser — enough for the reviewer map,
// avoids pulling js-yaml into a dependency-free action.
// Malformed lines and invalid open_ids are config errors: throw, never skip.
function parseReviewerMap(src) {
  const map = {};
  if (!src || !src.trim()) return map;
  src.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error(`reviewer-map line ${i + 1} is not "login: open_id": ${line}`);
    }
    const login = line.slice(0, idx).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    // Strip quotes and trailing " # comment" (whitespace before #, per YAML).
    const openId = line.slice(idx + 1).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!login) throw new Error(`reviewer-map line ${i + 1}: empty GitHub login`);
    if (!OPEN_ID_RE.test(openId)) {
      throw new Error(`reviewer-map line ${i + 1}: "${openId}" is not a valid Feishu open_id (ou_ + 32 hex chars)`);
    }
    map[login] = openId;
  });
  return map;
}

// Structural validation of the outgoing post payload: every element must be
// a fully-formed tag Feishu can render. Throws on any violation.
function validatePayload(payload) {
  if (payload.msg_type !== 'post') throw new Error(`payload: unexpected msg_type "${payload.msg_type}"`);
  const post = payload.content && payload.content.post && payload.content.post.zh_cn;
  if (!post) throw new Error('payload: content.post.zh_cn missing');
  if (!Array.isArray(post.content) || post.content.length === 0) {
    throw new Error('payload: message content is empty (nothing to send)');
  }
  for (const line of post.content) {
    if (!Array.isArray(line) || line.length === 0) throw new Error('payload: empty content line');
    for (const el of line) {
      switch (el.tag) {
        case 'text':
          if (!el.text) throw new Error('payload: text element without text');
          break;
        case 'a':
          if (!el.text || !el.href) throw new Error(`payload: link element missing text/href: ${JSON.stringify(el)}`);
          break;
        case 'at':
          if (!OPEN_ID_RE.test(el.user_id) && el.user_id !== 'all') {
            throw new Error(`payload: at element with invalid user_id "${el.user_id}"`);
          }
          break;
        default:
          throw new Error(`payload: unsupported element tag "${el.tag}"`);
      }
    }
  }
}

function messageLines(message) {
  return message.split('\n').filter((line) => line.trim()).map((line) => [{ tag: 'text', text: line }]);
}

// Build notification content for a pull_request/review_requested event.
// GitHub dispatches one review_requested event per requested reviewer,
// so we mention only the reviewer this event is about — mentioning the full
// requested_reviewers list would re-ping everyone on every event.
function reviewRequestContent(event, reviewerMap) {
  if (event.action !== 'review_requested') return null;
  if (!event.pull_request) throw new Error('review_requested event without pull_request payload');
  const pr = event.pull_request;
  const reviewer = event.requested_reviewer;
  const team = event.requested_team;
  if (!reviewer && !team) {
    throw new Error('review_requested event without requested_reviewer/requested_team');
  }
  if (!pr.number || !pr.html_url) {
    throw new Error(`review_requested event with incomplete PR payload: number=${pr.number}, html_url=${pr.html_url}`);
  }

  const lines = [
    [
      { tag: 'a', text: `PR #${pr.number}`, href: pr.html_url },
      { tag: 'text', text: ` ${pr.title || ''}`.trimEnd() },
    ],
    [{ tag: 'text', text: `提交人：${pr.user && pr.user.login ? pr.user.login : 'unknown'}` }],
  ];

  if (reviewer) {
    const feishuId = reviewerMap[String(reviewer.login).toLowerCase()];
    if (feishuId) {
      lines.push([{ tag: 'at', user_id: feishuId, user_name: reviewer.login }, { tag: 'text', text: ' 请抽空评审，谢谢' }]);
    } else {
      console.log(`::warning::reviewer "${reviewer.login}" is not in reviewer-map, mention degraded to plain text`);
      lines.push([{ tag: 'text', text: `请 @${reviewer.login} 抽空评审，谢谢` }]);
    }
  } else {
    lines.push([{ tag: 'text', text: `请团队 ${team.slug || team.name} 抽空评审，谢谢` }]);
  }
  return { title: `请求代码评审：${pr.title || `PR #${pr.number}`}`, link: pr.html_url, lines };
}

(async () => {
  const webhook = requireInput('webhook', 'INPUT_WEBHOOK');
  if (!WEBHOOK_RE.test(webhook)) {
    throw new Error(`input "webhook" is not a Feishu custom bot webhook URL: ${webhook}`);
  }
  const secret = process.env.INPUT_SECRET || '';
  let title = process.env.INPUT_TITLE || '';
  const message = process.env.INPUT_MESSAGE || '';
  let link = process.env.INPUT_LINK || '';
  // GitHub converts input names to env vars replacing only SPACES:
  // input `reviewer-map` arrives as INPUT_REVIEWER-MAP (dash kept).
  const reviewerMap = parseReviewerMap(process.env['INPUT_REVIEWER-MAP']);

  if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is not set (not running in Actions?)');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));

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

  validatePayload(payload);
  console.log('Feishu payload:', JSON.stringify(payload));
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log('Feishu response:', JSON.stringify(body));
  if (body.code !== 0) throw new Error(`Feishu error: ${JSON.stringify(body)}`);
})().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
