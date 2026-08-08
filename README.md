# feishu-notify-action

Post a rich-text message to a [Feishu (飞书) custom bot](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) webhook from GitHub Actions.

## Inputs

| Input     | Required | Description |
|-----------|----------|-------------|
| `webhook` | yes | Custom bot webhook URL (store in a secret) |
| `secret`  | no  | Bot signature secret, required only if signature verification is enabled |
| `title`   | no  | Rich-text title (non-`review_requested` events) |
| `message` | no  | Rich-text body, one line per paragraph (non-`review_requested` events) |
| `link`    | no  | URL appended as a "查看详情" hyperlink (non-`review_requested` events) |
| `reviewer-map` | no | YAML map of GitHub login → Feishu open_id (`ou_...`), one entry per line, unlimited entries; required when `enable-mention` is on |
| `enable-mention` | no | `'true'` @-mentions the reviewer via `reviewer-map` (missing mapping **fails the step**); default `'false'` sends the card without any mention |
| `title-template` | no | Title template for `review_requested` events (see variables below) |
| `message-template` | no | Body template for `review_requested` events, one line per paragraph |
| `app-id` | no | Feishu app ID for image upload (enables inline image preview). Omit to fall back to image links |
| `app-secret` | no | Feishu app secret for image upload. Required when `app-id` is set |
| `github-token` | no | GitHub token to resolve **private-repo** `user-attachments` images via API `body_html` signed URLs. Pass `${{ secrets.GITHUB_TOKEN }}` (needs `issues:read` / `pull-requests:read`). Omit for public repos |

### Images in comments (`<img>` / `user-attachments`)

`message` 中出现 GitHub 粘贴图片（`<img src="https://github.com/user-attachments/assets/...">`）时的行为：

1. 有 `app-id`+`app-secret`：图片经 `tenant_access_token` 上传飞书换 `image_key`，以 `img` 元素内联展示；无飞书应用凭证时降级为「📷 图片」超链接。
2. **私有仓库**的 `user-attachments` URL 匿名/直连恒 404（`GITHUB_TOKEN` 直访也不行）。此时传 `github-token: ${{ secrets.GITHUB_TOKEN }}`，action 会从事件 JSON 推导 API 对象（comment → review → issue → PR），用 `Accept: application/vnd.github.full+json` 取 `body_html`，按资产 uuid 匹配出带 5 分钟 JWT 签名的 `private-user-images` 直链并立即下载转存。uuid 不在 `body_html` 中（图片属于其他对象）会报错失败，不静默降级。
3. workflow 需授予 `issues: read` 与 `pull-requests: read` 权限（见下方示例）。

```yaml
permissions:
  issues: read
  pull-requests: read
```

Two mutually exclusive modes: `review_requested` events are always composed from the templates and event payload (`title` / `message` / `link` are ignored there); every other event uses the explicit `title` / `message` / `link` inputs. GitHub dispatches one `review_requested` event per requested reviewer, so each reviewer is mentioned exactly once. There is no degraded-mention fallback: with `enable-mention: 'true'` an unmapped reviewer is a configuration error and fails loudly.

### Template variables

String variables (usable in both templates): `{{pr.number}}`, `{{pr.title}}`, `{{pr.url}}`, `{{author}}`, `{{reviewer}}`, `{{team}}`.

Element tokens (body only): `{{pr.anchor}}` renders a `PR #N` hyperlink, `{{mention}}` renders the @ mention (or plain-text fallback / team name).

Defaults:

```yaml
title-template: 请求代码评审：{{pr.title}}
message-template: |
  {{pr.anchor}} {{pr.title}}
  提交人：{{author}}
  {{mention}} 请抽空评审，谢谢
```

Unknown variables fail the step with the list of available ones — no silent blanks.

### Fail-loud validation

All inputs and the outgoing payload are validated with [zod](https://zod.dev); violations fail the step with a `::error::` annotation:

- `webhook` must match the Feishu custom-bot webhook URL shape
- `reviewer-map` entries must be valid open_ids (`ou_` + 32 hex chars); malformed lines throw
- `review_requested` events must carry a complete PR payload and a reviewer or team
- the outgoing post payload is structurally validated (text/a/at elements, non-empty content) before sending

## Usage

```yaml
- uses: z-ph/feishu-notify-action@v1
  with:
    webhook: ${{ secrets.FEISHU_WEBHOOK_URL }}
    secret: ${{ secrets.FEISHU_SECRET }}
    title: 🔔 新 PR #${{ github.event.pull_request.number }}
    message: |
      by @${{ github.event.pull_request.user.login }}
    link: ${{ github.event.pull_request.html_url }}
```

### PR 指定 reviewer 时 @ 对应飞书用户

```yaml
name: review-notify
on:
  pull_request:
    types: [review_requested]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: z-ph/feishu-notify-action@v1
        with:
          webhook: ${{ secrets.FEISHU_WEBHOOK_URL }}
          secret: ${{ secrets.FEISHU_SECRET }}
          enable-mention: 'true'
          reviewer-map: |
            # GitHub 登录名: 飞书 open_id
            octocat: ou_7d8a2f1c9b4e6a5d8c3f2e1a0b9c8d7e
            hubot: ou_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
          # 可选：自定义卡片文案
          title-template: '[评审] PR #{{pr.number}} {{pr.title}}'
          message-template: |
            {{mention}} 请评审 {{pr.anchor}}
            提交人：{{author}}
```

`reviewer-map` 的值是飞书 **open_id**（`ou_` 前缀），可通过[通讯录 API](https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id) 用邮箱/手机号批量换取。映射不含敏感信息，直接写在 workflow 或仓库 Variable 里即可。被 @ 的人需在群内才能收到提醒（[官方说明](https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN)：user_id 无效时仅显示名字，不产生 @ 效果）。

## Architecture

```
index.js            入口：读取输入 → 校验 → 组装 → 校验输出 → 发送
src/tool/           tool 层：飞书 webhook 签名/发送、飞书图片上传、GitHub 私有图片签名 URL 解析、扁平 YAML 解析
src/validate/       校验层：输入、事件、payload 的 zod schema
src/assemble/       装配层：{{token}} 模板引擎、review_requested 卡片组装、<img> 标签解析
```

Errors never degrade silently: validation failures throw with `::error::` and exit 1.

## Development

```bash
npm install    # 依赖：zod；dev：@vercel/ncc
npm test       # node:test 单元测试
npm run build  # 打包 dist/index.js（action.yml 指向它，改源码后必须重新打包）
```

Webhook URL and secret should be stored in GitHub repository secrets, never in plaintext.
