'use strict';

import { z } from 'zod';

// 校验层：全部输入/输出的 zod schema。
// 每层入口只做 zod parse，失败即抛（ZodError 由入口格式化为 ::error::）。

const openId = z.string().regex(/^ou_[0-9a-f]{32}$/, 'must be a Feishu open_id (ou_ + 32 hex chars)');

// ---- 输入 ----

const inputsSchema = z.object({
  webhook: z
    .string()
    .min(1, 'input "webhook" is required (secret FEISHU_WEBHOOK_URL not set?)')
    .regex(
      /^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/.+/,
      'must be a Feishu custom bot webhook URL',
    ),
  secret: z.string().default(''),
  title: z.string().default(''),
  message: z.string().default(''),
  link: z.string().default(''),
  reviewerMap: z.record(z.string().min(1, 'empty GitHub login'), openId).default({}),
  enableMention: z
    .enum(['true', 'false'], { message: 'must be the string "true" or "false"' })
    .default('false')
    .transform((v) => v === 'true'),
  titleTemplate: z.string().default(''),
  messageTemplate: z.string().default(''),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  githubToken: z.string().default(''),
});

// ---- GitHub 事件（只约束用到的字段，其余透传）----

const userSchema = z.object({ login: z.string().min(1) }).passthrough();

const reviewRequestedEventSchema = z
  .object({
    action: z.literal('review_requested'),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        title: z.string().default(''),
        html_url: z.string().url(),
        user: userSchema,
      })
      .passthrough(),
    requested_reviewer: userSchema.optional(),
    requested_team: z
      .object({ slug: z.string().default(''), name: z.string().default('') })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((e) => e.requested_reviewer || e.requested_team, {
    message: 'review_requested event without requested_reviewer/requested_team',
  });

// ---- 输出 payload ----

const elementSchema = z.discriminatedUnion('tag', [
  z.object({ tag: z.literal('text'), text: z.string().min(1) }),
  z.object({ tag: z.literal('a'), text: z.string().min(1), href: z.string().url() }),
  z.object({ tag: z.literal('at'), user_id: z.union([openId, z.literal('all')]), user_name: z.string().optional() }),
  z.object({ tag: z.literal('img'), image_key: z.string().min(1) }),
]);

const payloadSchema = z
  .object({
    msg_type: z.literal('post'),
    content: z.object({
      post: z.object({
        zh_cn: z.object({
          title: z.string().optional(),
          content: z.array(z.array(elementSchema).min(1)).min(1, 'message content is empty (nothing to send)'),
        }),
      }),
    }),
    timestamp: z.string().optional(),
    sign: z.string().optional(),
  })
  .strict();

function formatZodError(err) {
  return err.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function parseOrThrow(schema, data, what) {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${what} validation failed: ${formatZodError(result.error)}`);
  return result.data;
}

export { inputsSchema, reviewRequestedEventSchema, payloadSchema, parseOrThrow };
