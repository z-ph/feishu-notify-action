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

Signature verification follows the [official algorithm](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot): `base64(HMAC-SHA256)` over the empty payload with key `timestamp\nsecret`, added as `payload.timestamp` / `payload.sign`.

Webhook URL and secret should be stored in GitHub repository secrets, never in plaintext.