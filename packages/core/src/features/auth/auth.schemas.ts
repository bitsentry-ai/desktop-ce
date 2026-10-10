import { z } from "zod";

export const roleSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
});

export const statusSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
});

export const userSchema = z.object({
  id: z.union([z.number(), z.string()]),
  email: z.email().nullable(),
  provider: z.string(),
  socialId: z.string().nullable().optional(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  role: roleSchema.nullable().optional(),
  status: statusSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable().optional(),
  // 2FA and authentication fields
  totpEnabled: z.boolean().nullable().optional(),
  emailOtpEnabled: z.boolean().nullable().optional(),
  passkeyEnabled: z.boolean().nullable().optional(),
  lastLoginAt: z.date().nullable().optional(),
});

// Auth schemas
export const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.email().optional(),
  password: z.string().min(6).optional(),
  oldPassword: z.string().min(1).optional(),
});

export const loginResponseSchema = z.object({
  token: z.string(),
  refreshToken: z.string(),
  tokenExpires: z.number(),
  user: userSchema,
  rememberMeExpiryHours: z.number().optional(),
});

export const refreshResponseSchema = z.object({
  token: z.string(),
  refreshToken: z.string(),
  tokenExpires: z.number(),
});
