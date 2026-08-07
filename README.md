# feishu-notify-action

Post a rich-text message to a [Feishu (飞书) custom bot](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) webhook from GitHub Actions.

## Inputs

| Input     | Required | Description |
|-----------|----------|-------------|
| `webhook` | yes | Custom bot webhook URL (store in a secret) |
| `secret`  | no  | Bot signature secret, required only if signature verification is enabled |
| `title`   | no  | Rich-text title |
| `message` | no  | Rich-text body, one line per paragraph |
| `link`    | no  | URL appended as a "查看详情" hyperlink |
| `reviewer-map` | no | YAML map of GitHub login → Feishu open_id (`ou_...`), one entry per line, unlimited entries; on `pull_request` `review_requested` events the action composes a review-request card and @-mentions the reviewer this event assigned |

When the workflow runs on a `review_requested` event, `title` / `message` / `link` become optional overrides — the action derives them from the event payload (`requested_reviewer`, PR number/title/url, author). GitHub dispatches one `review_requested` event per requested reviewer, so each reviewer is mentioned exactly once. Reviewers missing from `reviewer-map` fall back to a plain-text `@login` line.

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
          reviewer-map: |
            # GitHub 登录名: 飞书 open_id
            octocat: ou_7d8a2f1c9b4e6a5d8c3f2e1a0b9c8d7e
            hubot: ou_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

`reviewer-map` 的值是飞书 **open_id**（`ou_` 前缀），可通过[通讯录 API](https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id) 用邮箱/手机号批量换取。映射不含敏感信息，直接写在 workflow 里即可。被 @ 的人需在群内才能收到提醒。

Signature verification follows the [official algorithm](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot): `base64(HMAC-SHA256)` over the empty payload with key `timestamp\nsecret`, added as `payload.timestamp` / `payload.sign`.

Webhook URL and secret should be stored in GitHub repository secrets, never in plaintext.