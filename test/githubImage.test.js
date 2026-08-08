'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findAssetUuids,
  resolveSignedUrl,
  fetchBodyHtml,
  resolveEventApiUrl,
  buildImageUrlResolver,
} from '../src/tool/githubImage.js';
import { parseImgTags, assembleGenericMessage } from '../src/assemble/reviewRequest.js';
import { inputsSchema, payloadSchema, parseOrThrow } from '../src/validate/schemas.js';
import feishuImage from '../src/tool/feishuImage.js';

const UUID = 'b83ae07d-7e66-4b7e-bd59-caf54a81d4d8';
const UUID_2 = '662b67ca-0d7b-4f8a-9e6f-503a25eb77a0';
const ASSET_URL = `https://github.com/user-attachments/assets/${UUID}`;
const SIGNED_URL = `https://private-user-images.githubusercontent.com/112166208/632699832-${UUID}.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.fake-signature`;
const BODY_HTML = `<a target="_blank" rel="noopener noreferrer" href="${SIGNED_URL}"><img src="${SIGNED_URL}" alt="Image"/></a>`;
const GH_IMG_TAG = `<img width="2828" height="1496" alt="Image" src="${ASSET_URL}" />`;

// ---- findAssetUuids ----

test('uuid: extracts unique asset uuids from text', () => {
  assert.deepEqual(findAssetUuids(`a ${ASSET_URL} b ${ASSET_URL}`), [UUID]);
  assert.deepEqual(
    findAssetUuids(`${ASSET_URL} and https://github.com/user-attachments/assets/${UUID_2}`),
    [UUID, UUID_2],
  );
  assert.deepEqual(findAssetUuids('普通文本 https://example.com/x.png'), []);
});

// ---- resolveSignedUrl ----

test('signed: finds URL containing the uuid in body_html, null when absent', () => {
  assert.equal(resolveSignedUrl(BODY_HTML, UUID), SIGNED_URL);
  assert.equal(resolveSignedUrl(BODY_HTML, UUID_2), null);
  assert.equal(resolveSignedUrl('', UUID), null);
});

// ---- resolveEventApiUrl ----

test('event url: comment.url wins for issue_comment and review_comment events', () => {
  const url = 'https://api.github.com/repos/o/r/issues/comments/1';
  assert.equal(resolveEventApiUrl({ comment: { url }, issue: { url: 'https://x/issue' } }), url);
});

test('event url: review event constructs the pulls reviews endpoint', () => {
  const event = {
    review: { id: 4885451938 },
    pull_request: { number: 46, url: 'https://api.github.com/repos/o/r/pulls/46' },
    repository: { url: 'https://api.github.com/repos/o/r' },
  };
  assert.equal(resolveEventApiUrl(event), 'https://api.github.com/repos/o/r/pulls/46/reviews/4885451938');
});

test('event url: falls back to issue.url then pull_request.url, null otherwise', () => {
  assert.equal(resolveEventApiUrl({ issue: { url: 'https://api.github.com/repos/o/r/issues/28' } }), 'https://api.github.com/repos/o/r/issues/28');
  assert.equal(resolveEventApiUrl({ pull_request: { url: 'https://api.github.com/repos/o/r/pulls/9' } }), 'https://api.github.com/repos/o/r/pulls/9');
  assert.equal(resolveEventApiUrl({ action: 'opened' }), null);
});

// ---- fetchBodyHtml ----

test('body_html: sends bearer token and full+json accept header', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ body_html: BODY_HTML }) };
  };
  const html = await fetchBodyHtml('https://api.github.com/repos/o/r/issues/28', 'ghs_token', fetchImpl);
  assert.equal(html, BODY_HTML);
  assert.equal(seen.opts.headers.Authorization, 'Bearer ghs_token');
  assert.equal(seen.opts.headers.Accept, 'application/vnd.github.full+json');
});

test('body_html: HTTP failure throws with status and permission hint', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    () => fetchBodyHtml('https://api.github.com/repos/o/r/issues/28', 'ghs_token', fetchImpl),
    /HTTP 403.*issues:read/,
  );
});

