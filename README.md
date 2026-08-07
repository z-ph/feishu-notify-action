# feishu-notify-action

Send a message to a [Feishu (飞书) custom bot](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) webhook from GitHub Actions.

## Inputs

| Input    | Required | Description |
|----------|----------|-------------|
| `webhook` | yes | Custom bot webhook URL (store in a secret) |
| `secret`  | no  | Bot signature secret, required only if signature verification is enabled |
| `payload` | yes | Full JSON message body, e.g. `{"msg_type":"text","content":{"text":"hi"}}` |

## Usage

```yaml
- uses: z-ph/feishu-notify-action@v1
  with:
    webhook: ${{ secrets.FEISHU_WEBHOOK_URL }}
    secret: ${{ secrets.FEISHU_SECRET }}
    payload: '{"msg_type":"text","content":{"text":"Build failed"}}'
```

Accepts any supported message type (`text`, `post`, `interactive`, ...). Signature verification follows the [official algorithm](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot): `base64(HMAC-SHA256).digest()` over the empty payload with key `timestamp\nsecret`, added as `payload.timestamp` / `payload.sign`.

Webhook URL and secret should be stored in GitHub repository secrets, never in plaintext.