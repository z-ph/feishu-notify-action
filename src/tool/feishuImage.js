'use strict';

// Tool 层：GitHub 图片 URL -> 飞书 image_key。
// 飞书 webhook 的 post img 元素只接受 image_key，不支持 URL 直显。
// 流程：下载图片 -> 用 tenant_access_token 上传飞书 -> 返回 image_key。

const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const IMAGE_UPLOAD_URL = 'https://open.feishu.cn/open-apis/im/v1/images';

async function getTenantAccessToken(appId, appSecret) {
  const res = await fetch(TENANT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await res.json();
  if (body.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${JSON.stringify(body)}`);
  }
  return body.tenant_access_token;
}

async function uploadImage(token, imageBuffer) {
  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', new Blob([imageBuffer]), 'image.png');

  const res = await fetch(IMAGE_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json();
  if (body.code !== 0) {
    throw new Error(`Failed to upload image to Feishu: ${JSON.stringify(body)}`);
  }
  return body.data.image_key;
}

// 下载图片 URL -> 上传飞书 -> 返回 image_key。
// 下载或上传失败直接抛错，不做兜底。
async function downloadAndUpload(imageUrl, token) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to download image ${imageUrl}: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadImage(token, buffer);
}

module.exports = { getTenantAccessToken, uploadImage, downloadAndUpload };
