'use strict';

// Tool 层：GitHub 私有仓库 user-attachments 图片 -> 带签名的临时直链。
//
// 背景（2026-08 实测于私有仓库 2024-shiliuzi/zb）：
// - 私有仓库的 github.com/user-attachments/assets/<uuid> 匿名 GET 恒 404；
//   GitHub App installation token（即 Actions 的 GITHUB_TOKEN）直访同样 404，
//   只有用户态 PAT 直访有效（community#148227）。
// - 但任意能读该对象的 token（含 GITHUB_TOKEN）调 API 取 body_html
//   （Accept: application/vnd.github.full+json），其中 <img> src 是带 5 分钟
//   JWT 签名的 private-user-images URL，可匿名下载。
// 因此：签名 URL 短时有效，解析后必须立即下载转存（本 action 中即上传飞书）。

const ASSET_RE = /https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f-]{36})/gi;

// 从文本提取 user-attachments 资产 uuid（去重）。
function findAssetUuids(text) {
  return [...new Set([...text.matchAll(ASSET_RE)].map((m) => m[1]))];
}

// 在 body_html 中定位包含指定 uuid 的签名 URL（src 或 href），找不到返回 null。
function resolveSignedUrl(bodyHtml, uuid) {
  const re = new RegExp(`https://[^"'\\s]*${uuid}[^"'\\s]*`, 'i');
  const match = bodyHtml.match(re);
  return match ? match[0] : null;
}

// 调 GitHub API 取对象（issue / comment / review / PR）的 body_html。
// 需要 token 对该仓库有 issues:read / pull-requests:read。
async function fetchBodyHtml(apiUrl, githubToken, fetchImpl = fetch) {
  const res = await fetchImpl(apiUrl, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.full+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'feishu-notify-action',
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${apiUrl} for image resolution: HTTP ${res.status} ` +
        '(github-token needs issues:read / pull-requests:read on this repository)',
    );
  }
  const body = await res.json();
  return body.body_html || '';
}

// 从事件 JSON 推导承载图片的 API 对象 URL：
// issue_comment / pull_request_review_comment -> comment.url（payload 自带 API URL）；
// pull_request_review -> 由 repository.url + PR 号 + review.id 拼 reviews 端点；
// issues -> issue.url；pull_request -> pull_request.url。无法推导返回 null。
function resolveEventApiUrl(event) {
  if (event.comment && event.comment.url) return event.comment.url;
  if (event.review && event.pull_request && event.repository) {
    return `${event.repository.url}/pulls/${event.pull_request.number}/reviews/${event.review.id}`;
  }
  if (event.issue && event.issue.url) return event.issue.url;
  if (event.pull_request && event.pull_request.url) return event.pull_request.url;
  return null;
}

// 生成 URL 解析器：user-attachments URL -> body_html 签名 URL，其余原样返回。
// body_html 懒加载且只拉取一次；uuid 不在其中即抛错（不静默降级为 404 直链）。
function buildImageUrlResolver({ event, githubToken, fetchImpl }) {
  const apiUrl = resolveEventApiUrl(event);
  let bodyHtmlPromise = null;
  const loadBodyHtml = () => {
    if (!bodyHtmlPromise) bodyHtmlPromise = fetchBodyHtml(apiUrl, githubToken, fetchImpl);
    return bodyHtmlPromise;
  };
  return async (url) => {
    const [uuid] = findAssetUuids(url);
    if (!uuid || !apiUrl) return url;
    const signed = resolveSignedUrl(await loadBodyHtml(), uuid);
    if (!signed) {
      throw new Error(
        `image asset ${uuid} not found in body_html of ${apiUrl} — ` +
          'the image may belong to a different issue/PR/review than the event object',
      );
    }
    return signed;
  };
}

export { findAssetUuids, resolveSignedUrl, fetchBodyHtml, resolveEventApiUrl, buildImageUrlResolver };
