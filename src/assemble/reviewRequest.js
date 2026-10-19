'use strict';

import { renderString, renderElements } from './templates.js';
import feishuImage from '../tool/feishuImage.js';

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
    const openId = reviewerMap[reviewer.login];
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

// 装配层：pull_request edited 事件卡片。
// 默认只发【编辑后的最新内容】：卡片标题经 {{edit.summary}} 说明改了什么，
// 正文区是 PR 锚点 + 最新标题，正文变更时把最新正文段落追加进卡片（截断）。
// 不做 diff、默认不展示任何旧值；{{changes.title.from}} / {{changes.body.from}}
// 仍暴露给自定义模板，需要旧值对比的人自己组。
// 正文为 markdown 源码，按现有通用路径约定按行转纯文本，不做 markdown 渲染。
// edited 不 @ 任何人：编辑大多来自作者本人，@ 无意义。
// 自定义 edited-message-template 完全接管正文，新正文不再自动追加。

const DEFAULT_EDITED_TITLE_TEMPLATE = '✏️ PR #{{pr.number}} {{edit.summary}}';
const DEFAULT_EDITED_MESSAGE_TEMPLATE = '{{pr.anchor}} {{pr.title}}';

// 正文渲染上限：超过截断并提示看链接（飞书 post 消息有总大小限制，群里也不宜刷长文）。
const EDITED_BODY_MAX_CHARS = 3000;
const EDITED_BODY_TRIMMED_HINT = '……（正文过长已截断，点链接看全文）';

async function assemblePrEdited(event, templates, token = '', resolveUrl = (url) => url) {
  const pr = event.pull_request;
  const changes = event.changes;
  const titleChanged = changes.title !== undefined;
  const bodyChanged = changes.body !== undefined;
  const newBody = pr.body || '';

  const stringVars = {
    'pr.number': String(pr.number),
    'pr.title': pr.title,
    'pr.url': pr.html_url,
    author: pr.user.login,
    'changes.title.from': titleChanged ? changes.title.from : '',
    'changes.body.from': bodyChanged ? changes.body.from : '',
    'edit.summary': titleChanged && bodyChanged ? '标题和描述已更新' : titleChanged ? '标题已更新' : '描述已更新',
  };

  const resolvers = {
    ...Object.fromEntries(Object.entries(stringVars).map(([k, v]) => [k, () => [{ tag: 'text', text: v }]])),
    'pr.anchor': () => [{ tag: 'a', text: `PR #${pr.number}`, href: pr.html_url }],
  };

  const lines = renderElements(templates.message || DEFAULT_EDITED_MESSAGE_TEMPLATE, resolvers);

  // 默认模板下正文变更把新正文渲染进卡片：清空给提示，超长截断；
  // 逐行走 parseImgTags（与评论一致的图片链路，无 token 降级为链接）。
  // 不 @ 正文里的任何人（edited 语义，见文件头注释）。
  if (!templates.message && bodyChanged) {
    const trimmed = newBody.trim();
    if (!trimmed) {
      lines.push([{ tag: 'text', text: '描述已清空' }]);
    } else {
      const sliced = trimmed.length > EDITED_BODY_MAX_CHARS ? trimmed.slice(0, EDITED_BODY_MAX_CHARS) : trimmed;
      for (const line of sliced.split('\n')) {
        if (!line.trim()) continue;
        const els = await parseImgTags(line.trim(), token, resolveUrl);
        lines.push(els.length > 0 ? els : [{ tag: 'text', text: line.trim() }]);
      }
      if (trimmed.length > EDITED_BODY_MAX_CHARS) {
        lines.push([{ tag: 'text', text: EDITED_BODY_TRIMMED_HINT }]);
      }
    }
  }

  return {
    title: renderString(templates.title || DEFAULT_EDITED_TITLE_TEMPLATE, stringVars),
    lines,
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
// resolveUrl：下载前改写图片 URL（如 user-attachments -> API 签名直链，见 tool/githubImage）。
async function parseImgTags(text, token, resolveUrl = (url) => url) {
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
      const imageKey = await feishuImage.downloadAndUpload(await resolveUrl(url), token);
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

// GitHub @login 提及：@ 前不能紧跟词字符/句点/连字符（排除 email 等），login 遵循
// GitHub 命名规则（字母数字+连字符，连字符不开头/结尾，≤39 字符），后不接 /team
// （团队提及无法映射到个人，保持纯文本）。
const MENTION_RE = /(?<![A-Za-z0-9_.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?!\/[A-Za-z0-9-])/g;

// 把一段纯文本按 @login 提及切成 text/at 元素序列。
// mentionMap 为 undefined（mention 未启用）时原样返回；
// 未命中映射的 @login 留在文本里——通用路径解析的是评论正文等用户内容,
// @ 到未配置的人（bot、外部用户）不是配置错误，不应让通知失败。
// actor（事件触发者）永远不会被 @——你评论时 @ 你自己、你 approve 别人 PR 时
// @ 你，都会留在纯文本里，只 @ PR 作者。
function splitMentionElements(text, mentionMap, actor) {
  if (!mentionMap) return [{ tag: 'text', text }];
  const elements = [];
  let last = 0;
  const pushText = (end) => {
    if (end <= last) return;
    const slice = text.slice(last, end);
    const prev = elements[elements.length - 1];
    if (prev && prev.tag === 'text') prev.text += slice;
    else elements.push({ tag: 'text', text: slice });
  };
  for (const match of text.matchAll(MENTION_RE)) {
    const login = match[1];
    // 跳过事件触发者：不 @ 自己（评论人 / 评审人 / 合并人）
    if (actor && login === actor) continue;
    const openId = mentionMap[login];
    if (!openId) continue;
    pushText(match.index);
    elements.push({ tag: 'at', user_id: openId, user_name: login });
    last = match.index + match[0].length;
  }
  pushText(text.length);
  return elements;
}

// 通用路径：显式 message 一行一段，link 追加为 "查看详情" 超链接。
// message 中的 <img> 标签被解析为飞书 img 元素（需 token）或超链接（无 token 降级）。
// resolveUrl 透传给 parseImgTags，用于私有仓库图片的签名 URL 解析。
// mentionMap（enable-mention 开启时由入口传入）把文本里的 @GitHub登录名
// 转换为飞书 @ 元素；未命中映射的保持纯文本。
// actor（事件触发者）永远不被 @ —— 你评论 / approve 时不 @ 自己，只 @ PR 作者。
async function assembleGenericMessage(message, link, token, resolveUrl, mentionMap, actor) {
  const lines = await Promise.all(
    message
      .split('\n')
      .map(async (line) => {
        if (!line.trim()) return null;
        const els = await parseImgTags(line, token, resolveUrl);
        const base = els.length > 0 ? els : [{ tag: 'text', text: line }];
        return base.flatMap((el) => (el.tag === 'text' ? splitMentionElements(el.text, mentionMap, actor) : [el]));
      }),
  );
  const filtered = lines.filter(Boolean);
  if (link) filtered.push([{ tag: 'a', text: '查看详情', href: link }]);
  return filtered;
}

export {
  assembleReviewRequest,
  assemblePrEdited,
  assembleGenericMessage,
  splitMentionElements,
  parseImgTags,
  extractImgUrls,
};
