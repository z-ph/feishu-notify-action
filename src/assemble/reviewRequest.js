'use strict';

const { renderString, renderElements } = require('./templates');

// 装配层：把 review_requested 事件 + reviewer 映射 + 用户模板组装成通知内容。
// GitHub 对每个被指定的 reviewer 分别派发事件，因此只 @ 本事件的那个人——
// @ 全量 requested_reviewers 会在多评审人场景重复轰炸。

const DEFAULT_TITLE_TEMPLATE = '请求代码评审：{{pr.title}}';
const DEFAULT_MESSAGE_TEMPLATE = [
  '{{pr.anchor}} {{pr.title}}',
  '提交人：{{author}}',
  '{{mention}} 请抽空评审，谢谢',
].join('\n');

function assembleReviewRequest(event, reviewerMap, templates) {
  const pr = event.pull_request;
  const reviewer = event.requested_reviewer;
  const team = event.requested_team;
  const author = pr.user.login;
  const prAnchor = `PR #${pr.number}`;

  // mention：命中映射 → at 元素；未命中 → 文本降级 + 显式 warning；团队 → 团队名文本。
  const mention = () => {
    if (reviewer) {
      const openId = reviewerMap[reviewer.login.toLowerCase()];
      if (openId) return [{ tag: 'at', user_id: openId, user_name: reviewer.login }];
      console.log(`::warning::reviewer "${reviewer.login}" is not in reviewer-map, mention degraded to plain text`);
      return [{ tag: 'text', text: `@${reviewer.login}` }];
    }
    return [{ tag: 'text', text: `团队 ${team.slug || team.name}` }];
  };

  const stringVars = {
    'pr.number': String(pr.number),
    'pr.title': pr.title,
    'pr.url': pr.html_url,
    author,
    reviewer: reviewer ? reviewer.login : '',
    team: team ? team.slug || team.name : '',
  };

  const resolvers = {
    ...Object.fromEntries(Object.entries(stringVars).map(([k, v]) => [k, () => [{ tag: 'text', text: v }]])),
    'pr.anchor': () => [{ tag: 'a', text: prAnchor, href: pr.html_url }],
    mention,
  };

  return {
    title: renderString(templates.title || DEFAULT_TITLE_TEMPLATE, stringVars),
    lines: renderElements(templates.message || DEFAULT_MESSAGE_TEMPLATE, resolvers),
  };
}

// 通用路径：显式 message 一行一段，link 追加为 "查看详情" 超链接。
function assembleGenericMessage(message, link) {
  const lines = message
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => [{ tag: 'text', text: line }]);
  if (link) lines.push([{ tag: 'a', text: '查看详情', href: link }]);
  return lines;
}

module.exports = { assembleReviewRequest, assembleGenericMessage };
