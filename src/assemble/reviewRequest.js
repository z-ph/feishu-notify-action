'use strict';

const { renderString, renderElements } = require('./templates');
const feishuImage = require('../tool/feishuImage');

// 装配层：把 review_requested 事件 + reviewer 映射 + 用户模板组装成通知内容。
// GitHub 对每个被指定的 reviewer 分别派发事件，因此只 @ 本事件的那个人——
// @ 全量 requested_reviewers 会在多评审人场景重复轰炸。

const DEFAULT_TITLE_TEMPLATE = '请求代码评审：{{pr.title}}';
const DEFAULT_MESSAGE_TEMPLATE = [
  '{{pr.anchor}} {{pr.title}}',
  '提交人：{{author}}',
  '{{mention}} 请抽空评审，谢谢',
].join('\n');

function assembleReviewRequest(event, reviewerMap, templates, enableMention) {
  const pr = event.pull_request;
  const reviewer = event.requested_reviewer;
  const team = event.requested_team;
  const author = pr.user.login;
  const prAnchor = `PR #${pr.number}`;

  // mention 语义（无降级）：
  // - enable-mention=false → 空元素,卡片不出现 @;
  // - enable-mention=true → reviewer 必须在 reviewer-map 中,缺失即抛错;
  // - 团队评审 → 团队名文本(团队无法被 @,仅作信息展示)。
  const mention = () => {
    if (team) return [{ tag: 'text', text: `团队 ${team.slug || team.name}` }];
    if (!enableMention) return [];
    const openId = reviewerMap[reviewer.login.toLowerCase()];
    if (!openId) {
      throw new Error(
        `enable-mention is on but reviewer "${reviewer.login}" is missing from reviewer-map — add the mapping or turn enable-mention off`,
      );
    }
    return [{ tag: 'at', user_id: openId, user_name: reviewer.login }];
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

// 解析 GitHub 上传图片的 <img> 标签，下载图片并上传飞书，返回 img 元素。
// 飞书 webhook post 的 img 元素需要 image_key（先上传图片到飞书服务器）。
// 没有 app-id/app-secret 时，降级为「📷 图片」超链接（点击跳转原图）。
// 一个 <img> 标签生成一个独立段落。
const IMG_TAG_RE = /<img\s+[^>]*?src=["']([^"']+)["'][^>]*?\/?>/gi;

// 提取 <img> 标签中的图片 URL 列表。
function extractImgUrls(text) {
  return [...text.matchAll(IMG_TAG_RE)].map((m) => m[1]);
}

// 异步版：下载图片 -> 上传飞书 -> 返回 img 元素。
// 无 token 时降级为 a 超链接。
async function parseImgTags(text, token) {
  const matches = [...text.matchAll(IMG_TAG_RE)];
  if (matches.length === 0) return [];
  const elements = [];
  let last = 0;
  for (const match of matches) {
    // 标签前的文本（非空才入段）
    if (match.index > last && text.slice(last, match.index).trim()) {
      elements.push({ tag: 'text', text: text.slice(last, match.index).trim() });
    }
    const url = match[1];
    if (token) {
      const imageKey = await feishuImage.downloadAndUpload(url, token);
      elements.push({ tag: 'img', image_key: imageKey });
    } else {
      elements.push({ tag: 'a', text: '📷 图片', href: url });
    }
    last = match.index + match[0].length;
  }
  // 标签后的尾部文本
  if (last < text.length && text.slice(last).trim()) {
    elements.push({ tag: 'text', text: text.slice(last).trim() });
  }
  return elements;
}

// 通用路径：显式 message 一行一段，link 追加为 "查看详情" 超链接。
// message 中的 <img> 标签被解析为飞书 img 元素（需 token）或超链接（无 token 降级）。
async function assembleGenericMessage(message, link, token) {
  const lines = await Promise.all(
    message
      .split('\n')
      .map(async (line) => {
        if (!line.trim()) return null;
        const els = await parseImgTags(line, token);
        return els.length > 0 ? els : [{ tag: 'text', text: line }];
      }),
  );
  const filtered = lines.filter(Boolean);
  if (link) filtered.push([{ tag: 'a', text: '查看详情', href: link }]);
  return filtered;
}

module.exports = { assembleReviewRequest, assembleGenericMessage, parseImgTags, extractImgUrls };
