import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(128);
export const credentialKindSchema = z.enum(["plugin-auth", "http-auth", "ssh"]);

// Dashboard-only transport. These schemas do not confer authorization.
export const credentialBindingSchema = z.strictObject({
  actionId: identifierSchema,
  credentialId: identifierSchema,
  credentialGenerationId: identifierSchema,
  slot: identifierSchema,
  kind: credentialKindSchema,
});

export const credentialClaimIdentitySchema = z.strictObject({
  executionId: identifierSchema,
  runtimeId: identifierSchema,
  claimToken: identifierSchema,
  workerClaimGeneration: z.number().int().positive(),
});

export const credentialGrantRequestSchema =
  credentialClaimIdentitySchema.extend({
    actionId: identifierSchema,
    attemptNumber: z.number().int().positive(),
    slot: identifierSchema,
  });

// 32 random bytes encoded as unpadded base64url. Never place this in a URL.
const grantSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const credentialGrantResponseSchema = z.strictObject({
  grant: grantSchema,
  expiresAt: z.iso.datetime(),
});
export const credentialRedemptionRequestSchema = z.strictObject({
  grant: grantSchema,
});

const destinationUrlSchema = z.url().superRefine((value, ctx) => {
  if (!URL.canParse(value)) return; // The URL schema reports malformed input.
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Invalid credential destination URL",
    });
  }
});

// Persisted, backend-authorized policy; callers cannot widen it at redemption.
// DNS/address validation and redirect checks are enforced at connection time.
export const credentialExecutionPolicySchema = z.discriminatedUnion(
  "operation",
  [
    z.strictObject({
      operation: z.literal("plugin"),
      pluginId: identifierSchema,
      pluginActionId: identifierSchema,
      destinationUrls: z.array(destinationUrlSchema).min(1).max(16),
      allowPrivateNetwork: z.boolean(),
    }),
    z.strictObject({
      operation: z.literal("http"),
      url: destinationUrlSchema,
      method: z.enum([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
      ]),
      authentication: z.enum(["bearer", "basic", "header"]),
      headerName: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,64}$/)
        .optional(),
      allowPrivateNetwork: z.boolean(),
    }),
    z.strictObject({
      operation: z.literal("ssh"),
      connectionId: identifierSchema,
      hostname: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      username: z.string().min(1).max(128),
      hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
      allowPrivateNetwork: z.boolean(),
    }),
  ],
);

// One atomic bundle. Size is bounded in bytes by the broker before any write
// and again by the runner on receipt. This response is never a public API.
export const credentialRedemptionResponseSchema = z
  .strictObject({
    kind: credentialKindSchema,
    bundle: z.record(z.string().min(1).max(128), z.json()),
    generationId: identifierSchema,
    binding: credentialBindingSchema,
    policy: credentialExecutionPolicySchema,
    deadlineAt: z.iso.datetime(),
  })
  .superRefine((value, ctx) => {
    const expectedOperation = {
      "plugin-auth": "plugin",
      "http-auth": "http",
      ssh: "ssh",
    }[value.kind];
    if (
      value.binding.kind !== value.kind ||
      value.binding.credentialGenerationId !== value.generationId ||
      value.policy.operation !== expectedOperation
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Credential authorization metadata mismatch",
      });
    }
  });

export type CredentialKind = z.infer<typeof credentialKindSchema>;
export type CredentialBinding = z.infer<typeof credentialBindingSchema>;
export type CredentialClaimIdentity = z.infer<
  typeof credentialClaimIdentitySchema
>;
export type CredentialGrantRequest = z.infer<
  typeof credentialGrantRequestSchema
>;
export type CredentialGrantResponse = z.infer<
  typeof credentialGrantResponseSchema
>;
export type CredentialRedemptionRequest = z.infer<
  typeof credentialRedemptionRequestSchema
>;
export type CredentialRedemptionResponse = z.infer<
  typeof credentialRedemptionResponseSchema
>;
export type CredentialExecutionPolicy = z.infer<
  typeof credentialExecutionPolicySchema
>;