// ---- buildImageUrlResolver ----

function resolverWith(html, event = { comment: { url: 'https://api.github.com/repos/o/r/issues/comments/1' } }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ body_html: html }) };
  };
  return { resolve: buildImageUrlResolver({ event, githubToken: 'ghs_token', fetchImpl }), calls };
}

test('resolver: maps user-attachments URL to signed URL', async () => {
  const { resolve } = resolverWith(BODY_HTML);
  assert.equal(await resolve(ASSET_URL), SIGNED_URL);
});

test('resolver: passes through non-attachment URLs without fetching', async () => {
  const { resolve, calls } = resolverWith(BODY_HTML);
  assert.equal(await resolve('https://example.com/x.png'), 'https://example.com/x.png');
  assert.equal(calls.length, 0);
});

test('resolver: passes through when event object is not derivable', async () => {
  const { resolve, calls } = resolverWith(BODY_HTML, { action: 'opened' });
  assert.equal(await resolve(ASSET_URL), ASSET_URL);
  assert.equal(calls.length, 0);
});

test('resolver: fetches body_html once for multiple images', async () => {
  const html = `${BODY_HTML}<img src="https://private-user-images.githubusercontent.com/1/x-${UUID_2}.png?jwt=J2" />`;
  const { resolve, calls } = resolverWith(html);
  const [a, b] = await Promise.all([resolve(ASSET_URL), resolve(`https://github.com/user-attachments/assets/${UUID_2}`)]);
  assert.equal(a, SIGNED_URL);
  assert.equal(b, 'https://private-user-images.githubusercontent.com/1/x-662b67ca-0d7b-4f8a-9e6f-503a25eb77a0.png?jwt=J2');
  assert.equal(calls.length, 1);
});

test('resolver: uuid missing from body_html throws, never degrades to 404 link', async () => {
  const { resolve } = resolverWith('<p>no images here</p>');
  await assert.rejects(() => resolve(ASSET_URL), new RegExp(`${UUID} not found in body_html`));
});

// ---- 与装配层集成：resolveUrl 在下载前生效 ----

const origDownloadAndUpload = feishuImage.downloadAndUpload;

test('integr: parseImgTags resolves URL before downloadAndUpload', async () => {
  let downloadedUrl;
  feishuImage.downloadAndUpload = async (url) => {
    downloadedUrl = url;
    return 'img_v3_mock_key';
  };
  try {
    const els = await parseImgTags(GH_IMG_TAG, 'feishu-token', async () => SIGNED_URL);
    assert.deepEqual(els, [{ tag: 'img', image_key: 'img_v3_mock_key' }]);
    assert.equal(downloadedUrl, SIGNED_URL);
  } finally {
    feishuImage.downloadAndUpload = origDownloadAndUpload;
  }
});

test('integr: assembleGenericMessage with resolver produces valid payload', async () => {
  feishuImage.downloadAndUpload = async () => 'img_v3_mock_key';
  try {
    const { resolve } = resolverWith(BODY_HTML);
    const lines = await assembleGenericMessage(`评论内容\n${GH_IMG_TAG}`, 'https://x/1', 'feishu-token', resolve);
    assert.deepEqual(lines[1], [{ tag: 'img', image_key: 'img_v3_mock_key' }]);
    parseOrThrow(payloadSchema, { msg_type: 'post', content: { post: { zh_cn: { content: lines } } } }, 'payload');
  } finally {
    feishuImage.downloadAndUpload = origDownloadAndUpload;
  }
});

// ---- 无 resolver 时私有附件 404 的可行动错误 ----

test('download: 404 on user-attachments hints at github-token input', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    await assert.rejects(() => origDownloadAndUpload.call(null, ASSET_URL, 'feishu-token'), /github-token/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---- inputs schema ----

test('inputs: githubToken defaults to empty string', () => {
  const inputs = parseOrThrow(
    inputsSchema,
    { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' },
    'inputs',
  );
  assert.equal(inputs.githubToken, '');
});
